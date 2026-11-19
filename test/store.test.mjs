import test from "node:test";
import assert from "node:assert/strict";
import { Store, assertId, MAX_SAVED_TARGETS } from "../src/store.mjs";
import { SQLiteD1, schema } from "./helpers.mjs";
const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const COMMAND = "100000000000000003";
const POST = "100000000000000004";
const USER = "100000000000000005";
const ROLE = "100000000000000006";
const JOB = "100000000000000007";

function fixture(t, guild = GUILD) {
  const db = new SQLiteD1();
  t.after(() => db.close());
  return { db, store: new Store(db, guild) };
}

test("assertId preserves the full unsigned 64-bit value as text", () => {
  assert.equal(assertId("18446744073709551615"), "18446744073709551615");
  assert.equal(assertId("1"), "1");
});

test("assertId rejects noncanonical, out-of-range, numeric and SQL-like values", () => {
  for (const value of [0, 1, 1n, null, undefined, "", "0", "01", "-1", "1.0", " 1", "１", "18446744073709551616", "1'; DROP TABLE targets;--"]) {
    assert.throws(() => assertId(value), /positive Discord ID/);
  }
});

test("invalid identifiers are not echoed in errors", () => {
  const secret = "not-a-real-secret-value";
  assert.throws(() => assertId(secret), (error) => !error.message.includes(secret));
});

test("constructor requires the D1 binding and a valid server ID", (t) => {
  const { db } = fixture(t);
  assert.throws(() => new Store(null, GUILD), /binding/);
  assert.throws(() => new Store({}, GUILD), /binding/);
  assert.throws(() => new Store(db, 123), /positive Discord ID/);
});

test("missing settings return safe unconfigured defaults without a write", async (t) => {
  const { store, db } = fixture(t);
  assert.deepEqual(await store.getSettings(), {
    commandChannelId: null, postChannelId: null, targets: [], revision: 0,
  });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM guild_settings").get().n, 0);
});

test("channels persist across Store instances with distinct IDs", async (t) => {
  const { store, db } = fixture(t);
  const result = await store.setChannels(COMMAND, POST);
  assert.deepEqual(result, { commandChannelId: COMMAND, postChannelId: POST, targets: [], revision: 1 });
  assert.deepEqual(await new Store(db, GUILD).getSettings(), result);
});

test("identical channel settings do not increment their revision", async (t) => {
  const { store } = fixture(t);
  await store.setChannels(COMMAND, POST);
  assert.equal((await store.setChannels(COMMAND, POST)).revision, 1);
});

test("changing channels preserves targets and increments revision", async (t) => {
  const { store } = fixture(t);
  await store.setChannels(COMMAND, POST);
  await store.addTarget({ kind: "role", id: ROLE });
  const before = await store.getSettings();
  const after = await store.setChannels(POST, COMMAND);
  assert.deepEqual(after.targets, before.targets);
  assert.equal(after.commandChannelId, POST);
  assert.equal(after.postChannelId, COMMAND);
  assert.ok(after.revision > before.revision);
});

test("same-channel and invalid channel changes preserve previous settings", async (t) => {
  const { store } = fixture(t);
  const before = await store.setChannels(COMMAND, POST);
  await assert.rejects(store.setChannels(COMMAND, COMMAND), /different/);
  await assert.rejects(store.setChannels("oops", POST), /positive Discord ID/);
  assert.deepEqual(await store.getSettings(), before);
});

test("user and role targets persist, are deduplicated, and retain routes", async (t) => {
  const { store, db } = fixture(t);
  await store.setChannels(COMMAND, POST);
  assert.equal(await store.addTarget({ kind: "user", id: USER }), "added");
  assert.equal(await store.addTarget({ kind: "role", id: ROLE }), "added");
  const beforeDuplicate = await store.getSettings();
  assert.equal(await store.addTarget({ kind: "user", id: USER }), "exists");
  assert.deepEqual(await store.getSettings(), beforeDuplicate);
  const reloaded = await new Store(db, GUILD).getSettings();
  assert.equal(reloaded.commandChannelId, COMMAND);
  assert.equal(reloaded.postChannelId, POST);
  assert.deepEqual(new Set(reloaded.targets.map((target) => target.kind + target.id)), new Set(["user" + USER, "role" + ROLE]));
});

