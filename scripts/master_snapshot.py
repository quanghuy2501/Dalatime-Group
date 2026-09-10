#!/usr/bin/env python3
"""Read-only, atomic Master snapshot exporter and discrepancy auditor."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import random
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SHEETS = {
    "clients": "1. KHACH HANG",
    "staff": "2. NHAN SU",
    "channels": "3. CHANNEL",
    "brands": "4. LIST BRAND",
    "raw_data": "RAW_DATA",
    "normalized": "NORMALIZED",
}
OPTIONAL_SHEETS = {"config": "CONFIG", "sync_log": "SYNC_LOG"}
FILE_NAMES = {v: f"extracted_{v.replace(' ', '_')}.csv" for v in {**SHEETS, **OPTIONAL_SHEETS}.values()}
FILE_NAMES.update({"1. KHACH HANG": "extracted_1._KHACH_HANG.csv", "2. NHAN SU": "extracted_2._NHAN_SU.csv", "3. CHANNEL": "extracted_3._CHANNEL.csv", "4. LIST BRAND": "extracted_4._LIST_BRAND.csv"})
DEFAULT_MASTER_ID = "1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0"
READONLY_SCOPES = "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly"


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def fingerprint(sources):
    # Fingerprint source content, not machine-specific fixture paths.
    content = {key: {name: value for name, value in source.items() if name != "origin"} for key, source in sources.items()}
    return hashlib.sha256(canonical(content)).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class ReadonlyGoogle:
    """Minimal GET-only Google client. There is deliberately no generic request/write method."""
    def __init__(self, key_file, retries=6, base_delay=1.0):
        self.key = json.loads(Path(key_file).read_text(encoding="utf-8"))
        self.retries = retries
        self.base_delay = base_delay
        self.token = self._token()

    def _token(self):
        issued = int(time.time())
        head = b64url(canonical({"alg": "RS256", "typ": "JWT"}))
        claim = b64url(canonical({"iss": self.key["client_email"], "scope": READONLY_SCOPES, "aud": "https://oauth2.googleapis.com/token", "iat": issued, "exp": issued + 3600}))
        unsigned = f"{head}.{claim}".encode()
        # Keep the private key in a mode-0600 temporary file only for signing.
        with tempfile.NamedTemporaryFile(mode="w") as key_handle:
            os.chmod(key_handle.name, 0o600)
            key_handle.write(self.key["private_key"]); key_handle.flush()
            sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key_handle.name], input=unsigned, check=True, capture_output=True).stdout
        assertion = f"{head}.{claim}.{b64url(sig)}"
        body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}).encode()
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, headers={"content-type": "application/x-www-form-urlencoded"}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)["access_token"]

    def get(self, url):
        for attempt in range(self.retries + 1):
            try:
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"}, method="GET")
                with urllib.request.urlopen(req, timeout=90) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or attempt == self.retries:
                    raise
                retry_after = exc.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else min(60, self.base_delay * (2 ** attempt)) + random.random()
                time.sleep(delay)

    def values(self, spreadsheet_id, title):
        # Open-ended A:ZZ fetches every populated row, independent of dataset size.
        quoted = urllib.parse.quote(f"'{title.replace(chr(39), chr(39) * 2)}'!A:ZZ", safe="")
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{quoted}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER"
        return self.get(url).get("values", [])

    def sheet_titles(self, spreadsheet_id):
        fields = urllib.parse.quote("sheets(properties(title))", safe="")
        data = self.get(f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields={fields}")
        return {item.get("properties", {}).get("title") for item in data.get("sheets", [])}

    def modified_time(self, spreadsheet_id):
        fields = urllib.parse.quote("id,name,modifiedTime", safe="")
        return self.get(f"https://www.googleapis.com/drive/v3/files/{spreadsheet_id}?fields={fields}&supportsAllDrives=true")


def source_record(title, rows, origin):
    width = max((len(row) for row in rows), default=0)
    return {"sheet": title, "origin": origin, "row_count": len(rows), "column_count": width, "values": rows}


def export_snapshot(args):
    started = now_iso(); started_mono = time.monotonic(); run_id = str(uuid.uuid4()); sources = {}; errors = []; diagnostics = {}
    watermark = {"captured_at": started, "run_id": run_id}
    api = None
    if args.live:
        if not args.credentials:
            raise SystemExit("--live requires --credentials or GOOGLE_APPLICATION_CREDENTIALS")
        api = ReadonlyGoogle(args.credentials, args.retries, args.base_delay)
        try:
            meta = api.modified_time(args.master_id)
            titles = api.sheet_titles(args.master_id)
            watermark = {"drive_modified_time": meta.get("modifiedTime"), "captured_at": started, "run_id": run_id}
            for key, title in OPTIONAL_SHEETS.items():
                if title in titles: SHEETS[key] = title
        except Exception as exc:
            errors.append({"source": "master_metadata", "error": str(exc)})
    fixture_dir = Path(args.fixture_dir) if args.fixture_dir else None
    for key, title in SHEETS.items():
        sheet_started = time.monotonic()
        try:
            if api:
                rows = api.values(args.master_id, title)
                origin = f"google:{args.master_id}:{title}"
            else:
                file = fixture_dir / FILE_NAMES[title]
                with file.open(newline="", encoding="utf-8-sig") as handle:
                    rows = list(csv.reader(handle))
                origin = str(file.resolve())
            sources[key] = source_record(title, rows, origin)
            diagnostics[key] = {"sheet": title, "status": "ok", "rows": len(rows), "columns": max((len(r) for r in rows), default=0), "duration_ms": round((time.monotonic() - sheet_started) * 1000)}
        except Exception as exc:
            diagnostics[key] = {"sheet": title, "status": "error", "duration_ms": round((time.monotonic() - sheet_started) * 1000), "error": f"{type(exc).__name__}: {exc}"}
            errors.append({"source": key, "sheet": title, "error": f"{type(exc).__name__}: {exc}"})
    finished = now_iso(); complete = not errors and set(sources) == set(SHEETS)
    snapshot = {
        "schema_version": 1, "kind": "onicorn-master-snapshot", "run_id": run_id,
        "started_at": started, "finished_at": finished, "watermark": watermark,
        "status": "complete" if complete else "partial", "locked": complete,
        "read_only": True, "master_spreadsheet_id": args.master_id if api else None,
        "master_dimensions": {key: {"sheet": value["sheet"], "rows": value["row_count"], "columns": value["column_count"]} for key, value in sources.items()},
        "source_errors": errors, "diagnostics": diagnostics, "duration_ms": round((time.monotonic() - started_mono) * 1000), "sources": sources,
    }
    snapshot["sha256"] = fingerprint(sources)
    atomic_json(args.output, snapshot)
    print(json.dumps({"output": str(Path(args.output).resolve()), "status": snapshot["status"], "locked": snapshot["locked"], "sha256": snapshot["sha256"], "counts": {k: v["row_count"] for k, v in sources.items()}, "errors": errors}, ensure_ascii=False))
    return 0 if complete else 2


def clean(value): return str(value if value is not None else "").strip()
def header_index(rows):
    if not rows: return ([], [])
    candidates = rows[:20]
    idx = max(range(len(candidates)), key=lambda i: sum(bool(clean(v)) for v in candidates[i]))
    return ([clean(v) for v in rows[idx]], rows[idx + 1:])
def records(source):
    headers, rows = header_index(source.get("values", []))
    return [{headers[i]: row[i] if i < len(row) else "" for i in range(len(headers)) if headers[i]} for row in rows if any(clean(v) for v in row)]
def field(row, names):
    folded = {clean(k).casefold(): v for k, v in row.items()}
    return clean(next((folded[n.casefold()] for n in names if n.casefold() in folded), ""))
def multiset(rows, key_fn): return Counter(k for r in rows if (k := key_fn(r)))


def compare_counter(left, right, label):
    missing = left - right; extra = right - left
    return {"key": label, "master_total": sum(left.values()), "comparison_total": sum(right.values()),
            "missing_total": sum(missing.values()), "extra_total": sum(extra.values()),
            "missing": [{"value": list(k) if isinstance(k, tuple) else k, "count": n} for k, n in missing.most_common()],
            "extra": [{"value": list(k) if isinstance(k, tuple) else k, "count": n} for k, n in extra.most_common()]}


def audit(args):
    master = json.loads(Path(args.master).read_text(encoding="utf-8")); other = json.loads(Path(args.against).read_text(encoding="utf-8"))
    if not master.get("locked") or master.get("status") != "complete":
        raise SystemExit("Master snapshot must be complete and locked")
    ms, osrc = master["sources"], other.get("sources", other)
    raw_m, raw_o = records(ms["raw_data"]), records(osrc.get("raw_data", {"values": []}))
    norm_m, norm_o = records(ms["normalized"]), records(osrc.get("normalized", {"values": []}))
    url = lambda r: field(r, ["LINK BÀI ĐĂNG", "post_url", "url"])
    brand = lambda r: field(r, ["TÊN THƯƠNG HIỆU", "brand", "brand_name"])
    staff_id = lambda r: field(r, ["ID NHÂN VIÊN", "staff_id", "nv_id"])
    status = lambda r: field(r, ["TRẠNG THÁI", "status"])
    checks = [compare_counter(multiset(raw_m, url), multiset(raw_o, url), "post_url"),
              compare_counter(multiset(norm_m, lambda r: (url(r), brand(r)) if url(r) and brand(r) else None), multiset(norm_o, lambda r: (url(r), brand(r)) if url(r) and brand(r) else None), "post_url,brand")]
    staff_m, staff_o = records(ms.get("staff", {"values": []})), records(osrc.get("staff", {"values": []}))
    if any(staff_id(r) or status(r) for r in staff_m + staff_o):
        checks.append(compare_counter(multiset(staff_m, lambda r: (staff_id(r), status(r)) if staff_id(r) else None), multiset(staff_o, lambda r: (staff_id(r), status(r)) if staff_id(r) else None), "staff_id,status"))
    report = {"generated_at": now_iso(), "master_run_id": master["run_id"], "master_sha256": master["sha256"], "status": "match" if all(not c["missing_total"] and not c["extra_total"] for c in checks) else "discrepancy", "checks": checks}
    atomic_json(args.json, report)
    lines = ["# Master Snapshot Discrepancy Audit", "", f"Generated: {report['generated_at']}", f"Status: **{report['status']}**", f"Master run: `{report['master_run_id']}`", ""]
    for check in checks:
        lines += [f"## {check['key']}", "", f"- Master: {check['master_total']}", f"- Comparison: {check['comparison_total']}", f"- Missing: {check['missing_total']}", f"- Extra: {check['extra_total']}", ""]
    Path(args.md).parent.mkdir(parents=True, exist_ok=True); Path(args.md).write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"json": args.json, "md": args.md, "status": report["status"]}))
    return 0 if report["status"] == "match" else 3


def parser():
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("snapshot"); mode = s.add_mutually_exclusive_group(required=True); mode.add_argument("--fixture-dir"); mode.add_argument("--live", action="store_true")
    s.add_argument("--master-id", default=os.getenv("MASTER_SPREADSHEET_ID", DEFAULT_MASTER_ID)); s.add_argument("--credentials", default=os.getenv("GOOGLE_APPLICATION_CREDENTIALS")); s.add_argument("--output", required=True); s.add_argument("--retries", type=int, default=6); s.add_argument("--base-delay", type=float, default=1.0); s.set_defaults(func=export_snapshot)
    a = sub.add_parser("audit"); a.add_argument("--master", required=True); a.add_argument("--against", required=True); a.add_argument("--json", required=True); a.add_argument("--md", required=True); a.set_defaults(func=audit)
    return p


if __name__ == "__main__":
    ns = parser().parse_args(); raise SystemExit(ns.func(ns))
