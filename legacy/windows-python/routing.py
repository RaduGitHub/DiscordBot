"""Validated, atomic storage for the bot's command and destination channels."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


FORMAT_VERSION = 1
MAX_DISCORD_ID = (1 << 64) - 1


@dataclass(frozen=True)
class ChannelRouting:
    command_channel_id: int
    post_channel_id: int


class RoutingStore:
    def __init__(self, path: Path, server_id: int):
        if type(server_id) is not int or not 0 < server_id <= MAX_DISCORD_ID:
            raise ValueError("The configured server ID must be a positive Discord ID.")
        self.path = Path(path)
        self.server_id = server_id
        self.routing: Optional[ChannelRouting] = None
        self._load()

    @staticmethod
    def _read_id(value) -> int:
        if not isinstance(value, str) or not value.isascii() or not value.isdigit():
            raise ValueError("Saved channel settings must contain positive numeric Discord IDs inside quotes.")
        if len(value) > 20:
            raise ValueError("Saved channel settings contain an invalid Discord ID. Restore the file from a backup.")
        number = int(value)
        if not 0 < number <= MAX_DISCORD_ID:
            raise ValueError("Saved channel settings contain an invalid Discord ID. Restore the file from a backup.")
        return number

    @staticmethod
    def _validate(routing: ChannelRouting) -> ChannelRouting:
        if not isinstance(routing, ChannelRouting):
            raise ValueError("Choose both a command channel and a photo destination channel.")
        for channel_id in (routing.command_channel_id, routing.post_channel_id):
            if type(channel_id) is not int or not 0 < channel_id <= MAX_DISCORD_ID:
                raise ValueError("Channel settings must contain positive numeric Discord channel IDs.")
        if routing.command_channel_id == routing.post_channel_id:
            raise ValueError("The command channel and photo destination must be different channels.")
        return routing

    def _load(self):
        try:
            contents = self.path.read_text(encoding="utf-8-sig")
        except FileNotFoundError:
            return
        except (OSError, UnicodeError):
            raise ValueError("Cannot read saved channel settings. Check file permissions or restore a backup.") from None
        try:
            data = json.loads(contents)
        except json.JSONDecodeError:
            raise ValueError("Saved channel settings are not valid JSON. Restore a backup or rename the file to start fresh.") from None
        expected = {"version", "server_id", "command_channel_id", "post_channel_id"}
        if not isinstance(data, dict) or set(data) != expected:
            raise ValueError("Saved channel settings have an invalid format. Restore a backup or rename the file to start fresh.")
        if type(data["version"]) is not int or data["version"] != FORMAT_VERSION:
            raise ValueError("Saved channel settings use an unsupported version. Restore a compatible backup.")
        if self._read_id(data["server_id"]) != self.server_id:
            raise ValueError("Saved channel settings belong to another server. Rename that file before using this server.")
        self.routing = self._validate(ChannelRouting(
            command_channel_id=self._read_id(data["command_channel_id"]),
            post_channel_id=self._read_id(data["post_channel_id"]),
        ))

    def commit(self, routing: ChannelRouting):
        validated = self._validate(routing)
        data = {
            "version": FORMAT_VERSION,
            "server_id": str(self.server_id),
            "command_channel_id": str(validated.command_channel_id),
            "post_channel_id": str(validated.post_channel_id),
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
        self.routing = validated
