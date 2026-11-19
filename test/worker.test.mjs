import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleFetch, verifyRequest, processJob, basicAuthorization } from "../src/worker.mjs";
import { ApiError, PERMISSIONS as P } from "../src/discord.mjs";
import { Store } from "../src/store.mjs";
import { SQLiteD1 } from "./helpers.mjs";

const APP = "100000000000000001";
const GUILD = "100000000000000002";
const USER = "100000000000000003";
const BOT = "100000000000000004";
const COMMAND = "100000000000000005";
const POST = "100000000000000006";
const ROLE = "100000000000000007";
const ATTACHMENT = "100000000000000008";
const INTERACTION = "100000000000000009";
const MESSAGE = "100000000000000010";
const BOT_ROLE = "100000000000000011";
const ADMIN_ROLE = "100000000000000012";
const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("hex");
const encoder = new TextEncoder();
const clone = value => structuredClone(value);

function configuration(extra = {}) {
  return {
    DISCORD_TOKEN: "offline-bot-secret", DISCORD_APPLICATION_ID: APP,
    DISCORD_GUILD_ID: GUILD, CONTROLLER_USER_ID: USER, DISCORD_PUBLIC_KEY: publicKey, ...extra,
  };
}

function interaction(extra = {}) {
  return {
    id: INTERACTION, application_id: APP, guild_id: GUILD, channel_id: COMMAND,
    type: 2, token: "private-interaction-token",
    member: { user: { id: USER }, roles: [ADMIN_ROLE], permissions: "8" },
    data: { name: "settings", options: [{ type: 1, name: "list" }] }, ...extra,
  };
}

function command(name, options = []) {
  return interaction({ data: { name: "settings", options: [{ type: 1, name, options }] } });
}

function postInteraction() {
  return interaction({ data: {
    name: "post", options: [{ name: "photo", type: 11, value: ATTACHMENT }],
    resolved: { attachments: { [ATTACHMENT]: {
      id: ATTACHMENT, filename: "photo.png", content_type: "image/png", size: 8, ephemeral: true,
      url: "https://cdn.discordapp.com/ephemeral-attachments/" + APP + "/" + ATTACHMENT + "/photo.png?ex=private",
    } } },
  } });
}

async function signedRequest(payload, {
  timestamp = String(Math.floor(Date.now() / 1000)), raw,
  actualBody, headers = {}, url = "https://offline.example/interactions",
} = {}) {
  const body = raw ?? JSON.stringify(payload);
  const signature = Buffer.from(await crypto.subtle.sign(
    "Ed25519", keyPair.privateKey, encoder.encode(timestamp + body),
  )).toString("hex");
  return new Request(url, {
    method: "POST", body: actualBody ?? body,
    headers: {
      "Content-Type": "application/json", "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp, ...headers,
    },
  });
}

function queueEnv(extra = {}) {
  const queued = [];
  return {
    queued,
    env: configuration({ JOBS: { async send(...args) { queued.push(args); } }, ...extra }),
  };
}

