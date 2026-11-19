import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand, parseCommand } from "../src/commands.mjs";
import { ApiError, MAX_PHOTO_BYTES, PERMISSIONS } from "../src/discord.mjs";
import { Store } from "../src/store.mjs";
import { createTestDb } from "./helpers.mjs";

const ID = Object.freeze({
  guild: "100000000000000001", otherGuild: "100000000000000002",
  controller: "100000000000000003", owner: "100000000000000004",
  bot: "100000000000000005", user: "100000000000000006", extra: "100000000000000007",
  adminRole: "100000000000000008", botRole: "100000000000000009", pingRole: "100000000000000010",
  command: "100000000000000011", post: "100000000000000012", otherChannel: "100000000000000013",
  photo: "100000000000000014", application: "100000000000000015", interaction: "100000000000000016",
  sent: "100000000000000017", thread: "100000000000000018",
});

function channel(id, guild = ID.guild, type = 0) {
  return { id, guild_id: guild, type, permission_overwrites: [] };
}

function option(name, value) { return { name, value }; }

function image(overrides = {}) {
  return {
    id: ID.photo, filename: "photo.png", content_type: "image/png", size: 4, ephemeral: true,
    url: `https://cdn.discordapp.com/ephemeral-attachments/${ID.command}/${ID.photo}/photo.png?ex=valid-test-signature`,
    ...overrides,
  };
}

function invocation(name, options = {}, channelId = ID.command, attachment = image()) {
  const resolved = { attachments: { [ID.photo]: attachment }, roles: {} };
  const items = Object.entries(options).map(([key, value]) => option(key, value));
  return {
    id: ID.interaction, application_id: ID.application, guild_id: ID.guild, channel_id: channelId,
    token: "offline-test-interaction-token",
    member: { user: { id: ID.controller }, permissions: "8", roles: [ID.adminRole] },
    data: name === "post" ? { name: "post", options: items, resolved }
      : { name: "settings", options: [{ name, type: 1, options: items }], resolved },
  };
}

class FakeDiscord {
  constructor() {
    this.calls = [];
    this.guild = { id: ID.guild, owner_id: ID.owner };
    this.roles = [
      { id: ID.guild, permissions: String(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES) },
      { id: ID.adminRole, permissions: String(PERMISSIONS.ADMINISTRATOR) },
      { id: ID.botRole, permissions: String(PERMISSIONS.ATTACH_FILES) },
      { id: ID.pingRole, permissions: "0", mentionable: true },
    ];
    this.members = new Map([
      [ID.controller, { user: { id: ID.controller }, roles: [ID.adminRole] }],
      [ID.bot, { user: { id: ID.bot }, roles: [ID.botRole] }],
      [ID.user, { user: { id: ID.user }, roles: [] }],
      [ID.extra, { user: { id: ID.extra }, roles: [] }],
    ]);
    this.channels = new Map([
      [ID.command, channel(ID.command)], [ID.post, channel(ID.post)],
      [ID.otherChannel, channel(ID.otherChannel)], [ID.thread, channel(ID.thread, ID.guild, 11)],
    ]);
    this.posts = [];
  }

  async getGuild(guildId) { this.calls.push(["guild", guildId]); return this.guild; }
  async getRoles(guildId) { this.calls.push(["roles", guildId]); return this.roles; }
  async getMember(guildId, userId) {
    this.calls.push(["member", guildId, userId]);
    const member = this.members.get(userId);
    if (!member) throw new ApiError("Offline missing member", { status: 404 });
    return member;
  }
  async getChannel(channelId) {
    this.calls.push(["channel", channelId]);
    const selected = this.channels.get(channelId);
    if (!selected) throw new ApiError("Offline missing channel", { status: 404 });
    return selected;
  }
  async request(method, path) {
    this.calls.push(["request", method, path]);
    assert.equal(method, "GET");
    assert.equal(path, "/users/@me");
    return { id: ID.bot };
  }
  async sendPhoto(destination, payload) {
    this.calls.push(["photo", destination]);
    this.posts.push({ destination, payload });
    return { id: ID.sent };
  }
}

