"""Validated, atomic storage for the server's default photo mention targets."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import List


MAX_SAVED_TARGETS = 25
FORMAT_VERSION = 1
MAX_DISCORD_ID = (1 << 64) - 1


@dataclass(frozen=True)
class SavedTarget:
    kind: str
    id: int


class TargetStore:
    def __init__(self, path: Path, server_id: int):
        if type(server_id) is not int or not 0 < server_id <= MAX_DISCORD_ID:
            raise ValueError("The configured server ID must be a positive Discord ID.")
        self.path = Path(path)
        self.server_id = server_id
        self.targets: List[SavedTarget] = []
        self._load()

    @staticmethod
    def _read_id(value) -> int:
        if not isinstance(value, str) or not value.isascii() or not value.isdigit():
            raise ValueError("Saved target settings must contain positive numeric Discord IDs inside quotes.")
        # Discord snowflakes fit within an unsigned 64-bit integer.
        if len(value) > 20:
            raise ValueError("Saved target settings contain an invalid Discord ID. Restore the file from a backup.")
        number = int(value)
        if not 0 < number <= MAX_DISCORD_ID:
            raise ValueError("Saved target settings contain an invalid Discord ID. Restore the file from a backup.")
        return number

    def _validate_targets(self, targets: List[SavedTarget]) -> List[SavedTarget]:
        if not isinstance(targets, list):
            raise ValueError("Saved mention targets must be a list of users and roles.")
        if len(targets) > MAX_SAVED_TARGETS:
            raise ValueError(f"You can save at most {MAX_SAVED_TARGETS} default mention targets. Remove a target first.")
        seen = set()
        validated = []
        for target in targets:
            if not isinstance(target, SavedTarget) or target.kind not in ("user", "role"):
                raise ValueError("Saved mention targets must identify a user or a role.")
            if type(target.id) is not int or not 0 < target.id <= MAX_DISCORD_ID:
                raise ValueError("Saved mention targets must have positive numeric Discord IDs.")
            if target.kind == "role" and target.id == self.server_id:
                raise ValueError("The @everyone role cannot be saved. Choose another server role.")
            key = (target.kind, target.id)
            if key in seen:
                raise ValueError("Saved mention targets contain a duplicate. Keep each user or role only once.")
            seen.add(key)
            validated.append(target)
        return validated

    def _load(self):
        try:
            contents = self.path.read_text(encoding="utf-8-sig")
        except FileNotFoundError:
            return
        except (OSError, UnicodeError):
            raise ValueError("Cannot read saved target settings. Check the file permissions or restore a backup.") from None
        try:
            data = json.loads(contents)
        except json.JSONDecodeError:
            raise ValueError("Saved target settings are not valid JSON. Restore a backup or rename the file to start fresh.") from None
        if not isinstance(data, dict) or set(data) != {"version", "server_id", "targets"}:
            raise ValueError("Saved target settings have an invalid format. Restore a backup or rename the file to start fresh.")
        if type(data["version"]) is not int or data["version"] != FORMAT_VERSION:
            raise ValueError("Saved target settings use an unsupported version. Restore a compatible backup.")
        if self._read_id(data["server_id"]) != self.server_id:
            raise ValueError("Saved target settings belong to another server. Rename that file before using this server.")
        if not isinstance(data["targets"], list):
            raise ValueError("Saved target settings must contain a list of users and roles.")
        targets = []
        for entry in data["targets"]:
            if not isinstance(entry, dict) or set(entry) != {"type", "id"}:
                raise ValueError("Saved target settings contain an invalid entry. Restore a backup or rename the file.")
            targets.append(SavedTarget(kind=entry["type"], id=self._read_id(entry["id"])))
        self.targets = self._validate_targets(targets)

    def commit(self, targets: List[SavedTarget]):
        # Copy and validate before touching the file or the current in-memory list.
        validated = self._validate_targets(targets)
        data = {
            "version": FORMAT_VERSION,
            "server_id": str(self.server_id),
            "targets": [{"type": target.kind, "id": str(target.id)} for target in validated],
        }
        temporary = self.path.with_name(self.path.name + ".tmp")
        try:
            temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        # Nothing below can fail: memory changes only after the replacement succeeds.
        self.targets = validated
