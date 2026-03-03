import hashlib
import io
import subprocess
import tarfile
from pathlib import Path

import pytest

from app.core.config import Settings
from app.services import backup_service


def _make_settings(tmp_path: Path) -> Settings:
    return Settings(
        backup_root=str(tmp_path / "backup"),
        backup_config_root=str(tmp_path / "config"),
        storage_disk_root=str(tmp_path / "storage"),
        database_url="postgresql+psycopg://archive:archive_pw@localhost:5432/archive",
    )


def _write_file_and_meta(path: Path, meta: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"test-backup-data")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    merged = {"sha256": digest, **meta}
    meta_lines = [f"{k}={v}" for k, v in merged.items()]
    Path(f"{path}.meta").write_text("\n".join(meta_lines) + "\n", encoding="utf-8")


def _read_meta(path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", maxsplit=1)
        rows[key] = value
    return rows


def test_store_uploaded_backup_db_writes_meta_and_sanitizes_name(tmp_path: Path):
    settings = _make_settings(tmp_path)
    stream = io.BytesIO(b"uploaded-db-backup")

    created = backup_service.store_uploaded_backup(
        settings,
        kind="db",
        upload_filename="../danger name.dump",
        upload_stream=stream,
    )

    assert created.kind == "db"
    assert created.filename.startswith("upload_db_")
    assert created.filename.endswith(".dump")
    assert "danger_name.dump" in created.filename
    out_path = Path(settings.backup_root) / "db" / created.filename
    assert out_path.exists()

    meta = _read_meta(Path(f"{out_path}.meta"))
    assert meta["kind"] == "db"
    assert meta["format"] == "archive-backup-v1"
    assert meta["uploaded_from"] == "danger_name.dump"
    assert meta["sha256"] == created.sha256


def test_store_uploaded_backup_objects_accepts_tgz_and_is_listable(tmp_path: Path):
    settings = _make_settings(tmp_path)

    created = backup_service.store_uploaded_backup(
        settings,
        kind="objects",
        upload_filename="objects_snapshot_20260303.tgz",
        upload_stream=io.BytesIO(b"fake-objects-archive"),
    )

    assert created.kind == "objects"
    assert created.filename.endswith(".tar.gz")
    rows = backup_service.list_backup_files(settings, "objects", limit=10)
    assert [row.filename for row in rows] == [created.filename]

    meta = _read_meta(Path(settings.backup_root) / "objects" / f"{created.filename}.meta")
    assert meta["kind"] == "objects"
    assert meta["objects_layout"] == "object-keys-v1"


@pytest.mark.parametrize(
    ("kind", "upload_name"),
    [
        ("db", "archive.sql"),
        ("objects", "objects.zip"),
        ("config", "config.json"),
    ],
)
def test_store_uploaded_backup_rejects_invalid_extension(tmp_path: Path, kind: str, upload_name: str):
    settings = _make_settings(tmp_path)
    with pytest.raises(ValueError):
        backup_service.store_uploaded_backup(
            settings,
            kind=kind,  # type: ignore[arg-type]
            upload_filename=upload_name,
            upload_stream=io.BytesIO(b"abc"),
        )


def test_store_uploaded_backup_rejects_empty_file(tmp_path: Path):
    settings = _make_settings(tmp_path)
    with pytest.raises(ValueError, match="empty"):
        backup_service.store_uploaded_backup(
            settings,
            kind="db",
            upload_filename="archive.dump",
            upload_stream=io.BytesIO(b""),
        )


def test_list_backup_files_filters_unsupported_object_archives(tmp_path: Path):
    settings = _make_settings(tmp_path)
    objects_dir = Path(settings.backup_root) / "objects"
    valid_path = objects_dir / "objects_minio_20260303_000001.tar.gz"
    invalid_path = objects_dir / "objects_snapshot_minio_20260303_000002.tar.gz"

    _write_file_and_meta(
        valid_path,
        {
            "kind": "objects",
            "storage_backend": "minio",
            "bucket": "archive",
        },
    )
    _write_file_and_meta(
        invalid_path,
        {
            "kind": "objects_snapshot",
            "format": "volume-snapshot-v1",
        },
    )

    rows = backup_service.list_backup_files(settings, "objects", limit=10)
    assert len(rows) == 1
    assert rows[0].filename == valid_path.name


def test_restore_objects_backup_rejects_unsupported_format(tmp_path: Path):
    settings = _make_settings(tmp_path)
    objects_dir = Path(settings.backup_root) / "objects"
    archive_path = objects_dir / "objects_snapshot_minio_20260303_000003.tar.gz"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz"):
        pass
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    Path(f"{archive_path}.meta").write_text(
        "\n".join(
            [
                "kind=objects_snapshot",
                "format=volume-snapshot-v1",
                f"sha256={digest}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="unsupported objects backup format"):
        backup_service.restore_objects_backup(settings, filename=archive_path.name, replace_existing=True)


def test_restore_objects_backup_rejects_invalid_archive_payload(tmp_path: Path):
    settings = _make_settings(tmp_path)
    settings.storage_backend = "disk"
    archive_path = Path(settings.backup_root) / "objects" / "objects_minio_20260303_120001.tar.gz"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path.write_bytes(b"not-a-tar-gzip")
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    Path(f"{archive_path}.meta").write_text(
        "\n".join(
            [
                "kind=objects",
                "format=archive-backup-v1",
                "objects_layout=object-keys-v1",
                "storage_backend=disk",
                "bucket=archive",
                f"sha256={digest}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="invalid objects backup archive"):
        backup_service.restore_objects_backup(settings, filename=archive_path.name, replace_existing=True)


def test_restore_config_backup_rejects_invalid_archive_payload(tmp_path: Path):
    settings = _make_settings(tmp_path)
    archive_path = Path(settings.backup_root) / "config" / "config_20260303_120001.tar.gz"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path.write_bytes(b"invalid-config-archive")
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    Path(f"{archive_path}.meta").write_text(
        "\n".join(
            [
                "kind=config",
                "format=archive-backup-v1",
                f"sha256={digest}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="invalid config backup archive"):
        backup_service.restore_config_backup(settings, filename=archive_path.name, mode="preview")


def test_restore_db_backup_quotes_hyphenated_db_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings = _make_settings(tmp_path)
    db_dir = Path(settings.backup_root) / "db"
    backup_path = db_dir / "archive_archive_20260303_000004.dump"
    _write_file_and_meta(backup_path, {"kind": "db"})

    monkeypatch.setattr(
        backup_service,
        "_db_connection_params",
        lambda _settings: {
            "host": "localhost",
            "port": "5432",
            "user": "archive",
            "password": "archive_pw",
            "database": "archive",
        },
    )

    commands: list[list[str]] = []

    def _fake_run(cmd, check, stderr, env):  # type: ignore[no-untyped-def]
        commands.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(subprocess, "run", _fake_run)

    target = backup_service.restore_db_backup(settings, filename=backup_path.name, target_db="archive-restore-web")
    assert target == "archive-restore-web"
    assert len(commands) == 2
    admin_cmd = commands[0]
    assert 'DROP DATABASE IF EXISTS "archive-restore-web";' in admin_cmd
    assert 'CREATE DATABASE "archive-restore-web";' in admin_cmd


def test_restore_db_backup_fallback_for_transaction_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings = _make_settings(tmp_path)
    db_dir = Path(settings.backup_root) / "db"
    backup_path = db_dir / "archive_archive_20260303_000005.dump"
    _write_file_and_meta(backup_path, {"kind": "db"})

    monkeypatch.setattr(
        backup_service,
        "_db_connection_params",
        lambda _settings: {
            "host": "localhost",
            "port": "5432",
            "user": "archive",
            "password": "archive_pw",
            "database": "archive",
        },
    )

    run_calls: list[list[str]] = []

    def _fake_run(cmd, check, stderr, env):  # type: ignore[no-untyped-def]
        run_calls.append(cmd)
        if cmd and cmd[0] == "pg_restore":
            raise subprocess.CalledProcessError(
                returncode=1,
                cmd=cmd,
                stderr=b'pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"',
            )
        return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(subprocess, "run", _fake_run)

    class _Sink:
        def __init__(self):
            self.data = bytearray()

        def write(self, b: bytes) -> int:
            self.data.extend(b)
            return len(b)

        def close(self) -> None:
            return None

    class _FakeProc:
        def __init__(self, *, stdout_bytes: bytes = b"", stderr_bytes: bytes = b"", sink: _Sink | None = None):
            self.stdout = io.BytesIO(stdout_bytes) if stdout_bytes else None
            self.stderr = io.BytesIO(stderr_bytes)
            self.stdin = sink

        def wait(self) -> int:
            return 0

    psql_sink = _Sink()

    def _fake_popen(cmd, stdout=None, stderr=None, stdin=None, env=None):  # type: ignore[no-untyped-def]
        if cmd and cmd[0] == "pg_restore":
            return _FakeProc(
                stdout_bytes=b"SET transaction_timeout = 0;\nCREATE TABLE test_fallback (id int);\n",
                stderr_bytes=b"",
            )
        return _FakeProc(stderr_bytes=b"", sink=psql_sink)

    monkeypatch.setattr(subprocess, "Popen", _fake_popen)

    target = backup_service.restore_db_backup(settings, filename=backup_path.name, target_db="archive_restore")
    assert target == "archive_restore"
    assert any(cmd and cmd[0] == "pg_restore" for cmd in run_calls)
    text = psql_sink.data.decode("utf-8", errors="ignore")
    assert "SET transaction_timeout = 0;" not in text
    assert "CREATE TABLE test_fallback (id int);" in text