async function fixture(t, { configured = true, targets = [] } = {}) {
  const db = createTestDb();
  t.after(() => db.close());
  const store = new Store(db, ID.guild);
  if (configured) await store.setChannels(ID.command, ID.post);
  for (const target of targets) await store.addTarget(target);
  const env = {
    DISCORD_APPLICATION_ID: ID.application, DISCORD_GUILD_ID: ID.guild,
    CONTROLLER_USER_ID: ID.controller,
  };
  const api = new FakeDiscord();
  return {
    db, store, env, api,
    run: (name, values = {}, channelId = ID.command, attachment = image()) =>
      executeCommand(invocation(name, values, channelId, attachment), env, store, api),
    post: (values = {}, channelId = ID.command, attachment = image()) =>
      executeCommand(invocation("post", { photo: ID.photo, ...values }, channelId, attachment), env, store, api),
  };
}

function denyMemberPermission(selectedChannel, userId, permission) {
  selectedChannel.permission_overwrites.push({ id: userId, type: 1, deny: String(permission), allow: "0" });
}

test("parser accepts post and supported settings subcommands", () => {
  assert.equal(parseCommand(invocation("post", { photo: ID.photo })).name, "post");
  for (const name of ["channels", "add", "remove", "list", "clear"]) {
    assert.equal(parseCommand(invocation(name)).name, "settings/" + name);
  }
});

test("parser rejects unknown, duplicate, malformed and nested options", () => {
  for (const data of [
    null, { name: "unknown" }, { name: "post", options: {} },
    { name: "post", options: [{ name: "caption", value: "a" }, { name: "caption", value: "b" }] },
    { name: "settings", options: [{ name: "clear", type: 2 }] },
    { name: "settings", options: [{ name: "clear", type: 1 }, { name: "list", type: 1 }] },
  ]) assert.throws(() => parseCommand({ data }), ApiError);
});

test("only channel setup can run before routing is configured", async (t) => {
  const f = await fixture(t, { configured: false });
  for (const name of ["post", "add", "remove", "list", "clear"]) {
    await assert.rejects(f.run(name), /Choose both channels first/);
  }
  assert.equal(f.api.calls.length, 0);
  assert.equal(f.api.posts.length, 0);
});

test("initial channel setup can bootstrap from another normal server channel", async (t) => {
  const f = await fixture(t, { configured: false });
  const response = await f.run("channels", { command_channel: ID.command, post_channel: ID.post }, ID.otherChannel);
  assert.match(response.content, /Saved/);
  assert.equal((await f.store.getSettings()).commandChannelId, ID.command);
  assert.equal((await f.store.getSettings()).postChannelId, ID.post);
  assert.equal(f.api.posts.length, 0);
});

test("initial setup rejects a thread as its invocation location", async (t) => {
  const f = await fixture(t, { configured: false });
  await assert.rejects(f.run("channels", { command_channel: ID.command, post_channel: ID.post }, ID.thread), /normal text channel/);
  assert.equal((await f.store.getSettings()).commandChannelId, null);
});

test("configured commands reject every other channel before external API work", async (t) => {
  const f = await fixture(t);
  for (const name of ["post", "channels", "add", "remove", "list", "clear"]) {
    await assert.rejects(f.run(name, {}, ID.post), /configured command channel/);
    await assert.rejects(f.run(name, {}, ID.thread), /configured command channel/);
  }
  assert.equal(f.api.calls.length, 0);
  assert.equal(f.api.posts.length, 0);
});

test("fresh administrator revocation blocks posts and every settings action", async (t) => {
  const f = await fixture(t);
  // The invocation still says permissions=8; a fresh member lookup has lost it.
  f.api.members.get(ID.controller).roles = [];
  for (const name of ["post", "channels", "add", "remove", "list", "clear"]) {
    await assert.rejects(f.run(name), /must still own the server or have Administrator/);
  }
  assert.equal(f.api.posts.length, 0);
});

test("the configured controller can remain authorized as server owner", async (t) => {
  const f = await fixture(t);
  f.api.guild.owner_id = ID.controller;
  f.api.members.get(ID.controller).roles = [];
  assert.match((await f.run("list")).content, /Command channel/);
});

test("unexpected controller or guild responses fail before state changes", async (t) => {
  for (const mismatch of ["controller", "guild"]) {
    const f = await fixture(t);
    if (mismatch === "controller") f.api.members.get(ID.controller).user.id = ID.owner;
    else f.api.guild.id = ID.otherGuild;
    await assert.rejects(f.run("clear"), /unexpected server or controller/);
    assert.equal(f.api.posts.length, 0);
  }
});

