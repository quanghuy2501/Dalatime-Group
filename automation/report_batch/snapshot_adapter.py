#!/usr/bin/env python3
"""Read-only complete snapshot adapter for the Onicorn Master export/API.

No Google write and no DB write. Reads either --input JSON or --url (an API that
returns JSON containing RAW_DATA and NORMALIZED). 429 responses are retried.
"""
from __future__ import annotations
import argparse, hashlib, json, os, time, uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCHEMA = "onicorn.complete.snapshot.v1"

def fingerprint(raw, normalized):
    body = json.dumps({"RAW_DATA": raw, "NORMALIZED": normalized}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()

def fetch(url, token, retries):
    headers = {"Accept": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    last = None
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=headers), timeout=15) as response:
                return json.load(response)
        except HTTPError as exc:
            last = exc
            if exc.code != 429 or attempt == retries: raise
            retry_after = exc.headers.get("Retry-After", "1")
            try: delay = min(float(retry_after), 30)
            except ValueError: delay = 1
            time.sleep(delay)
        except URLError as exc:
            last = exc
            raise
    raise last  # pragma: no cover

def load_source(args):
    if args.input:
        return json.loads(Path(args.input).read_text(encoding="utf-8")), "local:" + str(args.input)
    if args.url:
        return fetch(args.url, args.token or os.getenv("ONICORN_API_TOKEN"), args.retries), args.url
    raise ValueError("provide --input or --url")

def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", type=Path)
    src.add_argument("--url")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--token")
    a = ap.parse_args()
    run_id = str(uuid.uuid4())
    try:
        source, source_name = load_source(a)
        raw = source.get("RAW_DATA") if isinstance(source, dict) else None
        normalized = source.get("NORMALIZED") if isinstance(source, dict) else None
        missing = [name for name, value in (("RAW_DATA", raw), ("NORMALIZED", normalized)) if value is None]
        complete = not missing
        status = "complete" if complete else "blocked"
        result = {"schema": SCHEMA, "run_id": run_id, "status": status, "locked": True,
                  "source": source_name, "fingerprint": fingerprint(raw, normalized) if complete else None,
                  "counts": {"RAW_DATA": len(raw) if isinstance(raw, list) else None,
                             "NORMALIZED": len(normalized) if isinstance(normalized, list) else None},
                  "RAW_DATA": raw if complete else None, "NORMALIZED": normalized if complete else None}
        if not complete:
            result["blocker"] = {"reason": "source did not expose full RAW_DATA and NORMALIZED payloads", "missing": missing,
                                 "next_step": "Grant the service account read access to the Master and rerun with the read-only endpoint/export containing both exact tabs."}
    except Exception as exc:
        result = {"schema": SCHEMA, "run_id": run_id, "status": "blocked", "locked": True,
                  "fingerprint": None, "source": a.url or str(a.input), "counts": {},
                  "blocker": {"reason": f"read failed: {type(exc).__name__}: {exc}",
                              "next_step": "Verify service-account read access and endpoint URL, then rerun this adapter; no write/repair is permitted."}}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("status", "run_id", "locked", "fingerprint", "counts")}, ensure_ascii=False))
    raise SystemExit(0 if result["status"] == "complete" else 2)

if __name__ == "__main__": main()
