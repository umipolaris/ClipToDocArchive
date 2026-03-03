"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Download, HardDrive, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPostForm, buildApiUrl } from "@/lib/api-client";

type BackupKind = "db" | "objects" | "config";
type ConfigRestoreMode = "preview" | "apply";

type BackupFileItem = {
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  created_at: string;
  sha256: string | null;
  download_url: string;
};

type BackupFilesResponse = {
  kind: BackupKind;
  items: BackupFileItem[];
};

type BackupRunResponse = {
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  created_at: string;
  sha256: string | null;
};

type BackupRunAllResponse = {
  items: BackupRunResponse[];
};

type BackupDeleteResponse = {
  status: string;
  kind: BackupKind;
  filename: string;
  meta_deleted: boolean;
};

type BackupRestoreDbResponse = {
  status: string;
  filename: string;
  target_db: string;
};

type BackupRestoreObjectsResponse = {
  status: string;
  filename: string;
  restored_count: number;
  replace_existing: boolean;
};

type BackupRestoreConfigResponse = {
  status: string;
  filename: string;
  mode: ConfigRestoreMode;
  total_files: number;
  files: string[];
};

function formatDateTime(value: string): string {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const KIND_LABEL: Record<BackupKind, string> = {
  db: "DB",
  objects: "첨부파일",
  config: "설정",
};

export function AdminBackupManager() {
  const [filesByKind, setFilesByKind] = useState<Record<BackupKind, BackupFileItem[]>>({
    db: [],
    objects: [],
    config: [],
  });
  const [loadingByKind, setLoadingByKind] = useState<Record<BackupKind, boolean>>({
    db: false,
    objects: false,
    config: false,
  });
  const [running, setRunning] = useState<string>("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [dbFilename, setDbFilename] = useState("");
  const [dbTarget, setDbTarget] = useState("archive_restore");
  const [dbConfirm, setDbConfirm] = useState(false);
  const [dbUploadFile, setDbUploadFile] = useState<File | null>(null);
  const [dbUploadInputKey, setDbUploadInputKey] = useState(0);

  const [objectsFilename, setObjectsFilename] = useState("");
  const [objectsReplaceExisting, setObjectsReplaceExisting] = useState(true);
  const [objectsConfirm, setObjectsConfirm] = useState(false);
  const [objectsUploadFile, setObjectsUploadFile] = useState<File | null>(null);
  const [objectsUploadInputKey, setObjectsUploadInputKey] = useState(0);

  const [configFilename, setConfigFilename] = useState("");
  const [configMode, setConfigMode] = useState<ConfigRestoreMode>("preview");
  const [configConfirm, setConfigConfirm] = useState(false);
  const [configUploadFile, setConfigUploadFile] = useState<File | null>(null);
  const [configUploadInputKey, setConfigUploadInputKey] = useState(0);
  const [configPreviewFiles, setConfigPreviewFiles] = useState<string[]>([]);
  const [configPreviewTotal, setConfigPreviewTotal] = useState(0);

  const loadKind = useCallback(async (kind: BackupKind) => {
    setLoadingByKind((prev) => ({ ...prev, [kind]: true }));
    try {
      const res = await apiGet<BackupFilesResponse>(`/admin/backups/files?kind=${kind}`);
      setFilesByKind((prev) => ({ ...prev, [kind]: res.items || [] }));
    } finally {
      setLoadingByKind((prev) => ({ ...prev, [kind]: false }));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadKind("db"), loadKind("objects"), loadKind("config")]);
  }, [loadKind]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!dbFilename) setDbFilename(filesByKind.db[0]?.filename ?? "");
  }, [dbFilename, filesByKind.db]);

  useEffect(() => {
    if (!objectsFilename) setObjectsFilename(filesByKind.objects[0]?.filename ?? "");
  }, [filesByKind.objects, objectsFilename]);

  useEffect(() => {
    if (!configFilename) setConfigFilename(filesByKind.config[0]?.filename ?? "");
  }, [configFilename, filesByKind.config]);

  const runBackup = async (kind: BackupKind) => {
    setRunning(kind);
    setError("");
    setMessage("");
    try {
      const res = await apiPost<BackupRunResponse>(`/admin/backups/run/${kind}`, {});
      setMessage(`${KIND_LABEL[kind]} 백업 완료: ${res.filename}`);
      await loadKind(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${KIND_LABEL[kind]} 백업 실패`);
    } finally {
      setRunning("");
    }
  };

  const runBackupAll = async () => {
    setRunning("all");
    setError("");
    setMessage("");
    try {
      const res = await apiPost<BackupRunAllResponse>("/admin/backups/run-all", {});
      setMessage(`전체 백업 완료: ${res.items.map((x) => `${KIND_LABEL[x.kind]}(${x.filename})`).join(", ")}`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "전체 백업 실패");
    } finally {
      setRunning("");
    }
  };

  const deleteBackupFile = async (kind: BackupKind, filename: string) => {
    const confirmed = window.confirm(`백업 파일을 삭제할까요?\n${filename}`);
    if (!confirmed) return;

    setRunning(`delete-${kind}`);
    setError("");
    setMessage("");
    try {
      const res = await apiDelete<BackupDeleteResponse>(`/admin/backups/files/${kind}/${encodeURIComponent(filename)}`);
      setMessage(`백업 삭제 완료: ${res.filename}`);
      await loadKind(kind);
      if (kind === "db" && dbFilename === filename) {
        setDbFilename("");
      }
      if (kind === "objects" && objectsFilename === filename) {
        setObjectsFilename("");
      }
      if (kind === "config" && configFilename === filename) {
        setConfigFilename("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "백업 파일 삭제 실패");
    } finally {
      setRunning("");
    }
  };

  const restoreDb = async () => {
    setRunning("restore-db");
    setError("");
    setMessage("");
    try {
      const res = await apiPost<BackupRestoreDbResponse>("/admin/backups/restore/db", {
        filename: dbFilename,
        target_db: dbTarget.trim(),
        confirm: dbConfirm,
      });
      setMessage(`DB 복구 완료: ${res.filename} -> ${res.target_db}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "DB 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreDb = async () => {
    if (!dbUploadFile) {
      setError("업로드할 DB 백업 파일(.dump)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-db");
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", dbUploadFile);
      form.append("target_db", dbTarget.trim());
      form.append("confirm", String(dbConfirm));
      const res = await apiPostForm<BackupRestoreDbResponse>("/admin/backups/upload-and-restore/db", form);
      setMessage(`DB 업로드 복구 완료: ${res.filename} -> ${res.target_db}`);
      setDbFilename(res.filename);
      setDbUploadFile(null);
      setDbUploadInputKey((prev) => prev + 1);
      await loadKind("db");
    } catch (err) {
      setError(err instanceof Error ? err.message : "DB 업로드 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const restoreObjects = async () => {
    setRunning("restore-objects");
    setError("");
    setMessage("");
    try {
      const res = await apiPost<BackupRestoreObjectsResponse>("/admin/backups/restore/objects", {
        filename: objectsFilename,
        replace_existing: objectsReplaceExisting,
        confirm: objectsConfirm,
      });
      setMessage(`첨부 복구 완료: ${res.restored_count}개 복원됨`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "첨부 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreObjects = async () => {
    if (!objectsUploadFile) {
      setError("업로드할 첨부 백업 파일(.tar.gz)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-objects");
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", objectsUploadFile);
      form.append("replace_existing", String(objectsReplaceExisting));
      form.append("confirm", String(objectsConfirm));
      const res = await apiPostForm<BackupRestoreObjectsResponse>("/admin/backups/upload-and-restore/objects", form);
      setMessage(`첨부 업로드 복구 완료: ${res.restored_count}개 복원됨`);
      setObjectsFilename(res.filename);
      setObjectsUploadFile(null);
      setObjectsUploadInputKey((prev) => prev + 1);
      await loadKind("objects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "첨부 업로드 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const restoreConfig = async () => {
    setRunning("restore-config");
    setError("");
    setMessage("");
    setConfigPreviewFiles([]);
    setConfigPreviewTotal(0);
    try {
      const res = await apiPost<BackupRestoreConfigResponse>("/admin/backups/restore/config", {
        filename: configFilename,
        mode: configMode,
        confirm: configConfirm,
      });
      setMessage(
        configMode === "preview"
          ? `설정 미리보기 완료: ${res.total_files}개`
          : `설정 적용 완료: ${res.total_files}개`,
      );
      setConfigPreviewFiles(res.files ?? []);
      setConfigPreviewTotal(res.total_files ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "설정 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreConfig = async () => {
    if (!configUploadFile) {
      setError("업로드할 설정 백업 파일(.tar.gz)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-config");
    setError("");
    setMessage("");
    setConfigPreviewFiles([]);
    setConfigPreviewTotal(0);
    try {
      const form = new FormData();
      form.append("file", configUploadFile);
      form.append("mode", configMode);
      form.append("confirm", String(configConfirm));
      const res = await apiPostForm<BackupRestoreConfigResponse>("/admin/backups/upload-and-restore/config", form);
      setMessage(
        configMode === "preview"
          ? `설정 업로드 미리보기 완료: ${res.total_files}개`
          : `설정 업로드 적용 완료: ${res.total_files}개`,
      );
      setConfigPreviewFiles(res.files ?? []);
      setConfigPreviewTotal(res.total_files ?? 0);
      setConfigFilename(res.filename);
      setConfigUploadFile(null);
      setConfigUploadInputKey((prev) => prev + 1);
      await loadKind("config");
    } catch (err) {
      setError(err instanceof Error ? err.message : "설정 업로드 복구 실패");
    } finally {
      setRunning("");
    }
  };

  const backupSections = useMemo(
    () =>
      (["db", "objects", "config"] as BackupKind[]).map((kind) => ({
        kind,
        label: KIND_LABEL[kind],
        items: filesByKind[kind],
        loading: loadingByKind[kind],
      })),
    [filesByKind, loadingByKind],
  );

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("db")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            DB 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("objects")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            첨부 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("config")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            설정 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-2 text-xs hover:bg-stone-50 disabled:opacity-60"
            onClick={() => void runBackupAll()}
            disabled={running !== ""}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            전체 백업
          </button>
          <button
            className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-2 text-xs hover:bg-stone-50 disabled:opacity-60"
            onClick={() => void refreshAll()}
            disabled={running !== ""}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            목록 새로고침
          </button>
        </div>
        <p className="text-xs text-stone-500">대용량 백업은 시간이 오래 걸릴 수 있습니다.</p>
      </article>

      {message ? <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <h3 className="mb-2 text-sm font-semibold">백업 파일 목록</h3>
        <div className="grid gap-3 lg:grid-cols-3">
          {backupSections.map((section) => (
            <div key={section.kind} className="rounded border border-stone-200">
              <div className="flex items-center justify-between border-b border-stone-200 px-2 py-1.5 text-xs font-semibold">
                <span>{section.label}</span>
                <span>{section.items.length}건</span>
              </div>
              <div className="max-h-52 overflow-y-auto p-2">
                {section.loading ? <p className="text-xs text-stone-500">로딩 중...</p> : null}
                {!section.loading && section.items.length === 0 ? <p className="text-xs text-stone-500">백업 파일 없음</p> : null}
                <ul className="space-y-1 text-xs">
                  {section.items.map((item) => (
                    <li key={`${item.kind}-${item.filename}`} className="rounded border border-stone-100 bg-stone-50 p-1.5">
                      <p className="truncate font-medium text-stone-800" title={item.filename}>
                        {item.filename}
                      </p>
                      <p className="text-[11px] text-stone-500">
                        {formatBytes(item.size_bytes)} · {formatDateTime(item.created_at)}
                      </p>
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent underline"
                        href={buildApiUrl(item.download_url)}
                      >
                        <Download className="h-3 w-3" />
                        다운로드
                      </a>
                      <button
                        className="ml-2 mt-1 inline-flex items-center gap-1 rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-60"
                        type="button"
                        onClick={() => void deleteBackupFile(item.kind, item.filename)}
                        disabled={running !== ""}
                      >
                        <Trash2 className="h-3 w-3" />
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <h3 className="mb-2 text-sm font-semibold">복구(import)</h3>
        <div className="space-y-4">
          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">DB 복구 (별도 대상 DB)</p>
            <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={dbFilename} onChange={(e) => setDbFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.db.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <input
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                placeholder="target_db"
                value={dbTarget}
                onChange={(e) => setDbTarget(e.target.value)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreDb()}
                disabled={running !== "" || !dbFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                DB 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={dbUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                accept=".dump"
                onChange={(e) => setDbUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreDb()}
                disabled={running !== "" || !dbUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <label className="mt-2 inline-flex items-center gap-1 text-[11px] text-stone-700">
              <input type="checkbox" checked={dbConfirm} onChange={(e) => setDbConfirm(e.target.checked)} />
              위험 작업 확인 (confirm)
            </label>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">첨부파일 복구</p>
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={objectsFilename} onChange={(e) => setObjectsFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.objects.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreObjects()}
                disabled={running !== "" || !objectsFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                첨부 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={objectsUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                onChange={(e) => setObjectsUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreObjects()}
                disabled={running !== "" || !objectsUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <p className="mt-1 text-[11px] text-stone-500">지원 형식: `.tar.gz`, `.tgz`</p>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-stone-700">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={objectsReplaceExisting} onChange={(e) => setObjectsReplaceExisting(e.target.checked)} />
                기존 첨부 전체 교체
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={objectsConfirm} onChange={(e) => setObjectsConfirm(e.target.checked)} />
                위험 작업 확인 (confirm)
              </label>
            </div>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">설정 복구</p>
            <div className="grid gap-2 md:grid-cols-[1fr_120px_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={configFilename} onChange={(e) => setConfigFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.config.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={configMode} onChange={(e) => setConfigMode(e.target.value as ConfigRestoreMode)}>
                <option value="preview">preview</option>
                <option value="apply">apply</option>
              </select>
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreConfig()}
                disabled={running !== "" || !configFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                설정 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={configUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                onChange={(e) => setConfigUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreConfig()}
                disabled={running !== "" || !configUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <p className="mt-1 text-[11px] text-stone-500">지원 형식: `.tar.gz`, `.tgz`</p>
            <label className="mt-2 inline-flex items-center gap-1 text-[11px] text-stone-700">
              <input type="checkbox" checked={configConfirm} onChange={(e) => setConfigConfirm(e.target.checked)} />
              apply 모드 위험 작업 확인 (confirm)
            </label>
            {configPreviewTotal > 0 ? (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                <p className="inline-flex items-center gap-1 font-semibold">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  복구 대상 파일 {configPreviewTotal}건
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {configPreviewFiles.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