test("losing the bot's command-channel send permission blocks commands", async (t) => {
  const f = await fixture(t);
  denyMemberPermission(f.api.channels.get(ID.command), ID.bot, PERMISSIONS.SEND_MESSAGES);
  await assert.rejects(f.run("clear"), /View Channel and Send Messages/);
});

test("channel setup rejects equal, foreign and thread channels without replacing routing", async (t) => {
  const cases = [
    { command: ID.command, post: ID.command, pattern: /different/ },
    { command: ID.command, post: ID.otherChannel, mutate: (api) => { api.channels.get(ID.otherChannel).guild_id = ID.otherGuild; }, pattern: /normal text channel/ },
    { command: ID.thread, post: ID.post, pattern: /normal text channel/ },
    { command: ID.command, post: ID.thread, pattern: /normal text channel/ },
  ];
  for (const entry of cases) {
    const f = await fixture(t);
    const before = await f.store.getSettings();
    entry.mutate?.(f.api);
    await assert.rejects(f.run("channels", { command_channel: entry.command, post_channel: entry.post }), entry.pattern);
    assert.deepEqual(await f.store.getSettings(), before);
  }
});

test("channel setup checks bot permissions in both selected channels", async (t) => {
  for (const [selectedId, permission, pattern] of [
    [ID.otherChannel, PERMISSIONS.VIEW_CHANNEL, /View Channel and Send Messages/],
    [ID.otherChannel, PERMISSIONS.SEND_MESSAGES, /View Channel and Send Messages/],
    [ID.post, PERMISSIONS.ATTACH_FILES, /Attach Files/],
  ]) {
    const f = await fixture(t);
    denyMemberPermission(f.api.channels.get(selectedId), ID.bot, permission);
    await assert.rejects(f.run("channels", { command_channel: ID.otherChannel, post_channel: ID.post }), pattern);
    assert.equal((await f.store.getSettings()).commandChannelId, ID.command);
  }
});

test("a successful channel change persists without changing saved pings", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "role", id: ID.pingRole }] });
  await f.run("channels", { command_channel: ID.otherChannel, post_channel: ID.post });
  const reloaded = await new Store(f.db, ID.guild).getSettings();
  assert.equal(reloaded.commandChannelId, ID.otherChannel);
  assert.deepEqual(reloaded.targets, [{ kind: "role", id: ID.pingRole }]);
  await assert.rejects(f.run("list"), /configured command channel/);
  assert.match((await f.run("list", {}, ID.otherChannel)).content, new RegExp(ID.otherChannel));
});

test("a failed channel save retains the prior destinations", async (t) => {
  const f = await fixture(t);
  const saved = await f.store.getSettings();
  f.store.setChannels = async () => { throw new Error("Offline write failure"); };
  await assert.rejects(f.run("channels", { command_channel: ID.otherChannel, post_channel: ID.post }), /write failure/);
  assert.deepEqual(await new Store(f.db, ID.guild).getSettings(), saved);
});

test("saved users and roles persist and duplicate additions do not grow the list", async (t) => {
  const f = await fixture(t);
  assert.match((await f.run("add", { target: ID.user })).content, /Saved/);
  assert.match((await f.run("add", { target: ID.pingRole })).content, /Saved/);
  assert.match((await f.run("add", { target: ID.user })).content, /already saved/);
  const saved = await new Store(f.db, ID.guild).getSettings();
  assert.equal(saved.targets.length, 2);
  assert.equal(saved.commandChannelId, ID.command);
  assert.equal(saved.postChannelId, ID.post);
  assert.equal(f.api.posts.length, 0);
});

test("target configuration blocks everyone, stale roles and users outside the server", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("add", { target: ID.guild }), /@everyone/);
  f.api.members.delete(ID.user);
  await assert.rejects(f.run("add", { target: ID.user }), (error) => error.status === 404);
  const stale = invocation("add", { target: ID.pingRole });
  stale.data.resolved.roles[ID.pingRole] = { id: ID.pingRole };
  f.api.roles = f.api.roles.filter((role) => role.id !== ID.pingRole);
  await assert.rejects(executeCommand(stale, f.env, f.store, f.api), /no longer in the server/);
  assert.deepEqual((await f.store.getSettings()).targets, []);
});

