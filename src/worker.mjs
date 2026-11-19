import { Store, assertId } from './store.mjs';
import { DiscordApi } from './discord.mjs';
import { executeCommand } from './commands.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_JOB_AGE_SECONDS = 600;
const signingKeys = new Map();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function immediateReply(content) {
  return json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
}

export function checkConfiguration(env) {
  for (const key of ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'CONTROLLER_USER_ID']) {
    assertId(env[key]);
  }
  if (!env.DISCORD_TOKEN || typeof env.DISCORD_TOKEN !== 'string') throw new Error('Missing bot token');
}

export function basicAuthorization(interaction, env) {
  if (interaction.application_id !== env.DISCORD_APPLICATION_ID) return 'This command is for a different application.';
  if (interaction.guild_id !== env.DISCORD_GUILD_ID || !interaction.member) return 'Use this command inside the configured server.';
  if (interaction.member.user?.id !== env.CONTROLLER_USER_ID) return 'This bot only accepts commands from its configured controller.';
  try {
    const permissions = interaction.member.permissions ?? '0';
    if (typeof permissions !== 'string' || !/^\d{1,30}$/.test(permissions)) throw new Error();
    if ((BigInt(permissions) & 8n) === 0n) {
      return 'Your controller account must own the server or have Administrator permission.';
    }
  } catch {
    return 'Discord did not supply valid member permissions.';
  }
  return null;
}

function hexBytes(value) {
  return Uint8Array.from(value.match(/../g), part => Number.parseInt(part, 16));
}

export async function verifyRequest(request, publicKey, now = Date.now()) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!/^[a-f\d]{64}$/i.test(publicKey ?? '') || !/^[a-f\d]{128}$/i.test(signature ?? '') || !/^\d{1,12}$/.test(timestamp ?? '')) {
    return null;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return null;
  const announcedLength = request.headers.get('Content-Length');
  if (announcedLength !== null && Number(announcedLength) > MAX_REQUEST_BYTES) return null;
  // The request contains only attachment metadata; image bytes never arrive here.
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const prefix = new TextEncoder().encode(timestamp);
  const signed = new Uint8Array(prefix.byteLength + length);
  signed.set(prefix);
  let offset = prefix.byteLength;
  for (const chunk of chunks) { signed.set(chunk, offset); offset += chunk.byteLength; }
  let key = signingKeys.get(publicKey);
  if (!key) {
    key = crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    // One deployment uses one public key; bound the cache if that key changes.
    signingKeys.clear();
    signingKeys.set(publicKey, key);
  }
  try {
    if (!await crypto.subtle.verify('Ed25519', await key, hexBytes(signature), signed)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(signed.subarray(prefix.byteLength));
  } catch {
    return null;
  }
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({ service: 'discord-photo-bot', status: 'running' });
  if (url.pathname !== '/interactions' || request.method !== 'POST') return new Response('Not found', { status: 404 });
  let raw;
  try { raw = await verifyRequest(request, env.DISCORD_PUBLIC_KEY); } catch { raw = null; }
  if (raw === null) return new Response('Invalid request signature', { status: 401 });
  let interaction;
  try { interaction = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (interaction?.type === 1) return json({ type: 1 });
  if (interaction?.type !== 2) return immediateReply('This bot supports slash commands.');
  try { checkConfiguration(env); } catch { return immediateReply('The Worker configuration is incomplete. Check its IDs and secrets.'); }
  const denial = basicAuthorization(interaction, env);
  if (denial) return immediateReply(denial);
  if (!['post', 'settings'].includes(interaction.data?.name)) return immediateReply('Unknown command. Register this version of the commands.');
  try {
    assertId(interaction.id);
    assertId(interaction.channel_id);
    if (typeof interaction.token !== 'string' || interaction.token.length < 1 || interaction.token.length > 2048) throw new Error();
    // Delaying consumption briefly lets Discord create the private deferred reply.
    // The consumer verifies that reply exists before changing settings or posting.
    await env.JOBS.send({ version: 1, receivedAt: Math.floor(Date.now() / 1000), interaction }, { delaySeconds: 1 });
  } catch {
    // Do not create a normal initial Discord reply here: a queue send might have
    // succeeded before its connection failed. Without a deferred response, the
    // consumer's initial PATCH fails and it cannot act on that uncertain send.
    return new Response('Command queue unavailable', { status: 503 });
  }
  return json({ type: 5, data: { flags: 64 } });
}

async function quietReply(api, interaction, content) {
  try {
    await api.editReply(interaction.application_id, interaction.token, content);
  } catch {
    // Never print exception objects: their URLs can contain interaction tokens.
    console.warn('Private confirmation could not be delivered.');
  }
}

async function acknowledgeStarted(api, interaction) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api.editReply(interaction.application_id, interaction.token, 'Processing your command…');
      return;
    } catch (error) {
      // Retrying a private edit is safe. Public message creation is never retried.
      const transient = !error.status || error.status === 404 || error.status === 429 || error.status >= 500;
      if (!transient || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

export async function processJob(message, env, apiOverride = null) {
  const job = message.body;
  if (job?.version !== 1 || !job.interaction || !Number.isInteger(job.receivedAt)) { message.ack(); return; }
  const interaction = job.interaction;
  let store;
  let api;
  let acquired = false;
  let outcome;
  try {
    checkConfiguration(env);
    assertId(interaction.id);
    assertId(interaction.channel_id);
    if (basicAuthorization(interaction, env)) { message.ack(); return; }
    store = new Store(env.DB, env.DISCORD_GUILD_ID);
    api = apiOverride ?? new DiscordApi(env);
    const now = Math.floor(Date.now() / 1000);
    if (now - job.receivedAt > MAX_JOB_AGE_SECONDS || job.receivedAt > now + 30) {
      await quietReply(api, interaction, 'This queued command expired without taking action. Run it again if needed.');
      message.ack(); return;
    }
    acquired = await store.acquireJob(interaction.id, now);
    if (!acquired) { message.ack(); return; }
    // If Discord did not accept our deferred response, stop before any side effect.
    await acknowledgeStarted(api, interaction);
    outcome = await executeCommand(interaction, env, store, api);
  } catch (error) {
    const status = error?.ambiguous ? 'uncertain' : 'failed';
    if (store && acquired) {
      try { await store.finishJob(interaction.id, status); } catch { console.error('Could not save the command outcome.'); }
    }
    if (api) {
      const detail = typeof error?.userMessage === 'string'
        ? error.userMessage : 'The command could not be completed. Check the Worker logs and configuration.';
      await quietReply(api, interaction, error?.ambiguous
        ? 'The upload result is uncertain. Check the post channel before trying again; this bot will not automatically repost it.'
        : detail);
    }
    // No automatic job retries: delivery may have succeeded before a network error.
    console.warn('A command stopped without automatic retry.');
    message.ack(); return;
  }
  try {
    await store.finishJob(interaction.id, 'done', outcome.messageId ?? null);
  } catch {
    // Its processing record still blocks duplicates, even if this final write fails.
    console.error('Command completed but its final database status could not be saved.');
  }
  await quietReply(api, interaction, outcome.content);
  message.ack();
}

export default {
  fetch: handleFetch,
  async queue(batch, env) {
    // Configuration also limits the queue to one command at a time.
    for (const message of batch.messages) await processJob(message, env);
  },
};
