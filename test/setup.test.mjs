import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { COMMANDS, discordId, parseLocalVars, loadLocalEnvironment, main as register } from '../scripts/register-commands.mjs';
import { buildMigration, main as importSettings } from '../scripts/import-settings.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = resolve(packageRoot, '.local');
const guild = '123456789012345678';
const app = '223456789012345678';
const target = '323456789012345678';
const channels = { version: 1, server_id: guild, command_channel_id: '423456789012345678', post_channel_id: '523456789012345678' };
const pings = { version: 1, server_id: guild, targets: [{ type: 'user', id: target }] };

async function fixture(t) {
  await mkdir(localRoot, { recursive: true });
  const folder = await mkdtemp(resolve(localRoot, 'setup-test-'));
  t.after(async () => {
    const checked = resolve(folder);
    assert.ok(checked.startsWith(localRoot + sep));
    await rm(checked, { recursive: true, force: true });
  });
  return folder;
}

test('registered commands preserve admin defaults, target pickers, and fixed post destination', () => {
  assert.deepEqual(COMMANDS.map((command) => command.name), ['post', 'settings']);
  for (const command of COMMANDS) {
    assert.equal(command.default_member_permissions, '8');
    assert.equal(command.dm_permission, false);
  }
  const [post, settings] = COMMANDS;
  assert.equal(post.options[0].type, 11);
  assert.equal(post.options[0].required, true);
  assert.equal(post.options.find((option) => option.name === 'target').type, 9);
  assert.equal(post.options.find((option) => option.name === 'caption').max_length, 1800);
  assert.equal(post.options.some((option) => option.name === 'channel'), false);
  assert.deepEqual(settings.options.map((option) => option.name), ['channels', 'add', 'remove', 'list', 'clear']);
  for (const option of settings.options[0].options) assert.deepEqual(option.channel_types, [0, 5]);
});

test('local vars parser preserves literal values and ignores comments without executing expressions', () => {
  assert.deepEqual(parseLocalVars('# local only\nDISCORD_TOKEN="fake.$(do-not-run)"\nDISCORD_PUBLIC_KEY=abc\n'), {
    DISCORD_TOKEN: 'fake.$(do-not-run)', DISCORD_PUBLIC_KEY: 'abc',
  });
  assert.deepEqual(parseLocalVars("TOKEN='fake-token'\r\n"), { TOKEN: 'fake-token' });
});

test('bad local vars errors do not echo sensitive input', () => {
  assert.throws(() => parseLocalVars('secret-value-without-equals'), (error) => !error.message.includes('secret-value'));
  assert.throws(() => parseLocalVars('TOKEN="fake-private-value'), (error) => !error.message.includes('fake-private-value'));
});

test('ID validation rejects injection, rounded numeric IDs, zero and overflow', () => {
  assert.equal(discordId(guild, 'test'), guild);
  for (const value of [Number(guild), '0', '-1', "1';DELETE FROM targets;--", '18446744073709551616', 'PASTE_ID']) {
    assert.throws(() => discordId(value, 'test'));
  }
});

test('local config loads public vars and token but environment overrides take priority', async (t) => {
  const folder = await fixture(t);
  await writeFile(resolve(folder, 'wrangler.jsonc'), JSON.stringify({ vars: { DISCORD_GUILD_ID: guild, DISCORD_APPLICATION_ID: app } }));
  await writeFile(resolve(folder, '.dev.vars'), 'DISCORD_TOKEN="fake-local-token"\n');
  const env = await loadLocalEnvironment(folder, { DISCORD_TOKEN: 'fake-env-token' });
  assert.equal(env.DISCORD_TOKEN, 'fake-env-token');
  assert.equal(env.DISCORD_GUILD_ID, guild);
});

test('registration dry run does not access files or contact Discord', async () => {
  let called = false;
  const lines = [];
  await register(['--dry-run'], { directory: 'does-not-exist', print: (line) => lines.push(line), fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(lines[0]), COMMANDS);
});

test('registration uses scoped route and token header without logging token', async (t) => {
  const folder = await fixture(t);
  await writeFile(resolve(folder, 'wrangler.jsonc'), JSON.stringify({ vars: {} }));
  const lines = [];
  await register([], {
    directory: folder,
    env: { DISCORD_GUILD_ID: guild, DISCORD_APPLICATION_ID: app, DISCORD_TOKEN: 'fake-test-token' },
    print: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://discord.com/api/v10/applications/' + app + '/guilds/' + guild + '/commands');
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers.Authorization, 'Bot fake-test-token');
      assert.deepEqual(JSON.parse(options.body), COMMANDS);
      return new Response('[]', { status: 200 });
    },
  });
  assert.ok(lines[0].includes('Registered'));
  assert.equal(lines.join('').includes('fake-test-token'), false);
});