test("settings enforces the combined 25-target cap", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 25; index++) await f.store.addTarget({ kind: "user", id: String(9000 + index) });
  await assert.rejects(f.run("add", { target: ID.user }), /up to 25/);
  assert.equal((await f.store.getSettings()).targets.length, 25);
});

test("remove supports selected targets and numeric IDs for departed users", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }, { kind: "role", id: ID.pingRole }] });
  f.api.members.delete(ID.user);
  assert.match((await f.run("remove", { target_id: ID.user })).content, /Removed/);
  assert.match((await f.run("remove", { target: ID.pingRole })).content, /Removed/);
  assert.deepEqual((await f.store.getSettings()).targets, []);
  assert.match((await f.run("remove", { target_id: ID.user })).content, /not in the saved list/);
});

test("remove rejects missing, conflicting and malformed selectors", async (t) => {
  const f = await fixture(t);
  for (const values of [{}, { target: ID.user, target_id: ID.user }, { target_id: "1; DELETE FROM targets" }]) {
    await assert.rejects(f.run("remove", values), ApiError);
  }
});

test("list reports channels and defaults; clear removes pings only", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }, { kind: "role", id: ID.pingRole }] });
  const result = await f.run("list");
  for (const id of [ID.command, ID.post, ID.user, ID.pingRole]) assert.ok(result.content.includes(id));
  assert.equal(f.api.posts.length, 0);
  assert.match((await f.run("clear")).content, /channels are unchanged/);
  const saved = await f.store.getSettings();
  assert.deepEqual(saved.targets, []);
  assert.equal(saved.commandChannelId, ID.command);
  assert.equal(saved.postChannelId, ID.post);
  assert.match((await f.run("list")).content, /None yet/);
});

test("a photo with no automatic or explicit recipient is rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.post(), /Save users or roles/);
  assert.equal(f.api.posts.length, 0);
});

test("defaults plus an extra user produce only the selected mention allowlists", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }, { kind: "role", id: ID.pingRole }] });
  const caption = "@everyone @here <@999> <@&888>";
  const result = await f.post({ target: ID.extra, caption });
  assert.equal(result.messageId, ID.sent);
  assert.match(result.content, new RegExp(`${ID.guild}/${ID.post}/${ID.sent}`));
  assert.equal(f.api.posts.length, 1);
  const sent = f.api.posts[0];
  assert.equal(sent.destination, ID.post);
  assert.deepEqual(sent.payload.allowed_mentions, {
    parse: [], users: [ID.user, ID.extra], roles: [ID.pingRole], replied_user: false,
  });
  assert.equal(sent.payload.nonce, ID.interaction);
  assert.ok(sent.payload.content.endsWith(caption));
  assert.equal((await f.store.getSettings()).targets.length, 2);
});

test("an extra target already saved is mentioned only once", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }] });
  await f.post({ target: ID.user });
  assert.deepEqual(f.api.posts[0].payload.allowed_mentions.users, [ID.user]);
  assert.equal(f.api.posts[0].payload.content, `<@${ID.user}>`);
});

test("the output destination is fixed and crafted overrides are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.post({ target: ID.user, channel: ID.otherChannel }), /destination is fixed/);
  assert.equal(f.api.posts.length, 0);
});

test("missing, foreign, thread and mismatched output channels never fall back", async (t) => {
  for (const mode of ["missing", "foreign", "thread", "mismatched"]) {
    const f = await fixture(t);
    if (mode === "missing") f.api.channels.delete(ID.post);
    else if (mode === "foreign") f.api.channels.get(ID.post).guild_id = ID.otherGuild;
    else if (mode === "thread") f.api.channels.get(ID.post).type = 11;
    else f.api.channels.get(ID.post).id = ID.otherChannel;
    await assert.rejects(f.post({ target: ID.user }));
    assert.equal(f.api.posts.length, 0);
    assert.equal((await f.store.getSettings()).postChannelId, ID.post);
  }
});

test("announcement channels are supported as fixed destinations", async (t) => {
  const f = await fixture(t);
  f.api.channels.get(ID.post).type = 5;
  await f.post({ target: ID.user });
  assert.equal(f.api.posts[0].destination, ID.post);
});

