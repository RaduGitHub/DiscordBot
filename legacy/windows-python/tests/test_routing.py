"""Offline checks for channel routing; all temporary files remain under tests/.local/."""

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

from routing import ChannelRouting, MAX_DISCORD_ID, RoutingStore


SERVER = 100000000000000001
COMMANDS = 100000000000000002
POSTS = 100000000000000003


class RoutingStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="routing-test-", dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "routing.json"
        self.store = RoutingStore(self.path, SERVER)
        self.routing = ChannelRouting(COMMANDS, POSTS)

    def data(self):
        return {
            "version": 1,
            "server_id": str(SERVER),
            "command_channel_id": str(COMMANDS),
            "post_channel_id": str(POSTS),
        }

    def write(self, data):
        self.path.write_text(json.dumps(data), encoding="utf-8")

    def test_missing_file_starts_unconfigured_without_writing(self):
        self.assertIsNone(self.store.routing)
        self.assertFalse(self.path.exists())

    def test_commit_roundtrip_and_versioned_string_ids(self):
        self.store.commit(self.routing)
        self.assertEqual(self.store.routing, self.routing)
        self.assertEqual(json.loads(self.path.read_text()), self.data())
        self.assertEqual(RoutingStore(self.path, SERVER).routing, self.routing)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_replacing_previous_routes_persists(self):
        self.store.commit(self.routing)
        replacement = ChannelRouting(COMMANDS + 2, POSTS + 2)
        self.store.commit(replacement)
        self.assertEqual(RoutingStore(self.path, SERVER).routing, replacement)

    def test_routing_is_frozen(self):
        with self.assertRaises(FrozenInstanceError):
            self.routing.post_channel_id = COMMANDS

    def test_invalid_configured_server_ids(self):
        for value in (True, False, 0, -1, "1", None, MAX_DISCORD_ID + 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                RoutingStore(self.path, value)

    def test_invalid_route_values_leave_memory_and_disk_intact(self):
        self.store.commit(self.routing)
        original = self.path.read_bytes()
        for value in (None, {}, [], "channels", ChannelRouting(0, POSTS),
                      ChannelRouting(COMMANDS, -1), ChannelRouting(True, POSTS),
                      ChannelRouting(COMMANDS, "1"), ChannelRouting(MAX_DISCORD_ID + 1, POSTS)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.store.commit(value)
            self.assertEqual(self.store.routing, self.routing)
            self.assertEqual(self.path.read_bytes(), original)

    def test_same_channel_rejected_when_loading_and_committing(self):
        with self.assertRaisesRegex(ValueError, "different"):
            self.store.commit(ChannelRouting(COMMANDS, COMMANDS))
        data = self.data()
        data["post_channel_id"] = data["command_channel_id"]
        self.write(data)
        with self.assertRaisesRegex(ValueError, "different"):
            RoutingStore(self.path, SERVER)

    def test_server_mismatch_is_rejected(self):
        self.write(self.data())
        with self.assertRaisesRegex(ValueError, "another server"):
            RoutingStore(self.path, SERVER + 5)

    def test_utf8_bom_is_supported(self):
        self.path.write_text(json.dumps(self.data()), encoding="utf-8-sig")
        self.assertEqual(RoutingStore(self.path, SERVER).routing, self.routing)

    def test_invalid_json_does_not_echo_sensitive_data(self):
        sensitive = "private-bot-token-do-not-echo"
        self.path.write_text(sensitive, encoding="utf-8")
        with self.assertRaises(ValueError) as caught:
            RoutingStore(self.path, SERVER)
        self.assertNotIn(sensitive, str(caught.exception))

    def test_invalid_encoding_is_sanitized(self):
        self.path.write_bytes(b"\xff\xff\xff")
        with self.assertRaisesRegex(ValueError, "Cannot read"):
            RoutingStore(self.path, SERVER)

    def test_invalid_top_level_schema(self):
        for value in (None, [], {}, {**self.data(), "extra": "ignored?"}):
            with self.subTest(value=value):
                self.write(value)
                with self.assertRaisesRegex(ValueError, "format"):
                    RoutingStore(self.path, SERVER)

    def test_missing_keys_are_rejected(self):
        for key in self.data():
            data = self.data()
            del data[key]
            self.write(data)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "format"):
                RoutingStore(self.path, SERVER)

    def test_invalid_version_is_rejected(self):
        for version in (True, False, "1", 0, 2, None):
            data = self.data()
            data["version"] = version
            self.write(data)
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "version"):
                RoutingStore(self.path, SERVER)

    def test_invalid_persisted_ids(self):
        for key in ("server_id", "command_channel_id", "post_channel_id"):
            for value in (0, True, None, "0", "-1", "", "1.5", " 1", "١", "9" * 21,
                          str(MAX_DISCORD_ID + 1)):
                data = self.data()
                data[key] = value
                self.write(data)
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    RoutingStore(self.path, SERVER)

    def test_maximum_ids_are_supported(self):
        route = ChannelRouting(MAX_DISCORD_ID, MAX_DISCORD_ID - 1)
        self.store.commit(route)
        self.assertEqual(RoutingStore(self.path, SERVER).routing, route)

    def test_failed_write_preserves_memory_and_existing_file(self):
        self.store.commit(self.routing)
        original = self.path.read_bytes()
        with patch.object(Path, "write_text", side_effect=PermissionError("offline test")):
            with self.assertRaises(OSError):
                self.store.commit(ChannelRouting(COMMANDS + 5, POSTS + 5))
        self.assertEqual(self.store.routing, self.routing)
        self.assertEqual(self.path.read_bytes(), original)

    def test_failed_replace_preserves_memory_and_existing_file(self):
        self.store.commit(self.routing)
        original = self.path.read_bytes()
        with patch.object(Path, "replace", side_effect=PermissionError("offline test")):
            with self.assertRaises(OSError):
                self.store.commit(ChannelRouting(COMMANDS + 5, POSTS + 5))
        self.assertEqual(self.store.routing, self.routing)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_read_permission_error_is_sanitized(self):
        with patch.object(Path, "read_text", side_effect=PermissionError("private path")):
            with self.assertRaisesRegex(ValueError, "Cannot read") as caught:
                RoutingStore(self.path, SERVER)
        self.assertNotIn("private path", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
