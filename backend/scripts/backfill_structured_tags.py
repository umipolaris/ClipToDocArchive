#!/usr/bin/env python3
"""기존 문서에 구조화 태그(set/dockey/rev/kind/lang)를 보강한다.

사용 예시:
  python scripts/backfill_structured_tags.py --dry-run --limit 200
  python scripts/backfill_structured_tags.py --only-without-set --batch-size 500
  python scripts/backfill_structured_tags.py --source manual
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.models import SourceType
from app.db.session import SessionLocal
from app.services.structured_tag_backfill_service import run_structured_tag_backfill


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill structured tags for legacy documents")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only-without-set", action="store_true")
    parser.add_argument("--source", choices=[s.value for s in SourceType], default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = SourceType(args.source) if args.source else None

    with SessionLocal() as db:
        result = run_structured_tag_backfill(
            db,
            batch_size=args.batch_size,
            limit=args.limit,
            dry_run=args.dry_run,
            only_without_set=args.only_without_set,
            source=source,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