test("bot destination permissions are checked before any photo send", async (t) => {
  for (const permission of [PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.SEND_MESSAGES, PERMISSIONS.ATTACH_FILES]) {
    const f = await fixture(t);
    denyMemberPermission(f.api.channels.get(ID.post), ID.bot, permission);
    await assert.rejects(f.post({ target: ID.user }), /View Channel, Send Messages, and Attach Files/);
    assert.equal(f.api.posts.length, 0);
  }
});

test("a target who cannot view the destination prevents the whole photo post", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }] });
  denyMemberPermission(f.api.channels.get(ID.post), ID.user, PERMISSIONS.VIEW_CHANNEL);
  await assert.rejects(f.post({ target: ID.extra }), /cannot see the post channel/);
  assert.equal(f.api.posts.length, 0);
});

test("an unmentionable role requires the bot's mention-everyone permission", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "role", id: ID.pingRole }] });
  f.api.roles.find((role) => role.id === ID.pingRole).mentionable = false;
  await assert.rejects(f.post(), /not mentionable/);
  const botRole = f.api.roles.find((role) => role.id === ID.botRole);
  botRole.permissions = String(BigInt(botRole.permissions) | PERMISSIONS.MENTION_EVERYONE);
  await f.post();
  assert.deepEqual(f.api.posts[0].payload.allowed_mentions, { parse: [], users: [], roles: [ID.pingRole], replied_user: false });
});

test("deleted roles and departed saved users stop rather than silently skipping a ping", async (t) => {
  for (const kind of ["role", "user"]) {
    const target = { kind, id: kind === "role" ? ID.pingRole : ID.user };
    const f = await fixture(t, { targets: [target] });
    if (kind === "role") f.api.roles = f.api.roles.filter((role) => role.id !== target.id);
    else f.api.members.delete(target.id);
    await assert.rejects(f.post(), new RegExp(`target_id:${target.id}`));
    assert.equal(f.api.posts.length, 0);
  }
});

test("an unexpected target member response is rejected", async (t) => {
  const f = await fixture(t);
  f.api.members.get(ID.user).user.id = ID.extra;
  await assert.rejects(f.post({ target: ID.user }), /unexpected target user/);
  assert.equal(f.api.posts.length, 0);
});

test("@everyone cannot be selected as a one-time photo recipient", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.post({ target: ID.guild }), /@everyone/);
  assert.equal(f.api.posts.length, 0);
});

test("photo captions enforce text type and the 1800-character limit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.post({ target: ID.user, caption: 123 }), /must be text/);
  await assert.rejects(f.post({ target: ID.user, caption: "x".repeat(1801) }), /1800/);
  await f.post({ target: ID.user, caption: "x".repeat(1800) });
  assert.equal(f.api.posts.length, 1);
});

test("the 2000-character composition limit includes every saved mention", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 25; index++) {
    const id = String(200000000000000000n + BigInt(index));
    await f.store.addTarget({ kind: "user", id });
    f.api.members.set(id, { user: { id }, roles: [] });
  }
  await assert.rejects(f.post({ caption: "x".repeat(1800) }), /exceed 2000/);
  assert.equal(f.api.posts.length, 0);
});

test("attachment metadata rejects unsupported, oversized and mismatched photos", async (t) => {
  for (const photo of [
    image({ content_type: "application/pdf" }), image({ size: MAX_PHOTO_BYTES + 1 }),
    image({ size: 0 }), image({ id: ID.extra }), image({ url: "https://example.com/photo.png" }),
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.post({ target: ID.user }, ID.command, photo), ApiError);
    assert.equal(f.api.posts.length, 0);
  }
});

test("a failed send is propagated without a second send or settings change", async (t) => {
  const f = await fixture(t, { targets: [{ kind: "user", id: ID.user }] });
  const before = await f.store.getSettings();
  let attempts = 0;
  f.api.sendPhoto = async () => { attempts++; throw new ApiError("Offline send failed", { ambiguous: true }); };
  await assert.rejects(f.post(), (error) => error.ambiguous);
  assert.equal(attempts, 1);
  assert.deepEqual(await f.store.getSettings(), before);
});
