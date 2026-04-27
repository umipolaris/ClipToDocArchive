#!/usr/bin/env python3
import argparse
import contextlib
import json
from pathlib import Path

import httpx


def parse_args():
    p = argparse.ArgumentParser(description="Ingest file to archive API")
    p.add_argument("--api", default="http://localhost:8000/api")
    p.add_argument("--file", action="append", required=True, help="repeat for batch upload")
    p.add_argument("--caption", default="")
    p.add_argument("--source", default="manual", choices=["manual", "api"])
    p.add_argument("--source-ref", default="")
    p.add_argument("--source-ref-prefix", default="")
    p.add_argument("--title", default="")
    p.add_argument("--description", default="")
    return p.parse_args()


def _single_payload(args) -> tuple[dict, Path]:
    file_path = Path(args.file[0])
    data = {
        "source": args.source,
        "caption": args.caption,
    }

    if args.source_ref:
        data["source_ref"] = args.source_ref
    if args.title:
        data["title"] = args.title
    if args.description:
        data["description"] = args.description

    return data, file_path


def _batch_payload(args) -> tuple[str, dict, list[Path]]:
    endpoint = "/ingest/manual/batch"
    files = [Path(raw) for raw in args.file]

    data = {
        "source": args.source,
        "caption": args.caption,
    }
    prefix = args.source_ref_prefix or args.source_ref
    if prefix:
        data["source_ref_prefix"] = prefix
    if args.title:
        data["title"] = args.title
    if args.description:
        data["description"] = args.description

    return endpoint, data, files


def main():
    args = parse_args()
    file_paths = [Path(raw) for raw in args.file]
    for file_path in file_paths:
        if not file_path.exists():
            raise SystemExit(f"file not found: {file_path}")

    single_mode = len(file_paths) == 1
    endpoint = "/ingest/manual"
    data: dict
    files_payload: list[tuple[str, tuple[str, object, str]]]

    if single_mode:
        data, file_path = _single_payload(args)
        with file_path.open("rb") as f, httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f"{args.api}{endpoint}",
                data=data,
                files={"file": (file_path.name, f, "application/octet-stream")},
            )
            print(resp.status_code)
            print(json.dumps(resp.json(), ensure_ascii=False, indent=2))
        return

    endpoint, data, batch_files = _batch_payload(args)
    with contextlib.ExitStack() as stack, httpx.Client(timeout=120.0) as client:
        files_payload = []
        for file_path in batch_files:
            file_obj = stack.enter_context(file_path.open("rb"))
            files_payload.append(("files", (file_path.name, file_obj, "application/octet-stream")))
        resp = client.post(f"{args.api}{endpoint}", data=data, files=files_payload)
        print(resp.status_code)
        print(json.dumps(resp.json(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
