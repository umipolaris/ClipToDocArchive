from io import BytesIO
from pathlib import Path

from minio import Minio
from minio.error import S3Error


def get_minio_client(endpoint: str, access_key: str, secret_key: str, secure: bool) -> Minio:
    return Minio(endpoint=endpoint, access_key=access_key, secret_key=secret_key, secure=secure)


def ensure_bucket(client: Minio, bucket: str) -> None:
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def put_file(client: Minio, bucket: str, storage_key: str, content: bytes, content_type: str) -> None:
    data = BytesIO(content)
    client.put_object(
        bucket_name=bucket,
        object_name=storage_key,
        data=data,
        length=len(content),
        content_type=content_type,
    )


_PART_SIZE = 32 * 1024 * 1024


def put_file_from_path(client: Minio, bucket: str, storage_key: str, source_path: str, content_type: str) -> None:
    client.fput_object(
        bucket_name=bucket,
        object_name=storage_key,
        file_path=str(Path(source_path)),
        content_type=content_type,
        part_size=_PART_SIZE,
    )


def delete_file(client: Minio, bucket: str, storage_key: str) -> None:
    try:
        client.remove_object(bucket_name=bucket, object_name=storage_key)
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject"}:
            return
        raise
