"""Standalone storage checks; all filesystem changes stay beneath tests/.local/."""

import json
import sys
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import patch


TEST_ROOT = Path(__file__).resolve().parent
TEST_TEMP_ROOT = TEST_ROOT / ".local"
TEST_TEMP_ROOT.mkdir(exist_ok=True)
sys.path.insert(0, str(TEST_ROOT.parent))

from preferences import MAX_SAVED_TARGETS, SavedTarget, TargetStore


SERVER = 123456789012345678
USER = 234567890123456789
ROLE = 345678901234567890


class TargetStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="preferences-test-", dir=TEST_TEMP_ROOT)
        self.directory = Path(self.temporary.name).resolve()
        self.assertTrue(self.directory.is_relative_to(TEST_TEMP_ROOT.resolve()))
        self.path = self.directory / "targets.json"

    def tearDown(self):
        self.assertTrue(self.directory.is_relative_to(TEST_TEMP_ROOT.resolve()))
        self.temporary.cleanup()

    def payload(self, targets=None):
        return {
            "version": 1,
            "server_id": str(SERVER),
            "targets": [] if targets is None else targets,
        }

    def write_payload(self, payload):
        self.path.write_text(json.dumps(payload), encoding="utf-8")

    def test_missing_file_starts_empty_without_writing(self):
        store = TargetStore(self.path, SERVER)
        self.assertEqual(store.targets, [])
        self.assertFalse(self.path.exists())

    def test_commit_roundtrip_and_versioned_string_ids(self):
        store = TargetStore(self.path, SERVER)
        targets = [SavedTarget("user", USER), SavedTarget("role", ROLE)]
        store.commit(targets)
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data, self.payload([
            {"type": "user", "id": str(USER)},
            {"type": "role", "id": str(ROLE)},
        ]))
        self.assertEqual(TargetStore(self.path, SERVER).targets, targets)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_commit_does_not_alias_input(self):
        targets = [SavedTarget("user", USER)]
        store = TargetStore(self.path, SERVER)
        store.commit(targets)
        targets.clear()
        self.assertEqual(store.targets, [SavedTarget("user", USER)])

    def test_clear_persists(self):
        store = TargetStore(self.path, SERVER)
        store.commit([SavedTarget("user", USER)])
        store.commit([])
        self.assertEqual(TargetStore(self.path, SERVER).targets, [])

    def test_saved_target_is_frozen(self):
        target = SavedTarget("user", USER)
        with self.assertRaises(FrozenInstanceError):
            target.kind = "role"

    def test_invalid_json_and_sensitive_data_are_not_echoed(self):
        self.path.write_text('{"bot_token": "DO_NOT_ECHO_SECRET",', encoding="utf-8")
        with self.assertRaises(ValueError) as caught:
            TargetStore(self.path, SERVER)
        self.assertNotIn("DO_NOT_ECHO_SECRET", str(caught.exception))
        self.assertIn("JSON", str(caught.exception))

    def test_invalid_top_level_schema(self):
        for payload in ([], None, {}, {"server_id": str(SERVER), "targets": []}, self.payload("wrong")):
            with self.subTest(payload=payload):
                self.write_payload(payload)
                with self.assertRaises(ValueError):
                    TargetStore(self.path, SERVER)

    def test_invalid_or_unsupported_version(self):
        for version in (True, "1", 0, 2, None):
            with self.subTest(version=version):
                payload = self.payload()
                payload["version"] = version
                self.write_payload(payload)
                with self.assertRaises(ValueError):
                    TargetStore(self.path, SERVER)

    def test_server_mismatch_is_rejected(self):
        payload = self.payload()
        payload["server_id"] = str(SERVER + 1)
        self.write_payload(payload)
        with self.assertRaisesRegex(ValueError, "another server"):
            TargetStore(self.path, SERVER)

    def test_invalid_configured_server_ids(self):
        for value in (0, -1, True, "123", 1.5, 1 << 64):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    TargetStore(self.path, value)

    def test_invalid_persisted_ids(self):
        for value in ("", "0", "-1", "1.5", " 123 ", "１２３", True, 123, None, str(1 << 64), "9" * 5000):
            with self.subTest(value_type=type(value).__name__):
                self.write_payload(self.payload([{"type": "user", "id": value}]))
                with self.assertRaises(ValueError):
                    TargetStore(self.path, SERVER)

    def test_invalid_entries_and_kinds(self):
        for entry in (None, [], {}, {"type": "user", "id": str(USER), "extra": 1},
                      {"type": "everyone", "id": str(USER)}, {"type": [], "id": str(USER)}):
            with self.subTest(entry=entry):
                self.write_payload(self.payload([entry]))
                with self.assertRaises(ValueError):
                    TargetStore(self.path, SERVER)

    def test_duplicates_are_rejected_when_loading_or_committing(self):
        entry = {"type": "user", "id": str(USER)}
        self.write_payload(self.payload([entry, entry]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            TargetStore(self.path, SERVER)
        self.path.unlink()
        store = TargetStore(self.path, SERVER)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            store.commit([SavedTarget("user", USER), SavedTarget("user", USER)])
        self.assertFalse(self.path.exists())

    def test_default_role_is_rejected_when_loading_or_committing(self):
        self.write_payload(self.payload([{"type": "role", "id": str(SERVER)}]))
        with self.assertRaisesRegex(ValueError, "@everyone"):
            TargetStore(self.path, SERVER)
        self.path.unlink()
        store = TargetStore(self.path, SERVER)
        with self.assertRaisesRegex(ValueError, "@everyone"):
            store.commit([SavedTarget("role", SERVER)])

    def test_saved_target_limit(self):
        store = TargetStore(self.path, SERVER)
        store.commit([SavedTarget("user", USER + n) for n in range(MAX_SAVED_TARGETS)])
        previous = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "at most"):
            store.commit([SavedTarget("user", USER + n) for n in range(MAX_SAVED_TARGETS + 1)])
        self.assertEqual(self.path.read_bytes(), previous)
        self.write_payload(self.payload([
            {"type": "user", "id": str(USER + n)} for n in range(MAX_SAVED_TARGETS + 1)
        ]))
        with self.assertRaisesRegex(ValueError, "at most"):
            TargetStore(self.path, SERVER)

    def test_invalid_commit_inputs_leave_memory_and_disk_intact(self):
        store = TargetStore(self.path, SERVER)
        original = [SavedTarget("user", USER)]
        store.commit(original)
        data = self.path.read_bytes()
        inputs = [None, (), [object()], [SavedTarget("user", True)], [SavedTarget("user", 0)],
                  [SavedTarget("user", "123")], [SavedTarget("invalid", USER)], [SavedTarget([], USER)]]
        for value in inputs:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError):
                    store.commit(value)
                self.assertEqual(store.targets, original)
                self.assertEqual(self.path.read_bytes(), data)

    def test_failed_write_preserves_memory_and_existing_file(self):
        store = TargetStore(self.path, SERVER)
        original = [SavedTarget("user", USER)]
        store.commit(original)
        previous = self.path.read_bytes()
        with patch.object(Path, "write_text", side_effect=OSError("simulated write error")):
            with self.assertRaises(OSError):
                store.commit([SavedTarget("role", ROLE)])
        self.assertEqual(store.targets, original)
        self.assertEqual(self.path.read_bytes(), previous)

    def test_failed_replace_preserves_memory_and_existing_file(self):
        store = TargetStore(self.path, SERVER)
        original = [SavedTarget("user", USER)]
        store.commit(original)
        previous = self.path.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("simulated replace error")):
            with self.assertRaises(OSError):
                store.commit([SavedTarget("role", ROLE)])
        self.assertEqual(store.targets, original)
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_utf8_bom_is_supported(self):
        self.path.write_text(json.dumps(self.payload()), encoding="utf-8-sig")
        self.assertEqual(TargetStore(self.path, SERVER).targets, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
