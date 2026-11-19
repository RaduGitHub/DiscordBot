# Keeping this bot on GitHub

The repository is a source backup and a place to manage code changes. The bot
continues running on Cloudflare when your PC is off. A Git push does not deploy
the Worker or change Discord commands.

## Clone the repository

The source repository is [RaduGitHub/DiscordBot](https://github.com/RaduGitHub/DiscordBot).
To work on another computer, install Git and clone it:

```powershell
git clone https://github.com/RaduGitHub/DiscordBot.git
cd DiscordBot
```

Authenticate with GitHub when prompted. If the repository is private, use an
account with access to it. Configure your local deployment files as described
below before running deployment commands.

## Use this checkout with your existing deployment

Your original configured bot folder is preserved. To deploy from this checkout
instead, copy these files locally from that existing folder:

- `wrangler.jsonc`, containing your existing Worker, database, queue, and IDs.
- `.dev.vars`, containing the token and public key for local registration.

Both files are ignored by Git. Keep the existing database and queue rather than
creating new resources: your saved channels and pings live in the existing D1
database. Cloudflare's production secrets are separate and remain configured
there. Installing dependencies with `npm ci`, running `npm test`, and pushing
source to GitHub do not alter those resources.

For a fresh deployment, copy `wrangler.example.jsonc` to `wrangler.jsonc` once
and follow [README.md](README.md). Edit only your ignored local configuration.

## What belongs in Git

Track source, tests, setup scripts, SQL schema, documentation, dependency
manifests and lockfiles, and examples containing placeholders. The older Windows
version and its offline tests are under `legacy/windows-python/`.

The ignore rules exclude credentials, live configuration, personal settings,
dependency folders, local cloud state, database exports under `.local/`, logs,
archives, and temporary files. Never force-add ignored secrets. GitHub does not
contain the live D1 database or act as a backup of your production settings.

## Checks and deployment

Run `npm test` from the repository root. These offline tests do not need a bot
token, Cloudflare account, local `wrangler.jsonc`, or network access.

After intentionally changing code, deploy it separately from a locally configured
checkout with `npm run deploy`. Only run `npm run register` when you intend to
replace this application's slash command definitions for the configured server.

No automatic deployment or GitHub Actions workflow is enabled in this repository.
