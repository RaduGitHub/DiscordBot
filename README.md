# Discord Photo Bot for Cloudflare Workers Free

This is the cloud version of your photo bot. Discord sends each slash command
to a Worker. Cloudflare Queues handles the work, and D1 stores your channel
choices and automatic pings. Your PC can be off after deployment.

The Windows/Python bot remains separate. Do not run it while switching this
same Discord application to the Worker.

## Repository layout

The Cloudflare version is the active project at the repository root. The earlier
Windows/Python version is preserved in `legacy/windows-python/`, with its own
setup instructions. Use one version for your Discord application at a time.

This repository contains source, tests, dependency versions, and placeholder
configuration. Your live bot token, personal configuration, saved channels and
pings, database contents, logs, and installed dependencies stay outside Git.

For copying your existing deployment configuration into this checkout, see
[GITHUB.md](GITHUB.md). Publishing source here does not deploy the bot; Cloudflare
continues hosting it.

## What stays the same

- Only your configured personal account can use the bot, and that account must
  still own the server or have Administrator permission.
- After channel setup, every command must come from the exact command channel.
- Every photo post goes only to the separate saved destination.
- You can save up to 25 users and roles to ping on every post.
- Settings replies and post confirmations are private.
- Captions cannot trigger additional unselected pings. The everyone role is blocked.
- Use slash commands such as `/post`; normal chat messages are not watched.

The bot does not maintain a Discord Gateway connection or online presence.
Its slash commands can work even if its member icon appears offline.

## Before you begin

You need a free Cloudflare account, access to your existing Discord application,
and a current Node.js LTS installation (version 22.13 or newer).

Download Node.js from https://nodejs.org/en/download if it is not installed.
Node includes npm. After installation, reopen your terminal and check:

```powershell
node --version
npm --version
```

