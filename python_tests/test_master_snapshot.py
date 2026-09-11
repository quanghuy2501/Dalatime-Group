import csv
import json
import tracemalloc
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.master_snapshot import FILE_NAMES, SHEETS, _google_rows, export_snapshot, fingerprint


class FakePagedGoogle:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def values_page(self, spreadsheet_id, title, start, end):
        self.calls.append((start, end))
        return self.pages.get(start, [])


class MasterSnapshotTests(unittest.TestCase):
    @staticmethod
    def _args(root, output):
        return Namespace(live=False, fixture_dir=str(root), credentials=None,
                         master_id="fixture", retries=0, base_delay=0,
                         page_rows=500, output=str(output))

    def test_paginated_rows_preserve_internal_but_not_trailing_blanks(self):
        api = FakePagedGoogle({1: [["head"], ["one"]], 5: [["five"]]})
        rows = list(_google_rows(api, "book", "Sheet", 8, 2))
        self.assertEqual(rows, [["head"], ["one"], [], [], ["five"]])
        self.assertEqual(api.calls, [(1, 2), (3, 4), (5, 6), (7, 8)])

    def test_large_fixture_export_has_bounded_python_allocation(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for title in SHEETS.values():
                path = root / FILE_NAMES[title]
                with path.open("w", newline="", encoding="utf-8") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["header"] * 8)
                    if title == "NORMALIZED":
                        row = ["x" * 64] * 8
                        for _ in range(63_000):
                            writer.writerow(row)

            output = root / "snapshot.json"
            tracemalloc.start()
            with redirect_stdout(StringIO()):
                result = export_snapshot(self._args(root, output))
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()

            self.assertEqual(result, 0)
            # Regression guard: the exporter must not retain the ~34 MiB fixture
            # or a duplicate serialized snapshot in Python objects.
            self.assertLess(peak, 16 * 1024 * 1024)
            snapshot = json.loads(output.read_text(encoding="utf-8"))
            self.assertTrue(snapshot["locked"])
            self.assertEqual(snapshot["sources"]["normalized"]["row_count"], 63_001)
            self.assertEqual(snapshot["sha256"], fingerprint(snapshot["sources"]))

    def test_missing_sheet_writes_atomic_unlocked_partial_snapshot(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for title in list(SHEETS.values())[:-1]:
                with (root / FILE_NAMES[title]).open("w", newline="", encoding="utf-8") as handle:
                    csv.writer(handle).writerow([title])
            output = root / "snapshot.json"
            with redirect_stdout(StringIO()):
                result = export_snapshot(self._args(root, output))
            snapshot = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result, 2)
            self.assertEqual(snapshot["status"], "partial")
            self.assertFalse(snapshot["locked"])
            self.assertTrue(snapshot["source_errors"])


if __name__ == "__main__":
    unittest.main()
