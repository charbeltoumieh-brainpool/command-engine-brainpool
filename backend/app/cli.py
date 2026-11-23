from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

from .db import init_db
from .executor import execute_approved_action
from .memory import index_missing_embeddings
from .orchestrator import (
    ask_chief_of_staff,
    generate_executive_briefing,
    ingest_batch_payload,
    run_full_sweep,
)


def main() -> None:
    init_db()
    parser = argparse.ArgumentParser(description="Command Engine Chief-of-Staff CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sweep", help="Run local workspace and GitHub collectors")

    p_ingest = sub.add_parser("ingest", help="Ingest a JSON batch file into SQLite and embeddings")
    p_ingest.add_argument("--file", required=True, help="Path to JSON batch payload")

    p_brief = sub.add_parser("briefing", help="Generate an executive briefing")
    p_brief.add_argument(
        "--kind",
        default="whats_new",
        choices=["whats_new", "morning", "eod", "needed", "post_call"],
    )
    p_brief.add_argument("--since-last-check", action="store_true")

    p_ask = sub.add_parser("ask", help="Ask Chief of Staff a natural-language question")
    p_ask.add_argument("question", help="Question text")

    p_approve = sub.add_parser("approve", help="Execute a pending approval ID")
    p_approve.add_argument("approval_id", type=int)

    args = parser.parse_args()

    if args.cmd == "sweep":
        res = asyncio.run(run_full_sweep(trigger_source="cli"))
        print(json.dumps(res, indent=2))
    elif args.cmd == "ingest":
        data = json.loads(Path(args.file).read_text(encoding="utf-8"))
        counts = ingest_batch_payload(data)
        emb = asyncio.run(index_missing_embeddings(limit=80))
        print(json.dumps({"ingested": counts, "embedded": emb}, indent=2))
    elif args.cmd == "briefing":
        res = asyncio.run(
            generate_executive_briefing(
                kind=args.kind,
                since_last_check_only=args.since_last_check,
            )
        )
        sys.stdout.buffer.write((res["content_md"] + "\n").encode("utf-8"))
    elif args.cmd == "ask":
        res = asyncio.run(ask_chief_of_staff(args.question))
        sys.stdout.buffer.write((res["answer_md"] + "\n").encode("utf-8"))
    elif args.cmd == "approve":
        res = execute_approved_action(args.approval_id)
        print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