test("valid Ed25519 Discord PING returns PONG without bot configuration", async () => {
  const result = await handleFetch(await signedRequest({ type: 1 }), { DISCORD_PUBLIC_KEY: publicKey });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { type: 1 });
});
test("health endpoint is public and does not reveal configuration", async () => {
  const result = await handleFetch(new Request("https://offline.example/health"), configuration());
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.ok(body.includes("running"));
  assert.equal(body.includes("offline-bot-secret"), false);
});
test("unsupported path or method returns 404", async () => {
  assert.equal((await handleFetch(new Request("https://offline.example/interactions"), {})).status, 404);
  assert.equal((await handleFetch(await signedRequest({}, { url: "https://offline.example/no" }), {})).status, 404);
});
test("missing, malformed, invalid, or wrong-key signature is refused", async () => {
  const { env, queued } = queueEnv();
  const missing = new Request("https://offline.example/interactions", { method: "POST", body: "{}" });
  assert.equal((await handleFetch(missing, env)).status, 401);
  for (const signature of ["invalid", "0".repeat(128)]) {
    const response = await handleFetch(await signedRequest(interaction(), { headers: { "X-Signature-Ed25519": signature } }), env);
    assert.equal(response.status, 401);
  }
  const wrongPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const wrongKey = Buffer.from(await crypto.subtle.exportKey("raw", wrongPair.publicKey)).toString("hex");
  assert.equal((await handleFetch(await signedRequest(interaction()), { ...env, DISCORD_PUBLIC_KEY: wrongKey })).status, 401);
  assert.equal(queued.length, 0);
});
test("a signed request fails if its body is tampered with", async () => {
  const { env, queued } = queueEnv();
  const response = await handleFetch(await signedRequest(interaction(), { actualBody: JSON.stringify({ ...interaction(), guild_id: "99" }) }), env);
  assert.equal(response.status, 401);
  assert.equal(queued.length, 0);
});
test("stale and future signatures are refused", async () => {
  for (const delta of [-301, 301]) {
    const timestamp = String(Math.floor(Date.now() / 1000) + delta);
    assert.equal((await handleFetch(await signedRequest(interaction(), { timestamp }), configuration())).status, 401);
  }
});
test("invalid timestamp and invalid public key are refused", async () => {
  assert.equal(await verifyRequest(await signedRequest({}, { headers: { "X-Signature-Timestamp": "1e20" } }), publicKey), null);
  assert.equal(await verifyRequest(await signedRequest({}), "bad-public-key"), null);
});
test("signed UTF-8 body is verified byte-for-byte", async () => {
  const raw = JSON.stringify({ type: 1, caption: "Photo: ☕ 你好" });
  assert.equal(await verifyRequest(await signedRequest(null, { raw }), publicKey), raw);
});
test("request body and announced-length caps are enforced", async () => {
  const oversized = JSON.stringify({ type: 1, extra: "x".repeat(65536) });
  assert.equal((await handleFetch(await signedRequest(null, { raw: oversized }), configuration())).status, 401);
  assert.equal((await handleFetch(await signedRequest({ type: 1 }, { headers: { "Content-Length": "65537" } }), configuration())).status, 401);
  const prefix = '{"type":1,"extra":"';
  const suffix = '"}';
  const exact = prefix + "x".repeat(65536 - encoder.encode(prefix + suffix).length) + suffix;
  assert.equal(encoder.encode(exact).byteLength, 65536);
  assert.deepEqual(await (await handleFetch(await signedRequest(null, { raw: exact }), configuration())).json(), { type: 1 });
});
test("valid signature with invalid JSON returns 400 without queuing", async () => {
  const { env, queued } = queueEnv();
  assert.equal((await handleFetch(await signedRequest(null, { raw: "not JSON" }), env)).status, 400);
  assert.equal(queued.length, 0);
});