test("targets may be saved before channel setup without inventing routes", async (t) => {
  const { store } = fixture(t);
  await store.addTarget({ kind: "user", id: USER });
  const result = await store.getSettings();
  assert.equal(result.commandChannelId, null);
  assert.equal(result.postChannelId, null);
  assert.equal(result.targets.length, 1);
});

test("every target is validated, including @everyone", async (t) => {
  const { store } = fixture(t);
  for (const invalid of [null, {}, { kind: "everyone", id: ROLE }, { kind: "user", id: 123 }, { kind: "role", id: GUILD }]) {
    await assert.rejects(store.addTarget(invalid));
  }
  assert.deepEqual((await store.getSettings()).targets, []);
});

test("atomic insert caps a burst of additions at 25", async (t) => {
  const { store } = fixture(t);
  const outcomes = await Promise.all(Array.from({ length: 30 }, (_, index) =>
    store.addTarget({ kind: index % 2 ? "role" : "user", id: String(2000 + index) }),
  ));
  assert.equal(outcomes.filter((value) => value === "added").length, MAX_SAVED_TARGETS);
  assert.equal(outcomes.filter((value) => value === "limit").length, 5);
  assert.equal((await store.getSettings()).targets.length, 25);
  assert.equal(await store.addTarget({ kind: "user", id: "2000" }), "exists");
});

test("schema independently enforces the target cap for SQL imports", async (t) => {
  const { store, db } = fixture(t);
  for (let index = 0; index < 25; index++) await store.addTarget({ kind: "user", id: String(3000 + index) });
  assert.throws(() => db.sqlite.prepare("INSERT INTO targets (guild_id,kind,target_id) VALUES (?,?,?)").run(GUILD, "role", "4000"), /limit/);
});

test("schema independently rejects @everyone and incomplete channel pairs", (t) => {
  const { db } = fixture(t);
  db.sqlite.prepare("INSERT INTO guild_settings(guild_id) VALUES (?)").run(GUILD);
  assert.throws(() => db.sqlite.prepare("INSERT INTO targets (guild_id,kind,target_id) VALUES (?,?,?)").run(GUILD, "role", GUILD), /CHECK/);
  assert.throws(() => db.sqlite.prepare("UPDATE guild_settings SET command_channel_id=? WHERE guild_id=?").run(COMMAND, GUILD), /CHECK/);
});

test("remove accepts a resolved target or a deleted target's ID", async (t) => {
  const { store } = fixture(t);
  await store.addTarget({ kind: "user", id: USER });
  await store.addTarget({ kind: "role", id: ROLE });
  assert.equal(await store.removeTarget({ kind: "user", id: USER }), true);
  assert.equal(await store.removeTarget({ kind: "user", id: USER }), false);
  assert.equal(await store.removeTarget(ROLE), true);
  assert.deepEqual((await store.getSettings()).targets, []);
});

test("remove by target kind does not remove a different kind", async (t) => {
  const { store } = fixture(t);
  await store.addTarget({ kind: "user", id: USER });
  assert.equal(await store.removeTarget({ kind: "role", id: USER }), false);
  assert.equal((await store.getSettings()).targets.length, 1);
});

test("clear removes only pings and preserves both channels", async (t) => {
  const { store } = fixture(t);
  await store.setChannels(COMMAND, POST);
  await store.addTarget({ kind: "user", id: USER });
  await store.addTarget({ kind: "role", id: ROLE });
  assert.equal(await store.clearTargets(), 2);
  assert.equal(await store.clearTargets(), 0);
  const result = await store.getSettings();
  assert.equal(result.commandChannelId, COMMAND);
  assert.equal(result.postChannelId, POST);
  assert.deepEqual(result.targets, []);
});

test("two guilds cannot read, modify, or clear each other's targets/routes", async (t) => {
  const { store, db } = fixture(t);
  const other = new Store(db, OTHER_GUILD);
  await store.setChannels(COMMAND, POST);
  await store.addTarget({ kind: "user", id: USER });
  assert.deepEqual((await other.getSettings()).targets, []);
  assert.equal(await other.removeTarget(USER), false);
  assert.equal(await other.clearTargets(), 0);
  assert.equal((await store.getSettings()).targets.length, 1);
});