test('registration reports only safe status/code rather than error body', async (t) => {
  const folder = await fixture(t);
  await writeFile(resolve(folder, 'wrangler.jsonc'), JSON.stringify({ vars: {} }));
  await assert.rejects(register([], {
    directory: folder,
    env: { DISCORD_GUILD_ID: guild, DISCORD_APPLICATION_ID: app, DISCORD_TOKEN: 'fake-test-token' },
    print: () => {},
    fetchImpl: async () => new Response(JSON.stringify({ code: 50001, message: 'fake-private-value' }), { status: 403 }),
  }), (error) => error.message.includes('403') && !error.message.includes('fake-private-value'));
});

test('migration creates only server-scoped settings SQL with quoted snowflakes', () => {
  const sql = buildMigration(guild, pings, channels);
  assert.ok(sql.includes("'" + guild + "'"));
  assert.ok(sql.includes('command_channel_id'));
  assert.ok(sql.includes('INSERT INTO targets'));
  assert.equal(sql.includes('BEGIN TRANSACTION'), false);
});

test('migration runs against actual schema and preserves string IDs', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(resolve(packageRoot, 'schema.sql'), 'utf8'));
    db.exec(buildMigration(guild, pings, channels));
    const row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guild);
    assert.equal(row.command_channel_id, channels.command_channel_id);
    assert.equal(row.post_channel_id, channels.post_channel_id);
    assert.deepEqual(db.prepare('SELECT kind, target_id FROM targets WHERE guild_id = ?').all(guild).map((item) => ({ ...item })), [
      { kind: 'user', target_id: target },
    ]);
  } finally { db.close(); }
});

test('ping-only migration preserves existing routing', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(resolve(packageRoot, 'schema.sql'), 'utf8'));
    db.exec(buildMigration(guild, null, channels));
    db.exec(buildMigration(guild, pings, null));
    assert.equal(db.prepare('SELECT command_channel_id FROM guild_settings WHERE guild_id = ?').get(guild).command_channel_id, channels.command_channel_id);
  } finally { db.close(); }
});

test('migration rejects wrong-server, invalid format, duplicate targets and everyone', () => {
  assert.throws(() => buildMigration(guild, null, { ...channels, server_id: app }));
  assert.throws(() => buildMigration(guild, { ...pings, targets: [...pings.targets, ...pings.targets] }, channels));
  assert.throws(() => buildMigration(guild, { ...pings, targets: [{ type: 'role', id: guild }] }, channels));
  assert.throws(() => buildMigration(guild, null, { ...channels, post_channel_id: channels.command_channel_id }));
  assert.throws(() => buildMigration(guild, { ...pings, targets: new Array(26).fill(pings.targets[0]) }, channels));
  assert.throws(() => buildMigration(guild, { ...pings, version: 2 }, channels));
  assert.throws(() => buildMigration(guild, null, null));
});

test('local import reads only saved settings and never imports config token', async (t) => {
  const folder = await fixture(t);
  const source = resolve(folder, 'old-bot');
  await mkdir(source);
  await writeFile(resolve(source, 'ping-settings.json'), JSON.stringify(pings));
  await writeFile(resolve(source, 'channel-settings.json'), JSON.stringify(channels));
  await writeFile(resolve(source, 'config.json'), '{not-even-valid-json');
  const lines = [];
  await importSettings(['--source', source, '--guild-id', guild], { directory: folder, print: (line) => lines.push(line) });
  const sql = await readFile(resolve(folder, '.local/migration.sql'), 'utf8');
  assert.ok(sql.includes(target));
  assert.ok(lines.join('').includes('Nothing has been uploaded'));
  await assert.rejects(importSettings(['--source', source, '--guild-id', guild], { directory: folder, print: () => {} }), /already exists/);
});

test('local import errors do not echo corrupt saved file contents', async (t) => {
  const folder = await fixture(t);
  await writeFile(resolve(folder, 'ping-settings.json'), 'private-invalid-json');
  await assert.rejects(importSettings(['--source', folder, '--guild-id', guild], {
    directory: folder, print: () => {},
  }), (error) => !error.message.includes('private-invalid-json'));
});