Clone this repository (or download and extract it), open its root folder in a
terminal, and run:

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
npm ci
npm test
```

Copy the configuration example only once. Edit your local `wrangler.jsonc` for
deployment; Git ignores it. The committed example always contains placeholders.

All commands below run from this repository root. They do not require a paid
domain; Cloudflare supplies a workers.dev address.

## 1. Fill in the public IDs

Open `wrangler.jsonc` in a text editor. Keep it as plain JSON, preserving quotes
and commas. Replace the three ID placeholders under `vars`:

| Setting | Where to find it |
| --- | --- |
| DISCORD_APPLICATION_ID | Developer Portal > your app > General Information > Application ID |
| DISCORD_GUILD_ID | Discord Developer Mode: right-click your server > Copy Server ID |
| CONTROLLER_USER_ID | Discord Developer Mode: right-click your own profile > Copy User ID |

Your personal user ID is different from the bot's ID. These IDs are not tokens.

Leave the database ID placeholder for the next step. The Worker name can stay
`discord-photo-bot`; if your Cloudflare account already uses that name, choose
another lowercase name.

## 2. Create the free cloud resources

Log in to Cloudflare through Wrangler:

```powershell
npx wrangler login
```

This opens your browser so you can approve access to your own Cloudflare account.

Create the D1 database:

```powershell
npx wrangler d1 create photo-bot
```

Copy the returned **database_id** into `wrangler.jsonc`, replacing
`00000000-0000-0000-0000-000000000000`. Keep the binding name **DB**.
If Wrangler offers to update the configuration automatically, check that the
existing DB entry contains the returned ID rather than adding a second DB binding.

Create the queue and database tables:

```powershell
npx wrangler queues create discord-photo-bot-jobs
npx wrangler d1 execute photo-bot --remote --file schema.sql
```

Keep the queue names in `wrangler.jsonc` matching the name above. The same Worker
is the producer and consumer. No R2 bucket or paid container is required.

## 3. Add the two production secrets

From Developer Portal > your app, get:

- **Bot > Token:** use your existing token. Reset it only if you no longer have
  it; resetting invalidates the previous token.
- **General Information > Public Key:** this is the application's public key,
  not its Application ID or Client Secret.

Run these commands one at a time. Paste each value when Wrangler asks:

```powershell
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
```

Do not put the token in `wrangler.jsonc`, a command-line argument, GitHub, or chat.
If Wrangler asks to create the named Worker before adding a secret, allow it.

For local tests and command registration, also copy `.dev.vars.example` to
`.dev.vars`, then fill in its two values privately. This file is ignored by Git
and is not uploaded by Wrangler as production secrets. Production uses the
secrets you entered above.

## 4. Optional: carry over your Windows settings

Skip this if you want to choose channels and pings again using Discord commands.

The import script reads only the two saved JSON settings files from the Windows
bot folder. It never opens `config.json` and does not copy or upload your token.

For example, replace the path and server ID with your own:

```powershell
npm run import-settings -- --source "C:\path\to\discord-photo-bot" --guild-id "123456789012345678"
```

It creates `.local/migration.sql`. Review that file: it contains server, channel,
user, and role IDs only. The script has not uploaded anything yet.

If this cloud database already has settings, back them up before importing:

```powershell
npx wrangler d1 export photo-bot --remote --output .local/before-import.sql
```

Import the reviewed migration:

```powershell
npx wrangler d1 execute photo-bot --remote --file .local/migration.sql
```

The migration replaces the saved channels and/or pings present in the old folder.
If one of the two old settings files is absent, that part of the cloud settings
is left unchanged. Your old files stay intact. To regenerate an existing local
migration file, choose another `--out` path or explicitly add `--overwrite`.

## 5. Deploy and connect Discord

Check the build, then deploy:

```powershell
npm run check
npm run deploy
```

Copy the deployed address, for example:

```text
https://discord-photo-bot.your-subdomain.workers.dev
```

Open that address plus `/health` in your browser to check that the Worker
responds. Opening `/interactions` in a browser is not a Discord command and may
return `Not found` (404); Discord uses signed POST requests there.

Stop your old Windows bot window with Ctrl+C before the next steps.

Preview the slash command definitions, then register them for your server:

```powershell
npm run register -- --dry-run
npm run register
```

The registration script uses IDs from `wrangler.jsonc` and the token in your
local `.dev.vars`. It replaces this application's server command definitions
with `/post` and `/settings`. It does not create a new Discord application.

In Discord Developer Portal > your application > **General Information**, set
**Interactions Endpoint URL** to your deployed address plus **/interactions**:

```text
https://discord-photo-bot.your-subdomain.workers.dev/interactions
```

Click **Save Changes**. Discord sends a signed test request; the Worker answers
it. An invalid request signature is rejected.

If Discord cannot verify the URL, check the address and DISCORD_PUBLIC_KEY.
The Public Key must belong to the same application as the configured ID/token.

## 6. Use your bot

If you did not import channels, run this once as your configured admin account:

```text
/settings channels command_channel:#bot-control post_channel:#photos
```

Choose different normal text channels. Before initial setup, this is the only
command accepted. After setup, run every command in **#bot-control**.

Save your automatic pings, then send a photo:

```text
/settings add target:@Members
/settings add target:@Alex
/post photo:[upload your image] caption:Here is the photo!
```

You can add a one-time extra target:

```text
/post photo:[upload your image] target:@Someone
```

The photo and pings are published only in the saved post channel. There is no
per-post channel override. If the destination is unavailable, the bot reports
the problem privately and does not fall back to your command channel.

Manage settings with:

```text
/settings list
/settings remove target:@Alex
/settings remove target_id:123456789012345678
/settings clear
```

List does not ping anyone. Clear removes automatic pings and keeps the channels.
If no pings are saved, choose a target on each post.

## Permissions and first live test

The bot needs View Channel and Send Messages in the command channel, plus
Attach Files in the post channel. Make the command channel private in Discord
if you want it hidden from ordinary members.

A role must be mentionable, or the bot needs Mention everyone/here/all roles
in the destination. The script still limits pings to selected users and roles.
Selected users must be able to see the destination.

Start with a small JPG or PNG and a target you can test with. Confirm the photo
appears in the destination and the receipt remains private. Also confirm a
different account and a command in the wrong channel cannot control the bot.

Supported photo types are JPG, PNG, GIF, and WebP. The code caps uploads at
25 MiB, subject to Discord's own bot upload allowance. The largest uploads
still need a deployed test: the Free plan has strict CPU limits, and Discord
documents restrictions on some attachment CDN URLs from Workers. Uploading
through the slash command supplies the attachment URL used by this version.
If a fetch is refused, try a fresh slash-command attachment and check the logs.

## Reliability and free limits

The queue lets the Worker acknowledge the slash command promptly while the
photo transfer runs separately. A job records the interaction ID in D1 and
uses Discord's nonce support to reduce duplicate posts.

Automatic queue retries are disabled for this bot. If an operation fails, check
whether the destination already contains the photo before submitting a new
command. A failed private receipt does not mean the photo failed. Do not rerun
a successful post just because a confirmation was missing.

Cloudflare's published Free allowances include 100,000 Worker requests/day,
10 ms CPU per invocation, 128 MB memory, D1's free database usage, and 10,000
queue operations/day. One queued command normally uses several queue operations.
Photo bytes are streamed; the bot does not resize/process or permanently store
them on Cloudflare.

Actual CPU usage, attachment access, and Discord rate limits need a live check.
The package's offline tests do not establish production uptime or a guaranteed
maximum photo size. Free-tier limits and terms can change.

## Troubleshooting and recovery

- **No commands:** check your Application ID/server ID, local token file, and
  registration output. The bot needs the bot and applications.commands install
  scopes. Only your controller account with admin permission can use it.
- **Wrong account:** fix CONTROLLER_USER_ID in `wrangler.jsonc` and redeploy.
- **Wrong channel:** run all commands in the currently saved command channel.
  Use `/settings channels` there to change either channel.
- **Deleted command channel:** back up the database, then clear only its routing
  with D1 using your actual server ID:

```powershell
npx wrangler d1 execute photo-bot --remote --command "UPDATE guild_settings SET command_channel_id = NULL, post_channel_id = NULL, revision = revision + 1 WHERE guild_id = 'YOUR_SERVER_ID';"
```

Then run `/settings channels` again. Saved pings remain intact.

- **Logs:** use `npx wrangler tail` or Cloudflare Dashboard > Workers & Pages >
  your Worker > Logs. Do not share tokens or full interaction payloads.
- **Switch back to Windows:** stop using the Worker endpoint, clear Interactions
  Endpoint URL in Developer Portal, then run your saved Windows bot. Keep one
  version responsible for the application at a time.
- **Local development:** `npm run dev` uses local emulated storage/queue bindings.
  Apply the schema locally with
  `npx wrangler d1 execute photo-bot --local --file schema.sql`.
  Local tests do not require production secrets or real Discord requests.

## Files

`src/worker.mjs` handles signed HTTP interactions and queued jobs.
`src/discord.mjs` contains Discord REST calls and streaming uploads.
`src/store.mjs` and `schema.sql` persist settings and job records in D1.
`scripts/register-commands.mjs` installs the command definitions.
`scripts/import-settings.mjs` prepares local settings migration SQL.
`test/` contains offline checks.

This repository contains source and examples only, not your token or actual
personal settings.

## Official references

- Discord's Worker tutorial: https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers
- Discord interactions: https://docs.discord.com/developers/interactions/overview
- Worker limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 setup and import: https://developers.cloudflare.com/d1/get-started/
- D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Queues configuration: https://developers.cloudflare.com/queues/configuration/configure-queues/
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/
