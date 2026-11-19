import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discordId } from './register-commands.mjs';

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) {
    throw new Error(label + ' has an unsupported format. Use the saved file from the Windows bot.');
  }
}

function validateHeader(value, keys, guildId, label) {
  exactKeys(value, keys, label);
  if (value.version !== 1) throw new Error(label + ' has an unsupported version.');
  const sourceGuild = discordId(value.server_id, label + ' server ID');
  if (sourceGuild !== guildId) throw new Error(label + ' belongs to another server.');
}

export function buildMigration(guildId, pings, channels) {
  discordId(guildId, 'guild ID');
  if (!pings && !channels) throw new Error('No saved ping-settings.json or channel-settings.json file was found.');
  const statements = [
    '-- Generated locally. Contains channel/target IDs only; no bot token.',
    '-- Import after schema.sql. This replaces only the settings present in the source folder.',
    'INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (\'' + guildId + '\');',
  ];
  if (channels) {
    validateHeader(channels, ['version', 'server_id', 'command_channel_id', 'post_channel_id'], guildId, 'channel-settings.json');
    const commandId = discordId(channels.command_channel_id, 'command channel ID');
    const postId = discordId(channels.post_channel_id, 'post channel ID');
    if (commandId === postId) throw new Error('The saved command and post channels must be different.');
    statements.push('UPDATE guild_settings SET command_channel_id = \'' + commandId +
      '\', post_channel_id = \'' + postId + '\', revision = revision + 1 WHERE guild_id = \'' + guildId + '\';');
  }
  if (pings) {
    validateHeader(pings, ['version', 'server_id', 'targets'], guildId, 'ping-settings.json');
    if (!Array.isArray(pings.targets) || pings.targets.length > 25) throw new Error('Saved pings must be a list of up to 25 users and roles.');
    const seen = new Set();
    const targets = pings.targets.map((target) => {
      exactKeys(target, ['type', 'id'], 'Saved target');
      if (!['user', 'role'].includes(target.type)) throw new Error('Each saved target must be a user or role.');
      const id = discordId(target.id, 'target ID');
      if (target.type === 'role' && id === guildId) throw new Error('The @everyone role cannot be imported.');
      const key = target.type + ':' + id;
      if (seen.has(key)) throw new Error('The saved target list contains a duplicate.');
      seen.add(key);
      return { kind: target.type, id };
    });
    statements.push('DELETE FROM targets WHERE guild_id = \'' + guildId + '\';');
    for (const target of targets) {
      statements.push('INSERT INTO targets (guild_id, kind, target_id) VALUES (\'' +
        guildId + '\', \'' + target.kind + '\', \'' + target.id + '\');');
    }
  }
  return statements.join('\n') + '\n';
}

async function optionalJson(path, label) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read ' + label + '. Check the source folder and file permissions.');
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(label + ' is not valid JSON. Repair it or use a backup before importing.'); }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const print = options.print || console.log;
  if (args.includes('--help')) {
    print('Usage: npm run import-settings -- --source "PATH_TO_WINDOWS_BOT" --guild-id SERVER_ID [--out .local/migration.sql] [--overwrite]');
    print('This reads only the two saved settings files and creates local SQL. It does not read config.json or upload anything.');
    return;
  }
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--overwrite') { parsed.overwrite = true; continue; }
    if (!['--source', '--guild-id', '--out'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Invalid import option. Use --help for instructions.');
    }
    if (parsed[name]) throw new Error('Do not repeat import options.');
    parsed[name] = args[++i];
  }
  if (!parsed['--source'] || !parsed['--guild-id']) throw new Error('Supply --source and --guild-id. Use --help for an example.');
  const directory = options.directory || process.cwd();
  const source = resolve(directory, parsed['--source']);
  const guildId = discordId(parsed['--guild-id'], 'guild ID');
  const [pings, channels] = await Promise.all([
    optionalJson(resolve(source, 'ping-settings.json'), 'ping-settings.json'),
    optionalJson(resolve(source, 'channel-settings.json'), 'channel-settings.json'),
  ]);
  const sql = buildMigration(guildId, pings, channels);
  const destination = resolve(directory, parsed['--out'] || '.local/migration.sql');
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(destination, sql, { encoding: 'utf8', flag: parsed.overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('The SQL output already exists. Choose another --out path or add --overwrite.');
    throw new Error('Could not write the local SQL file. Check its folder permissions.');
  }
  print('Created local migration SQL: ' + destination);
  print('Review it before importing. It contains IDs only; no token. Nothing has been uploaded.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
