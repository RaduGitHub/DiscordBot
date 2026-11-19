"""Private-channel photo commands for one administrator. See README.md."""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import discord
from discord import app_commands

from preferences import MAX_SAVED_TARGETS, SavedTarget, TargetStore
from routing import ChannelRouting, RoutingStore

LOGGER = logging.getLogger("photo_bot")
CONFIG_PATH = Path(__file__).with_name("config.json")
MAX_PHOTO_BYTES = 25 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


async def private_reply(interaction: discord.Interaction, message: str):
    await interaction.response.send_message(
        message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none()
    )


@dataclass(frozen=True)
class Settings:
    token: str
    server_id: int
    controller_user_id: int

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "Settings":
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            raise ValueError("Copy config.example.json to config.json and fill in its three values.") from None
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("Cannot read config.json. Keep the JSON quotes, commas, and braces intact.") from None
        if not isinstance(data, dict):
            raise ValueError("config.json must contain the object shown in config.example.json.")
        token = data.get("bot_token")
        if not isinstance(token, str) or not token.strip() or token.strip().startswith("PASTE_"):
            raise ValueError("Fill in bot_token using the token from Developer Portal > Bot.")
        value = str(data.get("server_id", "")).strip()
        if not value.isascii() or not value.isdigit() or int(value) <= 0:
            raise ValueError("Fill in server_id with your numeric Discord server ID, inside quotes.")
        controller = str(data.get("controller_user_id", data.get("owner_user_id", ""))).strip()
        if not controller.isascii() or not controller.isdigit() or not 0 < int(controller) < 2**64:
            raise ValueError("Add controller_user_id to config.json using your personal numeric Discord user ID, inside quotes.")
        return cls(token=token.strip(), server_id=int(value), controller_user_id=int(controller))


