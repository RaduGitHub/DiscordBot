# Discord Photo Bot

This is the earlier Windows/Python implementation. The active Cloudflare project
is at the [repository root](../../README.md). This folder needs its own local
`config.json`; the repository contains only `config.example.json`.
Stop the Cloudflare integration before switching this Discord application back
to the Windows version, as described in the root README.

Send `/post` commands in your control channel, and the bot publishes the photo
in a separate destination channel. Use `/settings` to choose both channels and
the users or roles to ping on every photo post.

## Who can control it

Only the account set in **controller_user_id** can use the bot, including its
settings. That account must also own the server or have Discord's
**Administrator** permission. Other admins cannot control this bot. A role
named "Admin" does not grant access unless it has the Administrator permission.
The bot checks your identity, permissions, and command channel on every command.

The bot itself does not need Administrator permission. It responds to slash
commands such as `/post`; it does not watch ordinary chat messages or DMs.

## First-time setup

Extract the ZIP, then double-click `START-BOT.bat`. On its first run, it creates
`config.json` and opens it in Notepad. Replace the three placeholders, keep the
surrounding quotes, save the file, and close Notepad. Press a key in the bot
window to continue.

- **bot_token:** Developer Portal > your application > Bot > Reset Token.
  Copy the token into the local file. Do not use the Application ID, Public Key,
  or Client Secret. Keep your token and completed `config.json` private.
- **server_id:** In Discord, enable User Settings > Advanced > Developer Mode.
  Right-click your server's icon and choose **Copy Server ID**.
- **controller_user_id:** With Developer Mode enabled, right-click your own
  profile and choose **Copy User ID**. Use your personal account's ID, not the
  bot's ID. This is the only account whose commands will be accepted.

Example shape (the sample values will not work):

```json
{
  "bot_token": "your-secret-token",
  "server_id": "234567890123456789",
  "controller_user_id": "123456789012345678"
}
```

The launcher creates a local Python environment, installs the dependency, and
runs the bot. It tries your installed Python, then the Python bundled with Codex
on this PC. If neither is found, install Python 3.10 or newer from
https://www.python.org/downloads/ and enable **Add Python to PATH**.

When the console says **Ready!**, use the commands below. Keep the console open
while you want the bot available. Ctrl+C stops it.

## Choose the two channels

Create or choose a command channel, such as `#bot-control`, and a different
photo destination, such as `#photos`. You can make the control channel private
using Discord's channel permissions if you want it hidden from ordinary members;
allow your account and the bot to view it and send messages.

For initial setup, run this as your configured controller in your server:

```text
/settings channels command_channel:#bot-control post_channel:#photos
```

Select each channel from Discord's picker. Both must be normal text channels in
your configured server, and they must be different. The bot needs View Channel
and Send Messages in the command channel, plus Attach Files in the post channel.

Before channels are configured, this is the only command that can run. Once
saved, run **all commands, including settings commands, in `#bot-control`**.
Commands from other accounts, other channels, and threads are rejected.
Every `/post` sends only to `#photos`; there is no per-post destination override.
Confirmation messages and settings replies remain private in the command channel.

To change the channels later, run `/settings channels` from your current command
channel. `/settings list` shows both saved channels. Channel choices are saved
in `channel-settings.json` and survive restarts.

## Choose the automatic pings

Run these in your saved command channel as the controller. Select people or roles from Discord's
target picker; do not type their names as plain text.

| Command | What it does |
| --- | --- |
| `/settings add target:@Members` | Ping the Members role on every photo post. |
| `/settings add target:@Alex` | Also ping Alex on every photo post. |
| `/settings list` | Show saved channels and ping targets, without pinging them. |
| `/settings remove target:@Alex` | Stop automatically pinging Alex. |
| `/settings clear` | Remove all saved automatic pings. |

You can save up to **25 users and roles combined**. Adding an existing target
does not duplicate it. Settings confirmations and lists are private.
`/settings clear` clears only the ping targets; it keeps your channel choices.

The list is saved automatically in `ping-settings.json` beside the script, so
it survives bot restarts. Each successful change takes effect for future
photo posts; it does not change or resend earlier messages.

If someone leaves the server or a role is deleted, `/settings list` still
shows its numeric ID. Remove it with:

```text
/settings remove target_id:123456789012345678
```

Select either **target** or **target_id** when removing an entry.

## Post a photo

In your saved command channel, type `/post`, select the command, and upload an
image in the **photo** field:

```text
/post photo:[attach your image]
```

This posts the photo in the saved **post channel** and pings **all saved users
and roles**. You may add a caption:

```text
/post photo:[attach your image] caption:Here is today's photo!
```

To add a one-time recipient for this post:

```text
/post photo:[attach your image] target:@Someone
```

Saved automatic pings are still included. The extra target does not change
the saved list. If it is already saved, it is mentioned only once. If no
automatic pings are saved, choose a target for each post.