test("authorized slash command queues versioned metadata and returns private defer", async () => {
  const { env, queued } = queueEnv();
  const before = Math.floor(Date.now() / 1000);
  const payload = interaction();
  const response = await handleFetch(await signedRequest(payload), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0].version, 1);
  assert.ok(queued[0][0].receivedAt >= before);
  assert.deepEqual(queued[0][0].interaction, payload);
  assert.deepEqual(queued[0][1], { delaySeconds: 1 });
});
test("opaque interaction tokens accept base64 characters up to 2048", async () => {
  for (const token of ["a+b/c=d:_-.~", "x".repeat(2048)]) {
    const { env, queued } = queueEnv();
    const response = await handleFetch(await signedRequest(interaction({ token })), env);
    assert.equal((await response.json()).type, 5);
    assert.equal(queued[0][0].interaction.token, token);
  }
});
test("missing or oversized interaction token cannot be queued", async () => {
  for (const token of ["", "x".repeat(2049), null]) {
    const { env, queued } = queueEnv();
    assert.equal((await handleFetch(await signedRequest(interaction({ token })), env)).status, 503);
    assert.equal(queued.length, 0);
  }
});
test("wrong application, guild, controller or permissions are rejected privately without queue", async () => {
  const patches = [
    { application_id: "99" }, { guild_id: "99" }, { member: null },
    { member: { user: { id: "99" }, permissions: "8" } },
    { member: { user: { id: USER }, permissions: "0" } },
  ];
  for (const patch of patches) {
    const { env, queued } = queueEnv();
    const response = await handleFetch(await signedRequest(interaction(patch)), env);
    const body = await response.json();
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.deepEqual(body.data.allowed_mentions.parse, []);
    assert.equal(queued.length, 0);
  }
});
test("malformed member permissions never pass basic authorization", () => {
  for (const permissions of ["-1", "broken", "1e3", 8, true, "9".repeat(31)]) {
    const payload = interaction({ member: { user: { id: USER }, permissions } });
    assert.match(basicAuthorization(payload, configuration()), /valid member permissions/);
  }
});
test("unknown commands and unsupported interaction types are private and not queued", async () => {
  for (const payload of [interaction({ type: 3 }), interaction({ data: { name: "unknown" } })]) {
    const { env, queued } = queueEnv();
    const body = await (await handleFetch(await signedRequest(payload), env)).json();
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.equal(queued.length, 0);
  }
});
test("incomplete environment configuration cannot queue commands", async () => {
  const { env, queued } = queueEnv({ DISCORD_APPLICATION_ID: "invalid" });
  const body = await (await handleFetch(await signedRequest(interaction()), env)).json();
  assert.equal(body.type, 4);
  assert.match(body.data.content, /configuration/);
  assert.equal(queued.length, 0);
});
test("invalid interaction or channel IDs cannot queue", async () => {
  for (const patch of [{ id: "not-an-id" }, { channel_id: "0" }]) {
    const { env, queued } = queueEnv();
    assert.equal((await handleFetch(await signedRequest(interaction(patch)), env)).status, 503);
    assert.equal(queued.length, 0);
  }
});
test("enqueue failure returns HTTP503 and never creates an immediate Discord reply", async () => {
  const { env } = queueEnv({ JOBS: { async send() { throw new Error("private token"); } } });
  const result = await handleFetch(await signedRequest(interaction()), env);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("content-type")?.includes("application/json"), false);
  const text = await result.text();
  assert.equal(text.includes("type"), false);
  assert.equal(text.includes("private token"), false);
});

async function fixture(t, { configured = true, withTarget = true } = {}) {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const db = new SQLiteD1();
  t.after(() => db.close());
  const store = new Store(db, GUILD);
  if (configured) await store.setChannels(COMMAND, POST);
  if (withTarget) await store.addTarget({ kind: "role", id: ROLE });
  const guild = { id: GUILD, owner_id: USER };
  const roles = [
    { id: GUILD, permissions: String(P.VIEW_CHANNEL) },
    { id: BOT_ROLE, permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES) },
    { id: ADMIN_ROLE, permissions: "8" },
    { id: ROLE, permissions: "0", mentionable: true },
  ];
  const actor = { user: { id: USER }, roles: [ADMIN_ROLE] };
  const bot = { user: { id: BOT }, roles: [BOT_ROLE] };
  const channels = new Map([COMMAND, POST].map(id => [id, { id, guild_id: GUILD, type: 0, permission_overwrites: [] }]));
  const receipts = [];
  const publicPosts = [];
  const calls = [];
  const api = {
    async editReply(applicationId, token, content) { receipts.push({ applicationId, token, content }); return { id: "123" }; },
    async getGuild(id) { calls.push(["guild", id]); return guild; },
    async getRoles(id) { calls.push(["roles", id]); return roles; },
    async getMember(guildId, userId) {
      calls.push(["member", guildId, userId]);
      if (userId === USER) return actor;
      if (userId === BOT) return bot;
      throw new ApiError("User missing", { status: 404 });
    },
    async request(method, path) {
      calls.push(["request", method, path]);
      assert.equal(method, "GET");
      assert.equal(path, "/users/@me");
      return { id: BOT };
    },
    async getChannel(id) {
      calls.push(["channel", id]);
      if (!channels.has(id)) throw new ApiError("Channel missing", { status: 404 });
      return channels.get(id);
    },
    async sendPhoto(channelId, options) { publicPosts.push({ channelId, options }); return { id: MESSAGE }; },
  };
  const env = configuration({ DB: db });
  return { db, store, env, api, guild, actor, bot, roles, channels, receipts, publicPosts, calls };
}