class PhotoBot(discord.Client):
    def __init__(
        self, settings: Settings, preferences_path: Optional[Path] = None,
        routing_path: Optional[Path] = None,
    ):
        intents = discord.Intents.none()
        intents.guilds = True
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.settings = settings
        self.preferences = TargetStore(
            preferences_path if preferences_path is not None else Path(__file__).with_name("ping-settings.json"),
            settings.server_id,
        )
        self.routing = RoutingStore(
            routing_path if routing_path is not None else Path(__file__).with_name("channel-settings.json"),
            settings.server_id,
        )
        self.tree = app_commands.CommandTree(self)
        self.server = discord.Object(id=settings.server_id)
        self.tree.add_command(app_commands.Command(
            name="post", description="Send a photo and saved pings to your configured post channel.",
            callback=self.post_photo,
        ), guild=self.server)
        group = app_commands.Group(
            name="settings", description="Set the command channel, post channel, and automatic pings.",
            guild_only=True, default_permissions=discord.Permissions(administrator=True),
        )
        for name, description, callback in (
            ("channels", "Choose the command channel and the separate photo destination.", self.set_channels),
            ("add", "Add a user or role to every photo post.", self.add_target),
            ("remove", "Remove a saved user or role.", self.remove_target),
            ("list", "Show saved users and roles without pinging them.", self.list_targets),
            ("clear", "Remove all saved automatic pings.", self.clear_targets),
        ):
            group.add_command(app_commands.Command(name=name, description=description, callback=callback))
        self.tree.add_command(group, guild=self.server)
        self.tree.on_error = self.command_error

    async def setup_hook(self):
        await self.tree.sync(guild=self.server)

    async def on_ready(self):
        if self.get_guild(self.settings.server_id) is None:
            LOGGER.error("The configured server is unavailable. Check server_id and the bot's invitation.")
            await self.close()
            return
        print(f"\nReady! Logged in as {self.user}.", flush=True)
        if self.routing.routing is None:
            print("Setup: your configured controller must run /settings channels to choose both channels.", flush=True)
        else:
            print(f"Commands: channel {self.routing.routing.command_channel_id}; photos: channel {self.routing.routing.post_channel_id}.", flush=True)
        print("Only the configured controller can use the commands, and must still be a server admin.", flush=True)
        print("Keep this window open. Press Ctrl+C to stop the bot.\n", flush=True)

    async def authorize_admin(self, interaction: discord.Interaction, *, allow_unconfigured: bool = False) -> bool:
        if interaction.guild_id != self.settings.server_id or interaction.guild is None:
            await private_reply(interaction, "Use this command inside the configured server.")
            return False
        if interaction.user.id != self.settings.controller_user_id:
            await private_reply(interaction, "This bot only accepts commands from its configured controller.")
            return False
        if not isinstance(interaction.user, discord.Member) or (
            interaction.user.id != interaction.guild.owner_id and not interaction.permissions.administrator
        ):
            await private_reply(interaction, "Only the server owner or members with Administrator permission can use this bot.")
            return False
        routing = self.routing.routing
        if routing is None:
            if not allow_unconfigured:
                await private_reply(interaction, "Choose your channels first: /settings channels command_channel:#bot-control post_channel:#photos.")
                return False
        elif interaction.channel_id != routing.command_channel_id:
            await private_reply(interaction, "Use this bot's configured command channel.")
            return False
        return True

    @app_commands.describe(
        command_channel="The channel where only your commands will be accepted",
        post_channel="A different channel where every /post message will be sent",
    )
    async def set_channels(
        self, interaction: discord.Interaction,
        command_channel: discord.TextChannel, post_channel: discord.TextChannel,
    ):
        if not await self.authorize_admin(interaction, allow_unconfigured=True):
            return
        if not all(isinstance(channel, discord.TextChannel) for channel in (command_channel, post_channel)):
            await private_reply(interaction, "Choose two normal text channels; threads and forum posts are not supported.")
            return
        if any(channel.guild.id != self.settings.server_id for channel in (command_channel, post_channel)):
            await private_reply(interaction, "Choose channels in the configured server.")
            return
        if command_channel.id == post_channel.id:
            await private_reply(interaction, "The command channel and post channel must be different.")
            return
        if any(not channel.permissions_for(interaction.user).view_channel for channel in (command_channel, post_channel)):
            await private_reply(interaction, "Choose channels you can see.")
            return
        bot_member = interaction.guild.me
        if bot_member is None:
            await private_reply(interaction, "The bot is still connecting. Try again shortly.")
            return
        for channel, required in (
            (command_channel, ("view_channel", "send_messages")),
            (post_channel, ("view_channel", "send_messages", "attach_files")),
        ):
            permissions = channel.permissions_for(bot_member)
            missing = [name.replace("_", " ") for name in required if not getattr(permissions, name)]
            if missing:
                await private_reply(interaction, f"Give the bot these permissions in {channel.mention}: " + ", ".join(missing) + ".")
                return
        try:
            self.routing.commit(ChannelRouting(command_channel.id, post_channel.id))
        except OSError:
            await private_reply(interaction, "Could not save the channel settings. The previous channels were not changed; check folder permissions.")
            return
        await private_reply(
            interaction,
            f"Saved. Run your commands in {command_channel.mention}. Every /post sends only to {post_channel.mention}.",
        )

    def target_record(self, target: Union[discord.Member, discord.Role]) -> SavedTarget:
        if not isinstance(target, (discord.Member, discord.Role)) or target.guild.id != self.settings.server_id:
            raise ValueError("Choose a person or role from this server.")
        if isinstance(target, discord.Role):
            if target.is_default():
                raise ValueError("Choose a server role other than @everyone.")
            return SavedTarget("role", target.id)
        return SavedTarget("user", target.id)

    @app_commands.describe(target="A person or role to ping on every photo post")
    async def add_target(self, interaction: discord.Interaction, target: Union[discord.Member, discord.Role]):
        if not await self.authorize_admin(interaction):
            return
        try:
            record = self.target_record(target)
        except ValueError as error:
            await private_reply(interaction, str(error))
            return
        if record in self.preferences.targets:
            await private_reply(interaction, "That target is already saved. Use /settings list to see all automatic pings.")
            return
        if len(self.preferences.targets) >= MAX_SAVED_TARGETS:
            await private_reply(interaction, f"You can save up to {MAX_SAVED_TARGETS} targets. Remove one first.")
            return
        if not await self.save_targets(interaction, [*self.preferences.targets, record]):
            return
        await private_reply(interaction, f"Saved {target.mention}. Every /post will include this target.")

    @app_commands.describe(
        target="The saved person or role to remove",
        target_id="Alternatively paste an ID from /settings list; also works for deleted targets",
    )
    async def remove_target(
        self, interaction: discord.Interaction,
        target: Optional[Union[discord.Member, discord.Role]] = None,
        target_id: Optional[str] = None,
    ):
        if not await self.authorize_admin(interaction):
            return
        if (target is None) == (target_id is None):
            await private_reply(interaction, "Choose either target or target_id to remove one saved ping.")
            return
        if target is not None:
            try:
                selected = self.target_record(target)
            except ValueError as error:
                await private_reply(interaction, str(error))
                return
            remaining = [item for item in self.preferences.targets if item != selected]
        else:
            value = target_id.strip()
            if not value.isascii() or not value.isdigit() or int(value) <= 0:
                await private_reply(interaction, "Use a numeric target_id from /settings list.")
                return
            remaining = [item for item in self.preferences.targets if item.id != int(value)]
        if len(remaining) == len(self.preferences.targets):
            await private_reply(interaction, "That target is not in the saved list.")
            return
        if await self.save_targets(interaction, remaining):
            await private_reply(interaction, "Removed that target from automatic pings.")

    async def list_targets(self, interaction: discord.Interaction):
        if not await self.authorize_admin(interaction):
            return
        routing = self.routing.routing
        channels = f"Command channel: <#{routing.command_channel_id}>\nPost channel: <#{routing.post_channel_id}>\n\n"
        if not self.preferences.targets:
            await private_reply(interaction, channels + "No automatic pings saved yet. Use /settings add target:@someone or target:@role.")
            return
        lines = ["Saved automatic pings (included on every /post):"]
        for item in self.preferences.targets:
            mention = f"<@&{item.id}>" if item.kind == "role" else f"<@{item.id}>"
            lines.append(f"- {mention} — {item.kind} ID: `{item.id}`")
        await private_reply(interaction, channels + "\n".join(lines))

    async def clear_targets(self, interaction: discord.Interaction):
        if not await self.authorize_admin(interaction):
            return
        if await self.save_targets(interaction, []):
            await private_reply(interaction, "Cleared all automatic pings. Add new defaults or select a target on an individual /post.")

    async def save_targets(self, interaction: discord.Interaction, targets: list[SavedTarget]) -> bool:
        try:
            self.preferences.commit(targets)
        except OSError:
            await private_reply(interaction, "Could not save the settings file. The saved pings were not changed; check folder permissions.")
            return False
        return True

    async def resolve_targets(self, guild: discord.Guild, extra: Optional[Union[discord.Member, discord.Role]]):
        direct_record = self.target_record(extra) if extra is not None else None
        records = list(self.preferences.targets)
        if direct_record is not None and direct_record not in records:
            records.append(direct_record)
        resolved = []
        for record in records:
            if record == direct_record:
                selected = extra
            elif record.kind == "role":
                selected = guild.get_role(record.id)
                if selected is None:
                    raise ValueError(f"Saved role {record.id} no longer exists. Remove it with /settings remove target_id:{record.id}.")
            else:
                selected = guild.get_member(record.id)
                if selected is None:
                    try:
                        selected = await guild.fetch_member(record.id)
                    except discord.NotFound:
                        raise ValueError(f"Saved user {record.id} is no longer in the server. Remove it with /settings remove target_id:{record.id}.") from None
                    except discord.HTTPException:
                        raise ValueError("Could not check a saved user's server membership. Check the connection and try again.") from None
            resolved.append(selected)
        return resolved

    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    @app_commands.describe(
        photo="Upload a JPG, PNG, GIF, or WebP photo",
        target="Optional extra person or role; saved automatic pings are still included",
        caption="Optional text below the pings (up to 1800 characters, space permitting)",
    )
    async def post_photo(
        self, interaction: discord.Interaction, photo: discord.Attachment,
        target: Optional[Union[discord.Member, discord.Role]] = None,
        caption: Optional[str] = None,
    ):
        if not await self.authorize_admin(interaction):
            return
        if not self.preferences.targets and target is None:
            await private_reply(interaction, "Save users or roles with /settings add, or choose a target for this photo.")
            return
        destination = self.get_channel(self.routing.routing.post_channel_id)
        if not isinstance(destination, discord.TextChannel):
            await private_reply(interaction, "The saved post channel is unavailable. Fix its permissions or choose a new one with /settings channels.")
            return
        if destination.guild.id != self.settings.server_id:
            await private_reply(interaction, "The saved post channel is not in the configured server. Update /settings channels.")
            return
        if not destination.permissions_for(interaction.user).view_channel:
            await private_reply(interaction, "You cannot see the saved post channel. Fix permissions or update /settings channels.")
            return
        bot_member = interaction.guild.me
        if bot_member is None:
            await private_reply(interaction, "The bot is still connecting. Try again shortly.")
            return
        permissions = destination.permissions_for(bot_member)
        required = ("view_channel", "send_messages", "attach_files")
        missing = [name.replace("_", " ") for name in required if not getattr(permissions, name)]
        if missing:
            await private_reply(interaction, "Give the bot these permissions in the destination channel: " + ", ".join(missing) + ".")
            return
        if (photo.content_type or "").split(";", 1)[0].lower() not in IMAGE_TYPES:
            await private_reply(interaction, "Please upload a JPG, PNG, GIF, or WebP image.")
            return
        size_limit = min(interaction.guild.filesize_limit, MAX_PHOTO_BYTES)
        if photo.size > size_limit:
            await private_reply(interaction, f"That photo is too large. Use an image under {size_limit / (1024 * 1024):g} MiB.")
            return
        caption = (caption or "").strip()
        if len(caption) > 1800:
            await private_reply(interaction, "Keep the caption under 1801 characters.")
            return

        # Acknowledge before HTTP member lookups as well as the attachment upload.
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            targets = await self.resolve_targets(interaction.guild, target)
            users, roles = [], []
            for selected in targets:
                record = self.target_record(selected)
                if record.kind == "role":
                    if not selected.mentionable and not permissions.mention_everyone:
                        raise ValueError(
                            f"Role {selected.id} is not mentionable. Make that role mentionable in Server Settings > Roles, "
                            "or give the bot 'Mention @everyone, @here, and All Roles' in the destination channel."
                        )
                    roles.append(selected)
                else:
                    if not destination.permissions_for(selected).view_channel:
                        raise ValueError(f"Person {selected.id} cannot see the destination channel. Update /settings channels or remove that saved ping.")
                    users.append(selected)
            content = " ".join(selected.mention for selected in targets) + ("\n" + caption if caption else "")
            if len(content) > 2000:
                raise ValueError("The pings and caption exceed Discord's 2000-character limit. Shorten the caption or remove some saved pings.")
        except ValueError as error:
            await interaction.edit_original_response(content=str(error))
            return
        mentions = discord.AllowedMentions(everyone=False, roles=roles, users=users, replied_user=False)
        try:
            upload = await photo.to_file(spoiler=photo.is_spoiler())
        except discord.HTTPException:
            await interaction.edit_original_response(content="Could not download that photo. Upload it again and retry.")
            return
        try:
            sent = await destination.send(content=content, file=upload, allowed_mentions=mentions)
        except discord.Forbidden:
            await interaction.edit_original_response(content="Discord blocked the post. Check the bot's View Channel, Send Messages, and Attach Files permissions.")
            return
        except discord.HTTPException as error:
            LOGGER.warning("Discord rejected the upload (status %s, code %s).", error.status, error.code)
            await interaction.edit_original_response(content="Discord could not accept the photo. Check the channel and try a smaller image.")
            return
        finally:
            upload.close()
            upload.fp.close()
        try:
            await interaction.edit_original_response(content=f"Posted! [Open the photo]({sent.jump_url})")
        except discord.HTTPException:
            LOGGER.warning("The photo was posted, but its private confirmation could not be delivered.")

    async def command_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError):
        LOGGER.error("Command failed.", exc_info=(type(error), error, error.__traceback__))
        message = "The command encountered an error. Check the bot window. If the photo already appeared, do not repost it."
        try:
            if interaction.response.is_done():
                await interaction.edit_original_response(content=message)
            else:
                await private_reply(interaction, message)
        except discord.HTTPException:
            LOGGER.warning("Could not send the command error to Discord.")


def main():
    try:
        settings = Settings.load()
        client = PhotoBot(settings)
    except ValueError as error:
        print(f"Setup needed: {error}")
        return 1
    try:
        client.run(settings.token, log_level=logging.INFO)
    except discord.LoginFailure:
        print("Login failed. Check bot_token in config.json; use the token from Developer Portal > Bot.")
        return 1
    except discord.Forbidden:
        print("Discord denied command registration. Check server_id and invite the bot with the bot and applications.commands scopes.")
        return 1
    except discord.HTTPException as error:
        print(f"Discord setup failed (HTTP {error.status}, code {error.code}). Check server_id and the bot's invitation.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
