import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mentionable = (name, description, required = false) => ({ type: 9, name, description, required });
const channel = (name, description) => ({ type: 7, name, description, required: true, channel_types: [0, 5] });

export const COMMANDS = [
  {
    type: 1,
    name: 'post',
    description: 'Send a photo and saved pings to your configured post channel.',
    default_member_permissions: '8',
    dm_permission: false,
    options: [
      { type: 11, name: 'photo', description: 'Upload a JPG, PNG, GIF, or WebP photo', required: true },
      mentionable('target', 'Optional extra person or role; saved automatic pings are still included'),
      { type: 3, name: 'caption', description: 'Optional text below the pings', required: false, max_length: 1800 },
    ],
  },
  {
    type: 1,
    name: 'settings',
    description: 'Set the command channel, post channel, and automatic pings.',
    default_member_permissions: '8',
    dm_permission: false,
    options: [
      {
        type: 1, name: 'channels', description: 'Choose the command channel and separate photo destination.',
        options: [
          channel('command_channel', 'The channel where only your commands will be accepted'),
          channel('post_channel', 'A different channel where every post message will be sent'),
        ],
      },
      { type: 1, name: 'add', description: 'Add a user or role to every photo post.',
        options: [mentionable('target', 'The person or role to save', true)] },
      { type: 1, name: 'remove', description: 'Remove a saved user or role.',
        options: [
          mentionable('target', 'The saved person or role to remove'),
          { type: 3, name: 'target_id', description: 'Alternatively paste an ID from settings list', required: false, max_length: 20 },
        ] },
      { type: 1, name: 'list', description: 'Show saved channels and pings without notifying anyone.', options: [] },
      { type: 1, name: 'clear', description: 'Remove all saved automatic pings.', options: [] },
    ],
  },
];

export function parseLocalVars(text) {
  const result = {};
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid .dev.vars syntax on line ' + (index + 1) + '. Use NAME="value".');
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) throw new Error('Unclosed quote in .dev.vars on line ' + (index + 1) + '.');
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export async function loadLocalEnvironment(directory, overrides = process.env) {
  let config;
  try {
    config = JSON.parse((await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Cannot read wrangler.jsonc. Keep this file as plain JSON with its quotes and commas intact.');
  }
  let local = {};
  try {
    local = parseLocalVars(await readFile(resolve(directory, '.dev.vars'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...(config.vars || {}), ...local, ...overrides };
}

export function discordId(value, label) {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) throw new Error('Set ' + label + ' to its numeric Discord ID, inside quotes.');
  const id = BigInt(value);
  if (id <= 0n || id > 18446744073709551615n) throw new Error('Set ' + label + ' to a valid Discord ID.');
  return value;
}

export async function main(args = process.argv.slice(2), options = {}) {
  const print = options.print || console.log;
  if (args.includes('--help')) {
    print('Usage: npm run register [-- --dry-run]');
    print('Dry run prints command definitions only. A normal run replaces this application\'s server commands.');
    return;
  }
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('Unknown option. Use --help for command registration instructions.');
  if (args.includes('--dry-run')) {
    print(JSON.stringify(COMMANDS, null, 2));
    return;
  }
  const env = await loadLocalEnvironment(options.directory || process.cwd(), options.env || process.env);
  const applicationId = discordId(env.DISCORD_APPLICATION_ID, 'DISCORD_APPLICATION_ID');
  const guildId = discordId(env.DISCORD_GUILD_ID, 'DISCORD_GUILD_ID');
  if (typeof env.DISCORD_TOKEN !== 'string' || !env.DISCORD_TOKEN.trim() || env.DISCORD_TOKEN.startsWith('PASTE_')) {
    throw new Error('Put your bot token in the local .dev.vars file as DISCORD_TOKEN.');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl('https://discord.com/api/v10/applications/' + applicationId + '/guilds/' + guildId + '/commands', {
      method: 'PUT',
      headers: { Authorization: 'Bot ' + env.DISCORD_TOKEN.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Could not contact Discord to register commands. Check the connection and try again.');
  }
  if (!response.ok) {
    let code = 0;
    try { const error = await response.json(); if (Number.isInteger(error.code)) code = error.code; } catch {}
    throw new Error('Discord rejected command registration (HTTP ' + response.status + ', code ' + code + '). Check the token, IDs, and bot invitation.');
  }
  await response.arrayBuffer();
  print('Registered /post and /settings for the configured server.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