`[attach your image]` means use Discord's file upload picker. It is not text
you enter. The bot posts as itself, with the pings and photo together.
You receive a private confirmation link in the command channel. If the saved
post channel is deleted or unavailable, the bot stops the post and reports the
problem; it does not fall back to posting in your command channel.

## Permissions and limits

- The bot needs **View Channel** and **Send Messages** in the command channel.
  It also needs **View Channel**, **Send Messages**, and **Attach Files** in the
  post channel. Channel permission overrides apply.
- For role pings, enable **Allow anyone to @mention this role** in Server Settings
  > Roles > the role, or grant the bot **Mention @everyone, @here, and All Roles**
  in that channel.
- Only saved targets and the optional selected target can trigger pings.
  Extra mentions in the caption do not ping other people or roles.
  The `@everyone` role is blocked.
- All selected users must be able to see the destination. For roles, use a
  channel their members can see; individual permission overrides can differ.
  The bot checks every target before uploading. If a saved target is missing,
  hidden, or cannot be pinged, it reports the issue privately and does not post.
- Discord's recipient notification settings can suppress push notifications.
- Supported images: JPG/JPEG, PNG, GIF, and WebP. Uploads are limited to the
  smaller of the server's bot upload allowance and 25 MiB. Spoilers stay spoilers.
- Captions can contain up to 1,800 characters. Pings and caption together must
  fit Discord's 2,000-character message limit; shorten the caption if requested.
- Both channels must be normal text channels, including announcement channels.
  Commands in threads, forum posts, and DMs are not supported.
- Message Content Intent and Server Members Intent can stay disabled.
  Individual saved users are looked up when necessary.
- The bot reuploads the attachment and does not save photos to disk.
- Running the launcher does not configure automatic startup or hosting.

## Updating the earlier version

Stop the old bot window with Ctrl+C. Keep your existing `config.json`,
`ping-settings.json`, and `channel-settings.json` if present. Replace the script
files with this version, including **bot.py**, **preferences.py**, and the new
**routing.py**.

Add **controller_user_id** to your local `config.json` using your personal
Discord user ID, as shown in the example above. Keep your existing token and
server ID. An older `owner_user_id` is accepted as a fallback only when
`controller_user_id` is absent. A configuration containing just the token and
server ID must add the controller ID before this version can start.

Restart `START-BOT.bat`, then run `/settings channels` to choose your channels
if they have not been configured yet. Your existing saved ping list is retained.

If you extract the updated ZIP into a different folder, copy your existing
`config.json` there locally. The ZIP intentionally contains only an example
configuration and never includes your token, personal ping list, or saved
channel choices.

## Troubleshooting

- **No commands:** wait for **Ready!**, reopen Discord, and check that you are
  using the controller account with server admin permission. Confirm `server_id` and the `bot` plus
  `applications.commands` install scopes.
- **Permission denied:** use the configured controller account, which must own
  the server or have Administrator permission. Bot command overrides do not
  bypass these checks.
- **Wrong channel:** run commands in the saved command channel. Use
  `/settings list` there to see the saved choices.
- **Command channel deleted or inaccessible:** stop the bot, rename
  `channel-settings.json` to a backup name, and restart. The controller can then
  run `/settings channels` again in the server. Keep `ping-settings.json` to
  retain your automatic pings.
- **Post channel unavailable:** fix its permissions or run `/settings channels`
  in the current command channel to choose another destination.
- **A saved target fails:** use `/settings list`, fix role/channel permissions,
  or remove the target by its ID.
- **Settings cannot be saved:** keep the extracted bot folder in a writable
  location. A failed save leaves the previous automatic ping list unchanged.
- **Saved settings invalid / wrong server:** restore a backup of
  the affected settings file. Alternatively, stop the bot and rename that file
  to start a new list or new channel setup.
- **Bot stays offline:** check the bot window and your token; restart after
  changing `config.json`.
- **Already running another copy:** stop it first to avoid conflicting behavior
  or duplicate posts. Startup synchronizes this application's server commands
  to this version's `/post` and `/settings`.

## Manual startup

Windows PowerShell, from the extracted folder:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe bot.py
```

On macOS/Linux, use `python3 -m venv .venv`, then
`.venv/bin/python -m pip install -r requirements.txt` and
`.venv/bin/python bot.py`.

## References

- Discord setup: https://docs.discord.com/developers/quick-start/getting-started
- discord.py commands and permissions: https://discordpy.readthedocs.io/en/stable/interactions/api.html
- Mention rules: https://docs.discord.com/developers/resources/message#allowed-mentions-object


## Offline tests

From this legacy bot folder, install the pinned dependency and run:

```powershell
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p "test_*.py"
```

The tests use simulated Discord calls and temporary files under `tests/.local/`.
They do not log in to Discord, send messages, or read your actual configuration.