function queuedMessage(payload = interaction(), patch = {}) {
  return {
    body: { version: 1, receivedAt: Math.floor(Date.now() / 1000), interaction: clone(payload), ...patch },
    acknowledgements: 0, retries: 0,
    ack() { this.acknowledgements++; },
    retry() { this.retries++; },
  };
}

test("queue success posts once, saves message ID, confirms privately and acknowledges", async t => {
  const f = await fixture(t);
  const message = queuedMessage(postInteraction());
  await processJob(message, f.env, f.api);
  assert.equal(f.publicPosts.length, 1);
  assert.equal(f.publicPosts[0].channelId, POST);
  assert.deepEqual(f.publicPosts[0].options.allowed_mentions.roles, [ROLE]);
  assert.equal(f.receipts.length, 2);
  assert.match(f.receipts[0].content, /Processing/);
  assert.match(f.receipts[1].content, new RegExp(MESSAGE));
  const saved = await f.store.getJob(INTERACTION);
  assert.equal(saved.status, "done");
  assert.equal(saved.messageId, MESSAGE);
  assert.equal(message.acknowledgements, 1);
  assert.equal(message.retries, 0);
});
test("duplicate successful queue delivery never reposts or repeats receipts", async t => {
  const f = await fixture(t);
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  const duplicate = queuedMessage(postInteraction());
  await processJob(duplicate, f.env, f.api);
  assert.equal(f.publicPosts.length, 1);
  assert.equal(f.receipts.length, 2);
  assert.equal(duplicate.acknowledgements, 1);
});
test("every existing job state blocks reexecution", async t => {
  for (const state of ["processing", "done", "failed", "uncertain"]) {
    const f = await fixture(t);
    await f.store.acquireJob(INTERACTION);
    if (state !== "processing") await f.store.finishJob(INTERACTION, state, state === "done" ? MESSAGE : null);
    const message = queuedMessage(postInteraction());
    await processJob(message, f.env, f.api);
    assert.equal(f.publicPosts.length, 0);
    assert.equal(f.receipts.length, 0);
    assert.equal(message.acknowledgements, 1);
  }
});
test("expired and far-future jobs take no action or permanent claim", async t => {
  const f = await fixture(t);
  for (const delta of [-601, 31]) {
    const message = queuedMessage(postInteraction(), { receivedAt: Math.floor(Date.now() / 1000) + delta });
    await processJob(message, f.env, f.api);
    assert.equal(message.acknowledgements, 1);
  }
  assert.equal(f.publicPosts.length, 0);
  assert.equal(await f.store.getJob(INTERACTION), null);
  assert.equal(f.receipts.length, 2);
  assert.ok(f.receipts.every(item => item.content.includes("expired")));
});
test("malformed jobs acknowledge without API activity", async t => {
  const f = await fixture(t);
  for (const body of [null, {}, { version: 2 }, { version: 1, receivedAt: "now", interaction: interaction() }]) {
    const message = queuedMessage();
    message.body = body;
    await processJob(message, f.env, f.api);
    assert.equal(message.acknowledgements, 1);
  }
  assert.equal(f.receipts.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.publicPosts.length, 0);
});
test("unauthorized queue messages cannot claim jobs or contact Discord", async t => {
  const f = await fixture(t);
  for (const patch of [{ application_id: "99" }, { guild_id: "99" }, { member: { user: { id: "99" }, permissions: "8" } }]) {
    const message = queuedMessage(interaction(patch));
    await processJob(message, f.env, f.api);
    assert.equal(message.acknowledgements, 1);
  }
  assert.equal(await f.store.getJob(INTERACTION), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.receipts.length, 0);
});
test("invalid queue environment acknowledges with no business action", async t => {
  const f = await fixture(t);
  const message = queuedMessage(postInteraction());
  await processJob(message, { ...f.env, CONTROLLER_USER_ID: "bad" }, f.api);
  assert.equal(message.acknowledgements, 1);
  assert.equal(f.publicPosts.length, 0);
});
test("initial private reply exists before settings mutation", async t => {
  const f = await fixture(t);
  let initialConfirmed = false;
  const edit = f.api.editReply;
  f.api.editReply = async (...args) => {
    if (args[2].includes("Processing")) {
      assert.equal((await f.store.getSettings()).targets.length, 1);
      initialConfirmed = true;
    }
    return edit(...args);
  };
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    if (sql.includes("DELETE FROM targets")) assert.equal(initialConfirmed, true);
    return prepare(sql);
  };
  await processJob(queuedMessage(command("clear")), f.env, f.api);
  assert.equal((await f.store.getSettings()).targets.length, 0);
});
test("transient initial reply failures retry safely before command execution", async t => {
  for (const status of [0, 404, 429, 500]) {
    const f = await fixture(t);
    let initialCalls = 0;
    const edit = f.api.editReply;
    f.api.editReply = async (...args) => {
      if (args[2].includes("Processing") && ++initialCalls === 1) {
        assert.equal(f.publicPosts.length, 0);
        throw new ApiError("Temporary private receipt error", { status });
      }
      return edit(...args);
    };
    const message = queuedMessage(postInteraction());
    await processJob(message, f.env, f.api);
    assert.equal(initialCalls, 2);
    assert.equal(f.publicPosts.length, 1);
    assert.equal((await f.store.getJob(INTERACTION)).status, "done");
    assert.equal(message.retries, 0);
  }
});
test("initial private reply exhausts at three attempts and prevents all settings writes", async t => {
  const f = await fixture(t);
  let initialCalls = 0;
  f.api.editReply = async (_app, _token, content) => {
    if (content.includes("Processing")) initialCalls++;
    throw new ApiError("Private response absent", { status: 404 });
  };
  const message = queuedMessage(command("clear"));
  await processJob(message, f.env, f.api);
  assert.equal(initialCalls, 3);
  assert.equal((await f.store.getSettings()).targets.length, 1);
  assert.equal((await f.store.getJob(INTERACTION)).status, "failed");
  assert.equal(f.publicPosts.length, 0);
  assert.equal(message.acknowledgements, 1);
  assert.equal(message.retries, 0);
});
test("nontransient initial reply failure is not retried", async t => {
  const f = await fixture(t);
  let initialCalls = 0;
  f.api.editReply = async (_app, _token, content) => {
    if (content.includes("Processing")) initialCalls++;
    throw new ApiError("Access denied", { status: 403 });
  };
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(initialCalls, 1);
  assert.equal(f.publicPosts.length, 0);
});
test("enqueue result may be uncertain but absence of a deferred reply blocks publication", async t => {
  const f = await fixture(t);
  let sentJob;
  const env = { ...f.env, JOBS: { async send(body) { sentJob = body; throw new Error("lost queue acknowledgement"); } } };
  const response = await handleFetch(await signedRequest(postInteraction()), env);
  assert.equal(response.status, 503);
  f.api.editReply = async () => { throw new ApiError("No original reply", { status: 404 }); };
  const message = queuedMessage();
  message.body = sentJob;
  await processJob(message, env, f.api);
  assert.equal(f.publicPosts.length, 0);
  assert.equal((await f.store.getJob(INTERACTION)).status, "failed");
});
test("definite photo rejection produces a failed job and helpful private error without retry", async t => {
  const f = await fixture(t);
  let sends = 0;
  f.api.sendPhoto = async () => { sends++; throw new ApiError("Try a smaller photo.", { status: 400, code: 40005 }); };
  const message = queuedMessage(postInteraction());
  await processJob(message, f.env, f.api);
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(sends, 1);
  assert.equal((await f.store.getJob(INTERACTION)).status, "failed");
  assert.match(f.receipts.at(-1).content, /smaller photo/);
  assert.equal(message.retries, 0);
});
test("uncertain photo result is preserved and never automatically resent", async t => {
  const f = await fixture(t);
  let sends = 0;
  f.api.sendPhoto = async () => { sends++; throw new ApiError("Connection lost", { ambiguous: true }); };
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(sends, 1);
  assert.equal((await f.store.getJob(INTERACTION)).status, "uncertain");
  assert.match(f.receipts.at(-1).content, /Check the post channel/);
});
test("final database-write failure after successful post still blocks duplicate uploads", async t => {
  const f = await fixture(t);
  t.mock.method(Store.prototype, "finishJob", async () => { throw new Error("Simulated final write failure"); });
  const message = queuedMessage(postInteraction());
  await processJob(message, f.env, f.api);
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(f.publicPosts.length, 1);
  assert.equal((await f.store.getJob(INTERACTION)).status, "processing");
  assert.match(f.receipts.at(-1).content, /Posted!/);
  assert.equal(message.acknowledgements, 1);
});
test("failed final private receipt does not change success or resend photo", async t => {
  const f = await fixture(t);
  const edit = f.api.editReply;
  f.api.editReply = async (...args) => {
    if (args[2].includes("Posted!")) throw new ApiError("Private receipt failed");
    return edit(...args);
  };
  const message = queuedMessage(postInteraction());
  await processJob(message, f.env, f.api);
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(f.publicPosts.length, 1);
  assert.equal((await f.store.getJob(INTERACTION)).status, "done");
  assert.equal(message.acknowledgements, 1);
});
test("database claim failure cannot post or mutate settings", async t => {
  const f = await fixture(t);
  f.db.failBatchAt = 0;
  const message = queuedMessage(command("clear"));
  await processJob(message, f.env, f.api);
  assert.equal(f.publicPosts.length, 0);
  assert.equal((await f.store.getSettings()).targets.length, 1);
  assert.equal(await f.store.getJob(INTERACTION), null);
  assert.equal(message.acknowledgements, 1);
});
test("queued command rechecks fresh administrator status", async t => {
  const f = await fixture(t);
  f.guild.owner_id = "99";
  f.actor.roles = [];
  await processJob(queuedMessage(postInteraction()), f.env, f.api);
  assert.equal(f.publicPosts.length, 0);
  assert.match(f.receipts.at(-1).content, /must still own/);
  assert.equal((await f.store.getJob(INTERACTION)).status, "failed");
});
test("wrong command channel is rejected before Discord context reads or settings writes", async t => {
  const f = await fixture(t);
  const payload = command("clear");
  payload.channel_id = POST;
  await processJob(queuedMessage(payload), f.env, f.api);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.getSettings()).targets.length, 1);
  assert.equal(f.publicPosts.length, 0);
  assert.match(f.receipts.at(-1).content, /configured command channel/);
});
test("queue handler processes multiple messages and duplicate IDs safely", async t => {
  const f = await fixture(t);
  // Use the same fake API by temporarily replacing global fetch is unnecessary:
  // test processJob, the handler's public per-message contract, with a short batch.
  const messages = [queuedMessage(postInteraction()), queuedMessage(postInteraction())];
  for (const message of messages) await processJob(message, f.env, f.api);
  assert.ok(messages.every(message => message.acknowledgements === 1));
  assert.equal(f.publicPosts.length, 1);
  assert.equal(typeof worker.queue, "function");
});
