#!/usr/bin/env python3
"""
outlook_extract.py — Extract emails and meetings from Outlook.

Backends:
  com   — Windows desktop Outlook via win32com
  graph — Microsoft 365 via Graph API (macOS, Windows, Linux)

Set OUTLOOK_BACKEND=auto|com|graph (auto: com on Windows, graph elsewhere).
"""
import argparse
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)


def resolve_backend() -> str:
    backend = (os.environ.get("OUTLOOK_BACKEND") or "auto").strip().lower()
    if backend == "auto":
        return "graph"
    if backend in ("com", "graph"):
        return backend
    raise ValueError(f"Invalid OUTLOOK_BACKEND: {backend}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract Outlook data")
    parser.add_argument("--start-date", required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", required=True, help="End date (YYYY-MM-DD)")
    parser.add_argument(
        "--types", default="email,meeting", help="Types to extract (email,meeting)"
    )
    parser.add_argument(
        "--include-tentative", default="false", help="Include tentative meetings (true/false)"
    )
    args = parser.parse_args()

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    include_tentative = args.include_tentative.lower() == "true"
    result = {
        "success": True,
        "data": [],
        "counts": {},
        "errors": [],
    }

    try:
        backend = resolve_backend()
        if backend == "com":
            from backends.com_extract import run_extract

            result = run_extract(args.start_date, args.end_date, types, include_tentative=include_tentative)
        else:
            from backends.graph_extract import run_extract

            result = run_extract(args.start_date, args.end_date, types, include_tentative=include_tentative)
    except Exception as exc:
        result["success"] = False
        result["errors"].append(str(exc))

    print(json.dumps(result))


if __name__ == "__main__":
    main()