test("failed target batch rolls back creation and target insertion together", async (t) => {
  const { store, db } = fixture(t);
  db.failBatchAt = 2;
  await assert.rejects(store.addTarget({ kind: "user", id: USER }), /Simulated/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM guild_settings").get().n, 0);
  assert.deepEqual((await store.getSettings()).targets, []);
});

test("D1 unsuccessful mutation results are not treated as a saved change", async (t) => {
  const { store, db } = fixture(t);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const original = prepare(sql);
    if (!sql.startsWith("DELETE FROM targets")) return original;
    return { bind: () => ({ run: async () => ({ success: false, meta: { changes: 0 } }) }) };
  };
  await assert.rejects(store.clearTargets(), /operation failed/);
});

test("job acquisition persists one claim and no sensitive fields", async (t) => {
  const { store, db } = fixture(t);
  assert.equal(await store.acquireJob(JOB, 1000), true);
  assert.equal(await new Store(db, GUILD).acquireJob(JOB, 1001), false);
  const result = await store.getJob(JOB);
  assert.deepEqual(result, { interactionId: JOB, status: "processing", createdAt: 1000, updatedAt: 1000, messageId: null });
  const columns = db.sqlite.prepare("PRAGMA table_info(interaction_jobs)").all().map((row) => row.name);
  assert.deepEqual(columns, ["interaction_id", "guild_id", "status", "created_at", "updated_at", "message_id"]);
});

test("all terminal outcomes remain claimed so queue retries do not resend", async (t) => {
  const { store } = fixture(t);
  for (const [index, status] of ["done", "failed", "uncertain"].entries()) {
    const id = String(5000 + index);
    assert.equal(await store.acquireJob(id, 1000), true);
    assert.equal(await store.finishJob(id, status, status === "done" ? POST : null), true);
    assert.equal(await store.acquireJob(id, 1001), false);
    assert.equal((await store.getJob(id)).status, status);
    assert.equal(await store.finishJob(id, "failed"), false);
  }
});

test("unknown jobs cannot be finished and another guild cannot read or finish a claim", async (t) => {
  const { store, db } = fixture(t);
  assert.equal(await store.getJob(JOB), null);
  assert.equal(await store.finishJob(JOB, "done"), false);
  await store.acquireJob(JOB, 1000);
  const other = new Store(db, OTHER_GUILD);
  assert.equal(await other.acquireJob(JOB, 1000), false);
  assert.equal(await other.getJob(JOB), null);
  assert.equal(await other.finishJob(JOB, "failed"), false);
  assert.equal((await store.getJob(JOB)).status, "processing");
});

test("invalid job timestamps, IDs, states and message IDs are rejected", async (t) => {
  const { store } = fixture(t);
  for (const stamp of [-1, NaN, Infinity, 0.5, "1000"]) await assert.rejects(store.acquireJob(JOB, stamp), /timestamp/);
  await assert.rejects(store.acquireJob("bad", 1), /positive Discord ID/);
  await assert.rejects(store.finishJob(JOB, "processing"), /status/);
  await assert.rejects(store.finishJob(JOB, "done", "bad"), /positive Discord ID/);
});

test("indexed cleanup retains seven days and does not touch another guild", async (t) => {
  const { store, db } = fixture(t);
  const other = new Store(db, OTHER_GUILD);
  const day = 86400;
  await store.acquireJob("6001", 0);
  await other.acquireJob("6002", 0);
  await store.acquireJob("6003", day);
  await store.acquireJob("6004", 8 * day);
  assert.equal(await store.getJob("6001"), null);
  assert.notEqual(await store.getJob("6003"), null);
  assert.notEqual(await other.getJob("6002"), null);
});

test("a failed acquisition transaction cannot leave a partial job claim", async (t) => {
  const { store, db } = fixture(t);
  db.failBatchAt = 1;
  await assert.rejects(store.acquireJob(JOB, 1000), /Simulated/);
  assert.equal(await store.getJob(JOB), null);
  assert.equal(await store.acquireJob(JOB, 1000), true);
});

test("schema can be applied repeatedly without clearing existing settings", async (t) => {
  const { store, db } = fixture(t);
  await store.setChannels(COMMAND, POST);
  await store.addTarget({ kind: "role", id: ROLE });
  const before = await store.getSettings();
  db.sqlite.exec(schema);
  assert.deepEqual(await store.getSettings(), before);
});
