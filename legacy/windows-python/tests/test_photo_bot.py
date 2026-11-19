"""Offline bot tests: no Discord login, API requests, posts, or notifications."""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

TEST_ROOT = Path(__file__).resolve().parent
TEST_TEMP_ROOT = TEST_ROOT / ".local"
TEST_TEMP_ROOT.mkdir(exist_ok=True)
sys.path.insert(0, str(TEST_ROOT.parent))

import discord
from bot import MAX_PHOTO_BYTES, PhotoBot, Settings
from preferences import MAX_SAVED_TARGETS, SavedTarget
from routing import ChannelRouting

ADMIN = 100000000000000001
SERVER = 100000000000000002
TARGET = 100000000000000003
OWNER = 100000000000000004
ROLE = 100000000000000005
COMMAND_CHANNEL = 100000000000000006
POST_CHANNEL = 100000000000000007


def http_error(cls=discord.HTTPException, status=400):
    response = SimpleNamespace(status=status, reason="Offline test")
    return cls(response, {"message": "Offline simulated failure", "code": 50035})


def complete(coroutine):
    """Drive fully mocked coroutines without Windows asyncio socket creation."""
    try:
        coroutine.send(None)
    except StopIteration as stopped:
        return stopped.value
    finally:
        coroutine.close()
    raise AssertionError("Offline test unexpectedly attempted real asynchronous I/O")


class PhotoBotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bot-test-", dir=TEST_TEMP_ROOT)
        self.preferences_path = Path(self.temp.name) / "preferences.json"
        self.routing_path = Path(self.temp.name) / "routing.json"
        self.bot_settings = Settings("offline-test-token", SERVER, ADMIN)
        self.client = PhotoBot(self.bot_settings, preferences_path=self.preferences_path, routing_path=self.routing_path)
        self.client.routing.commit(ChannelRouting(COMMAND_CHANNEL, POST_CHANNEL))
        self.admin = MagicMock(spec=discord.Member)
        self.admin.id = ADMIN
        self.target = MagicMock(spec=discord.Member)
        self.target.id = TARGET
        self.target.mention = f"<@{TARGET}>"
        self.bot_member = MagicMock(spec=discord.Member)
        self.members = {TARGET: self.target}
        self.roles = {}
        self.guild = SimpleNamespace(
            id=SERVER, owner_id=OWNER, me=self.bot_member, filesize_limit=10 * 1024 * 1024,
            get_member=Mock(side_effect=lambda member_id: self.members.get(member_id)),
            fetch_member=AsyncMock(return_value=self.target),
            get_role=Mock(side_effect=lambda role_id: self.roles.get(role_id)),
        )
        self.admin.guild = self.guild
        self.target.guild = self.guild
        self.bot_permissions = discord.Permissions(view_channel=True, send_messages=True, attach_files=True)
        self.admin_channel_permissions = discord.Permissions(view_channel=True, send_messages=True)
        self.target_permissions = discord.Permissions(view_channel=True)
        self.channel = MagicMock(spec=discord.TextChannel)
        self.channel.id = POST_CHANNEL
        self.channel.mention = f"<#{POST_CHANNEL}>"
        self.channel.guild = self.guild
        self.channel.permissions_for.side_effect = self.permissions_for
        self.channel.send = AsyncMock(return_value=SimpleNamespace(jump_url="https://discord.com/channels/1/2/3"))
        self.command_channel = MagicMock(spec=discord.TextChannel)
        self.command_channel.id = COMMAND_CHANNEL
        self.command_channel.mention = f"<#{COMMAND_CHANNEL}>"
        self.command_channel.guild = self.guild
        self.command_bot_permissions = discord.Permissions(view_channel=True, send_messages=True, attach_files=True)
        self.command_admin_permissions = discord.Permissions(view_channel=True, send_messages=True)
        self.command_channel.permissions_for.side_effect = lambda member: (
            self.command_bot_permissions if member is self.bot_member else self.command_admin_permissions
        )
        self.command_channel.send = AsyncMock()
        self.client.get_channel = Mock(side_effect=lambda channel_id: {
            POST_CHANNEL: self.channel, COMMAND_CHANNEL: self.command_channel
        }.get(channel_id))
        self.interaction = MagicMock(spec=discord.Interaction)
        self.interaction.user = self.admin
        self.interaction.guild = self.guild
        self.interaction.guild_id = SERVER
        self.interaction.channel = self.command_channel
        self.interaction.channel_id = COMMAND_CHANNEL
        self.interaction.permissions = discord.Permissions(administrator=True)
        self.interaction.response = SimpleNamespace(
            send_message=AsyncMock(), defer=AsyncMock(), is_done=Mock(return_value=False)
        )
        self.interaction.edit_original_response = AsyncMock()
        self.upload = discord.File(io.BytesIO(b"offline image bytes"), filename="photo.png")
        self.photo = MagicMock(spec=discord.Attachment)
        self.photo.content_type = "image/png"
        self.photo.size = 19
        self.photo.is_spoiler.return_value = False
        self.photo.to_file = AsyncMock(return_value=self.upload)

    def permissions_for(self, member):
        if member is self.bot_member:
            return self.bot_permissions
        if member is self.admin:
            return self.admin_channel_permissions
        if member is self.target:
            return self.target_permissions
        raise AssertionError("Unexpected member permission lookup")

    def tearDown(self):
        self.upload.close()
        self.upload.fp.close()
        self.temp.cleanup()

    def invoke(self, **kwargs):
        kwargs.setdefault("target", self.target)
        return complete(self.client.post_photo(self.interaction, self.photo, **kwargs))

    def settings(self, operation, **kwargs):
        callback = {"add": self.client.add_target, "remove": self.client.remove_target,
                    "list": self.client.list_targets, "clear": self.client.clear_targets,
                    "channels": self.client.set_channels}[operation]
        return complete(callback(self.interaction, **kwargs))

    def response_text(self):
        if self.interaction.edit_original_response.await_count:
            call = self.interaction.edit_original_response.call_args
            return call.kwargs.get("content", call.args[0] if call.args else "")
        call = self.interaction.response.send_message.call_args
        if call is None:
            self.fail("No private response was sent")
        return call.kwargs.get("content", call.args[0] if call.args else "")

    def assert_no_post(self, expected=None):
        self.channel.send.assert_not_awaited()
        self.command_channel.send.assert_not_awaited()
        self.photo.to_file.assert_not_awaited()
        if expected is not None:
            self.assertIn(expected.casefold(), self.response_text().casefold())

    def assert_private_settings_reply(self):
        self.interaction.response.send_message.assert_awaited_once()
        kwargs = self.interaction.response.send_message.call_args.kwargs
        self.assertTrue(kwargs["ephemeral"])
        self.assertEqual(kwargs["allowed_mentions"].to_dict(), {"parse": []})

    def make_role(self, role_id=ROLE):
        role = MagicMock(spec=discord.Role)
        role.id = role_id
        role.guild = self.guild
        role.mention = f"<@&{role_id}>"
        role.mentionable = True
        role.is_default.return_value = False
        self.roles[role_id] = role
        return role

    def save_defaults(self, *targets):
        self.client.preferences.commit(list(targets))

    def test_real_command_schema_admin_permissions_and_minimal_intents(self):
        command = self.client.tree.get_command("post", guild=self.client.server)
        data = command.to_dict(self.client.tree)
        options = {item["name"]: item for item in data["options"]}
        self.assertEqual(options["target"]["type"], 9)
        self.assertEqual(options["photo"]["type"], 11)
        self.assertFalse(options["target"]["required"])
        self.assertTrue(options["photo"]["required"])
        self.assertNotIn("channel", options)
        self.assertFalse(options["caption"]["required"])
        self.assertEqual(int(data["default_member_permissions"]), 8)
        self.assertFalse(data["dm_permission"])
        group_data = self.client.tree.get_command("settings", guild=self.client.server).to_dict(self.client.tree)
        self.assertEqual(int(group_data["default_member_permissions"]), 8)
        self.assertEqual({c["name"] for c in group_data["options"]}, {"add", "remove", "list", "clear", "channels"})
        self.assertEqual(self.client.intents.value, discord.Intents(guilds=True).value)
        self.assertEqual(self.client.allowed_mentions.to_dict()["parse"], [])

    def test_configured_admin_controller_can_post(self):
        self.assertNotEqual(self.admin.id, self.guild.owner_id)
        self.invoke()
        self.channel.send.assert_awaited_once()

    def test_server_owner_is_authorized_without_explicit_admin_bit(self):
        self.admin.id = OWNER
        self.client.settings = Settings("offline-test-token", SERVER, OWNER)
        self.interaction.permissions.administrator = False
        self.invoke()
        self.channel.send.assert_awaited_once()

    def test_server_owner_can_manage_defaults_without_explicit_admin_bit(self):
        self.admin.id = OWNER
        self.client.settings = Settings("offline-test-token", SERVER, OWNER)
        self.interaction.permissions.administrator = False
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])

    def test_settings_load_requires_controller_identity(self):
        path = Path(self.temp.name) / "config.json"
        path.write_text(json.dumps({"bot_token": "offline-test-token", "server_id": str(SERVER)}), encoding="utf-8")
        with self.assertRaises(ValueError):
            Settings.load(path)

    def test_legacy_owner_setting_migrates_to_controller(self):
        path = Path(self.temp.name) / "config.json"
        path.write_text(json.dumps({"bot_token": "offline-test-token", "server_id": str(SERVER),
                                    "owner_user_id": str(ADMIN)}), encoding="utf-8")
        self.assertEqual(Settings.load(path), Settings("offline-test-token", SERVER, ADMIN))

    def test_regular_member_cannot_post(self):
        self.interaction.permissions.administrator = False
        self.invoke()
        self.assert_no_post("Administrator")
        self.interaction.response.defer.assert_not_awaited()
        self.assertTrue(self.interaction.response.send_message.call_args.kwargs["ephemeral"])

    def test_role_named_admin_does_not_grant_access(self):
        self.interaction.permissions.administrator = False
        self.admin.roles = [SimpleNamespace(name="Admin")]
        self.invoke()
        self.assert_no_post("Administrator")

    def test_regular_member_cannot_change_or_view_any_settings(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.interaction.permissions.administrator = False
        for operation, kwargs in [("add", {"target": self.make_role()}),
                                  ("remove", {"target": self.target}), ("list", {}), ("clear", {})]:
            with self.subTest(operation=operation):
                self.interaction.response.send_message.reset_mock()
                self.settings(operation, **kwargs)
                self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])
                self.assertIn("administrator", self.response_text().casefold())
                self.assertTrue(self.interaction.response.send_message.call_args.kwargs["ephemeral"])

    def test_wrong_server_post_is_rejected(self):
        self.interaction.guild_id = SERVER + 1
        self.invoke()
        self.assert_no_post("configured server")

    def test_wrong_server_settings_are_rejected(self):
        self.interaction.guild_id = SERVER + 1
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, [])
        self.assertIn("configured server", self.response_text().casefold())

    def test_dm_is_rejected(self):
        self.interaction.guild = None
        self.interaction.guild_id = None
        self.invoke()
        self.assert_no_post("configured server")

    def test_no_defaults_and_no_explicit_target_is_actionable(self):
        self.invoke(target=None)
        self.assert_no_post("/settings")

    def test_saved_user_and_role_are_pinged_without_explicit_target(self):
        role = self.make_role()
        self.save_defaults(SavedTarget("user", TARGET), SavedTarget("role", role.id))
        self.invoke(target=None)
        payload = self.channel.send.call_args.kwargs
        self.assertEqual(payload["content"], f"{self.target.mention} {role.mention}")
        self.assertEqual(payload["allowed_mentions"].to_dict(), {"users": [TARGET], "roles": [role.id], "parse": []})

    def test_defaults_and_extra_target_only_are_allowed_despite_caption_injections(self):
        role = self.make_role()
        self.save_defaults(SavedTarget("role", role.id))
        caption = "@everyone @here <@999> <@&888>"
        self.invoke(caption=caption)
        self.interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        payload = self.channel.send.call_args.kwargs
        self.assertIn(self.target.mention, payload["content"])
        self.assertIn(role.mention, payload["content"])
        self.assertIn(caption, payload["content"])
        self.assertEqual(payload["allowed_mentions"].to_dict(), {"users": [TARGET], "roles": [role.id], "parse": []})
        self.assertTrue(self.upload.fp.closed)

    def test_explicit_target_already_saved_is_not_duplicated(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.invoke()
        payload = self.channel.send.call_args.kwargs
        self.assertEqual(payload["content"].count(self.target.mention), 1)
        self.assertEqual(payload["allowed_mentions"].to_dict(), {"users": [TARGET], "roles": [], "parse": []})

    def test_uncached_saved_member_is_fetched_after_deferring(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.members.clear()
        events = []
        self.interaction.response.defer.side_effect = lambda **kwargs: events.append("deferred")
        def fetch(member_id):
            events.append("fetch")
            return self.target
        self.guild.fetch_member.side_effect = fetch
        self.invoke(target=None)
        self.assertEqual(events, ["deferred", "fetch"])
        self.guild.fetch_member.assert_awaited_once_with(TARGET)
        self.channel.send.assert_awaited_once()

    def test_deleted_saved_role_is_not_silently_omitted(self):
        self.save_defaults(SavedTarget("role", ROLE))
        self.invoke(target=None)
        self.assert_no_post()
        self.assertIn(str(ROLE), self.response_text())
        self.assertIn("/settings", self.response_text())

    def test_departed_saved_member_is_not_silently_omitted(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.members.clear()
        self.guild.fetch_member.side_effect = http_error(discord.NotFound, 404)
        self.invoke(target=None)
        self.assert_no_post()
        self.assertIn(str(TARGET), self.response_text())
        self.assertIn("/settings", self.response_text())

    def test_member_lookup_failure_does_not_post(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.members.clear()
        self.guild.fetch_member.side_effect = http_error(discord.Forbidden, 403)
        self.invoke(target=None)
        self.assert_no_post()
        self.assertTrue(self.interaction.edit_original_response.await_count)

    def test_saved_member_without_channel_access_blocks_post(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.target_permissions.view_channel = False
        self.invoke(target=None)
        self.assert_no_post("cannot see")

    def test_thread_does_not_inherit_command_channel_authorization(self):
        self.interaction.channel = MagicMock(spec=discord.Thread)
        self.interaction.channel.id = COMMAND_CHANNEL + 100
        self.interaction.channel_id = COMMAND_CHANNEL + 100
        self.invoke()
        self.assert_no_post()

    def test_post_has_no_channel_override(self):
        with self.assertRaises(TypeError):
            self.invoke(channel=self.command_channel)
        self.assert_no_post()

    def test_admin_cannot_post_to_hidden_destination(self):
        self.admin_channel_permissions.view_channel = False
        self.invoke()
        self.assert_no_post("cannot see")

    def test_target_cannot_view_destination(self):
        self.target_permissions.view_channel = False
        self.invoke()
        self.assert_no_post("cannot see")

    def test_missing_bot_attachment_permission(self):
        self.bot_permissions.attach_files = False
        self.invoke()
        self.assert_no_post("attach files")

    def test_everyone_role_is_rejected_even_with_mention_permission(self):
        role = self.make_role(SERVER)
        role.is_default.return_value = True
        self.bot_permissions.mention_everyone = True
        self.invoke(target=role)
        self.assert_no_post("@everyone")

    def test_unmentionable_role_is_rejected_without_permission(self):
        role = self.make_role()
        role.mentionable = False
        self.invoke(target=role)
        self.assert_no_post("mentionable")

    def test_unmentionable_role_works_with_permission(self):
        role = self.make_role()
        role.mentionable = False
        self.bot_permissions.mention_everyone = True
        self.invoke(target=role)
        self.assertEqual(self.channel.send.call_args.kwargs["allowed_mentions"].to_dict(), {"users": [], "roles": [role.id], "parse": []})

    def test_wrong_guild_member_is_rejected(self):
        self.target.guild = SimpleNamespace(id=SERVER + 1)
        self.invoke()
        self.assert_no_post()

    def test_wrong_guild_role_is_rejected(self):
        role = self.make_role()
        role.guild = SimpleNamespace(id=SERVER + 1)
        self.invoke(target=role)
        self.assert_no_post()

    def test_non_image_upload_is_rejected(self):
        self.photo.content_type = "application/pdf"
        self.invoke()
        self.assert_no_post("JPG, PNG, GIF, or WebP")

    def test_missing_image_type_is_rejected(self):
        self.photo.content_type = None
        self.invoke()
        self.assert_no_post("JPG, PNG, GIF, or WebP")

    def test_guild_upload_limit_is_enforced(self):
        self.photo.size = self.guild.filesize_limit + 1
        self.interaction.filesize_limit = 100 * 1024 * 1024
        self.invoke()
        self.assert_no_post("too large")

    def test_absolute_upload_limit_is_enforced(self):
        self.guild.filesize_limit = 100 * 1024 * 1024
        self.photo.size = MAX_PHOTO_BYTES + 1
        self.invoke()
        self.assert_no_post("too large")

    def test_long_caption_is_rejected(self):
        self.invoke(caption="x" * 1801)
        self.assert_no_post("caption")

    def test_composed_message_limit_includes_all_saved_mentions(self):
        roles = [self.make_role(ROLE + index) for index in range(MAX_SAVED_TARGETS)]
        self.save_defaults(*(SavedTarget("role", role.id) for role in roles))
        self.invoke(target=None, caption="x" * 1800)
        self.assert_no_post("caption")

    def test_spoiler_status_is_preserved(self):
        self.photo.is_spoiler.return_value = True
        self.invoke()
        self.photo.to_file.assert_awaited_once_with(spoiler=True)

    def test_download_failure_produces_private_error(self):
        self.photo.to_file.side_effect = http_error()
        self.invoke()
        self.channel.send.assert_not_awaited()
        self.assertIn("Could not download", self.response_text())

    def test_forbidden_send_produces_private_error_and_closes_upload(self):
        self.channel.send.side_effect = http_error(discord.Forbidden, 403)
        self.invoke()
        self.assertIn("Discord blocked", self.response_text())
        self.assertTrue(self.upload.fp.closed)

    def test_http_send_failure_produces_private_error_and_closes_upload(self):
        self.channel.send.side_effect = http_error()
        self.invoke()
        self.assertIn("could not accept", self.response_text())
        self.assertTrue(self.upload.fp.closed)

    def test_receipt_failure_does_not_repost(self):
        self.interaction.edit_original_response.side_effect = http_error()
        self.invoke()
        self.channel.send.assert_awaited_once()
        self.interaction.edit_original_response.assert_awaited_once()

    def test_settings_add_user_persists_without_pinging(self):
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])
        self.assertTrue(self.preferences_path.exists())
        self.assert_private_settings_reply()
        reloaded = PhotoBot(self.bot_settings, preferences_path=self.preferences_path, routing_path=self.routing_path)
        self.assertEqual(reloaded.preferences.targets, [SavedTarget("user", TARGET)])

    def test_settings_add_role_and_avoid_duplicates(self):
        role = self.make_role()
        self.settings("add", target=role)
        self.interaction.response.send_message.reset_mock()
        self.settings("add", target=role)
        self.assertEqual(self.client.preferences.targets, [SavedTarget("role", ROLE)])
        self.assert_private_settings_reply()

    def test_settings_cannot_add_everyone(self):
        role = self.make_role(SERVER)
        role.is_default.return_value = True
        self.settings("add", target=role)
        self.assertEqual(self.client.preferences.targets, [])
        self.assertIn("@everyone", self.response_text())

    def test_settings_cannot_add_another_guild_member(self):
        self.target.guild = SimpleNamespace(id=SERVER + 1)
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, [])

    def test_settings_saved_target_limit_is_enforced(self):
        original = [SavedTarget("role", ROLE + index) for index in range(MAX_SAVED_TARGETS)]
        self.save_defaults(*original)
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, original)
        self.assertIn(str(MAX_SAVED_TARGETS), self.response_text())

    def test_settings_list_is_private_and_does_not_ping(self):
        self.save_defaults(SavedTarget("user", TARGET), SavedTarget("role", ROLE))
        self.settings("list")
        self.assertIn(str(TARGET), self.response_text())
        self.assertIn(str(ROLE), self.response_text())
        self.assert_private_settings_reply()

    def test_settings_remove_by_target(self):
        self.save_defaults(SavedTarget("user", TARGET), SavedTarget("role", ROLE))
        self.settings("remove", target=self.target)
        self.assertEqual(self.client.preferences.targets, [SavedTarget("role", ROLE)])
        self.assert_private_settings_reply()

    def test_settings_remove_missing_member_by_id(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.settings("remove", target_id=str(TARGET))
        self.assertEqual(self.client.preferences.targets, [])
        self.assert_private_settings_reply()

    def test_settings_remove_requires_exactly_one_selector(self):
        self.save_defaults(SavedTarget("user", TARGET))
        for kwargs in [{}, {"target": self.target, "target_id": str(TARGET)}]:
            with self.subTest(kwargs=kwargs):
                self.interaction.response.send_message.reset_mock()
                self.settings("remove", **kwargs)
                self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])

    def test_settings_remove_invalid_id_is_private_error(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.settings("remove", target_id="not-an-id")
        self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])
        self.assert_private_settings_reply()

    def test_settings_clear_persists_empty_defaults(self):
        self.save_defaults(SavedTarget("user", TARGET))
        self.settings("clear")
        self.assertEqual(self.client.preferences.targets, [])
        self.assert_private_settings_reply()
        reloaded = PhotoBot(self.bot_settings, preferences_path=self.preferences_path, routing_path=self.routing_path)
        self.assertEqual(reloaded.preferences.targets, [])

    def test_failed_settings_save_keeps_previous_defaults(self):
        original = [SavedTarget("user", TARGET)]
        self.save_defaults(*original)
        role = self.make_role()
        with patch.object(self.client.preferences, "commit", side_effect=PermissionError("Offline denied write")):
            self.settings("add", target=role)
        self.assertEqual(self.client.preferences.targets, original)
        self.assertIn("save", self.response_text().casefold())
        self.assert_private_settings_reply()

    def test_explicit_controller_setting_loads(self):
        path = Path(self.temp.name) / "config.json"
        path.write_text(json.dumps({"bot_token": "offline-test-token", "server_id": str(SERVER),
                                    "controller_user_id": str(ADMIN)}), encoding="utf-8")
        self.assertEqual(Settings.load(path), self.bot_settings)

    def test_explicit_controller_setting_takes_precedence_over_legacy_owner(self):
        path = Path(self.temp.name) / "config.json"
        path.write_text(json.dumps({"bot_token": "offline-test-token", "server_id": str(SERVER),
                                    "controller_user_id": str(ADMIN), "owner_user_id": str(OWNER)}), encoding="utf-8")
        self.assertEqual(Settings.load(path), self.bot_settings)

    def test_invalid_controller_setting_fails_closed(self):
        path = Path(self.temp.name) / "config.json"
        for invalid in [None, "", "not-a-user-id", "0", "-123", True]:
            with self.subTest(invalid=invalid):
                path.write_text(json.dumps({"bot_token": "offline-test-token", "server_id": str(SERVER),
                                            "controller_user_id": invalid}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    Settings.load(path)

    def test_other_admin_cannot_post_even_in_command_channel(self):
        self.admin.id = ADMIN + 100
        self.invoke()
        self.assert_no_post("controller")
        self.interaction.response.defer.assert_not_awaited()

    def test_server_owner_cannot_bypass_configured_controller(self):
        self.admin.id = OWNER
        self.interaction.permissions.administrator = False
        self.invoke()
        self.assert_no_post("controller")

    def test_other_admin_cannot_access_any_settings(self):
        self.save_defaults(SavedTarget("user", TARGET))
        original_routing = self.client.routing.routing
        self.admin.id = ADMIN + 100
        operations = [("add", {"target": self.make_role()}), ("remove", {"target": self.target}),
                      ("list", {}), ("clear", {}),
                      ("channels", {"command_channel": self.command_channel, "post_channel": self.channel})]
        for operation, kwargs in operations:
            with self.subTest(operation=operation):
                self.interaction.response.send_message.reset_mock()
                self.settings(operation, **kwargs)
                self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])
                self.assertEqual(self.client.routing.routing, original_routing)
                self.assertIn("controller", self.response_text().casefold())
                self.assert_private_settings_reply()

    def test_controller_cannot_post_outside_command_channel(self):
        self.interaction.channel_id = POST_CHANNEL
        self.interaction.channel = self.channel
        self.invoke()
        self.assert_no_post("command channel")

    def test_all_settings_are_rejected_outside_command_channel(self):
        self.save_defaults(SavedTarget("user", TARGET))
        original_routing = self.client.routing.routing
        self.interaction.channel_id = POST_CHANNEL
        self.interaction.channel = self.channel
        operations = [("add", {"target": self.make_role()}), ("remove", {"target": self.target}),
                      ("list", {}), ("clear", {}),
                      ("channels", {"command_channel": self.command_channel, "post_channel": self.channel})]
        for operation, kwargs in operations:
            with self.subTest(operation=operation):
                self.interaction.response.send_message.reset_mock()
                self.settings(operation, **kwargs)
                self.assertEqual(self.client.preferences.targets, [SavedTarget("user", TARGET)])
                self.assertEqual(self.client.routing.routing, original_routing)
                self.assertIn("command channel", self.response_text().casefold())

    def test_unconfigured_routes_block_post_without_fallback(self):
        self.client.routing.routing = None
        self.invoke()
        self.assert_no_post("/settings channels")
        self.interaction.response.defer.assert_not_awaited()

    def test_unconfigured_routes_block_ping_settings(self):
        self.client.routing.routing = None
        self.settings("add", target=self.target)
        self.assertEqual(self.client.preferences.targets, [])
        self.assertIn("/settings channels", self.response_text())

    def test_first_channel_setup_works_for_configured_controller(self):
        self.client.routing.routing = None
        self.interaction.channel_id = POST_CHANNEL + 100
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, ChannelRouting(COMMAND_CHANNEL, POST_CHANNEL))
        self.assert_private_settings_reply()
        self.command_channel.send.assert_not_awaited()
        self.channel.send.assert_not_awaited()

    def test_first_channel_setup_cannot_be_claimed_by_other_admin(self):
        self.client.routing.routing = None
        self.admin.id = ADMIN + 100
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertIsNone(self.client.routing.routing)
        self.assertIn("controller", self.response_text().casefold())

    def test_first_channel_setup_requires_controller_to_be_admin(self):
        self.client.routing.routing = None
        self.interaction.permissions.administrator = False
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertIsNone(self.client.routing.routing)
        self.assertIn("administrator", self.response_text().casefold())

    def test_post_uses_only_designated_output(self):
        self.invoke()
        self.channel.send.assert_awaited_once()
        self.command_channel.send.assert_not_awaited()
        self.client.get_channel.assert_called_once_with(POST_CHANNEL)

    def test_missing_saved_output_does_not_fallback_to_command_channel(self):
        self.client.get_channel.side_effect = lambda channel_id: None
        self.invoke()
        self.assert_no_post("/settings channels")

    def test_thread_saved_output_is_rejected_without_fallback(self):
        self.client.get_channel.side_effect = lambda channel_id: MagicMock(spec=discord.Thread)
        self.invoke()
        self.assert_no_post("/settings channels")

    def test_wrong_guild_saved_output_is_rejected(self):
        self.channel.guild = SimpleNamespace(id=SERVER + 100)
        self.invoke()
        self.assert_no_post("configured server")

    def test_channel_settings_survive_restart(self):
        reloaded = PhotoBot(self.bot_settings, preferences_path=self.preferences_path, routing_path=self.routing_path)
        self.assertEqual(reloaded.routing.routing, ChannelRouting(COMMAND_CHANNEL, POST_CHANNEL))

    def test_setup_rejects_same_command_and_output_channel(self):
        before = self.client.routing.routing
        self.settings("channels", command_channel=self.command_channel, post_channel=self.command_channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("different", self.response_text().casefold())

    def test_setup_rejects_foreign_guild_channels(self):
        before = self.client.routing.routing
        self.channel.guild = SimpleNamespace(id=SERVER + 100)
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("configured server", self.response_text().casefold())

    def test_setup_rejects_thread_channel(self):
        before = self.client.routing.routing
        self.settings("channels", command_channel=MagicMock(spec=discord.Thread), post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("text channels", self.response_text().casefold())

    def test_setup_rejects_hidden_command_channel(self):
        before = self.client.routing.routing
        self.command_admin_permissions.view_channel = False
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("can see", self.response_text().casefold())

    def test_setup_rejects_inaccessible_command_channel_for_bot(self):
        before = self.client.routing.routing
        self.command_bot_permissions.view_channel = False
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("view channel", self.response_text().casefold())

    def test_setup_rejects_output_without_attachment_permission(self):
        before = self.client.routing.routing
        self.bot_permissions.attach_files = False
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("attach files", self.response_text().casefold())

    def test_channel_save_failure_preserves_previous_routes(self):
        before = self.client.routing.routing
        with patch.object(self.client.routing, "commit", side_effect=PermissionError("Offline denied write")):
            self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, before)
        self.assertIn("could not save", self.response_text().casefold())
        self.assert_private_settings_reply()

    def test_route_changes_take_effect_immediately(self):
        new_command_id = COMMAND_CHANNEL + 100
        new_post_id = POST_CHANNEL + 100
        self.command_channel.id = new_command_id
        self.channel.id = new_post_id
        self.settings("channels", command_channel=self.command_channel, post_channel=self.channel)
        self.assertEqual(self.client.routing.routing, ChannelRouting(new_command_id, new_post_id))
        self.interaction.response.send_message.reset_mock()
        self.invoke()
        self.assert_no_post("command channel")


if __name__ == "__main__":
    unittest.main(verbosity=2)
