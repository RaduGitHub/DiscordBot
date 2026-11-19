/** Persistent server settings and one-shot job claims using Cloudflare D1. */

export const MAX_SAVED_TARGETS = 25;
const MAX_ID = (1n << 64n) - 1n;
const JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const TERMINAL_STATES = new Set(["done", "failed", "uncertain"]);

export function assertId(value, label = "Discord ID") {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_ID) {
    throw new Error(`${label} must be a positive Discord ID stored as a string.`);
  }
  return value;
}

function targetRecord(value, guildId) {
  if (!value || (value.kind !== "user" && value.kind !== "role")) {
    throw new Error("Choose a user or role as the target.");
  }
  const id = assertId(value.id, "Target ID");
  if (value.kind === "role" && id === guildId) {
    throw new Error("The @everyone role cannot be saved.");
  }
  return { kind: value.kind, id };
}

function checkResult(result) {
  if (result?.success === false) throw new Error("The settings database operation failed.");
  return result;
}

function changed(result) {
  checkResult(result);
  return Number(result?.meta?.changes ?? 0);
}

/** All mutations use bound values; batches are atomic D1 transactions. */
export class Store {
  constructor(db, guildId) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new Error("The D1 database binding is missing.");
    }
    this.db = db;
    this.guildId = assertId(guildId, "Server ID");
  }

  async getSettings() {
    const results = await this.db.batch([
      this.db.prepare(
        "SELECT command_channel_id, post_channel_id, revision FROM guild_settings WHERE guild_id = ?1",
      ).bind(this.guildId),
      this.db.prepare(
        "SELECT kind, target_id FROM targets WHERE guild_id = ?1 ORDER BY added_at, kind, target_id",
      ).bind(this.guildId),
    ]);
    results.forEach(checkResult);
    const row = results[0].results?.[0];
    const targets = (results[1].results ?? []).map((item) =>
      targetRecord({ kind: item.kind, id: item.target_id }, this.guildId),
    );
    if (targets.length > MAX_SAVED_TARGETS) throw new Error("Saved target settings exceed the supported limit.");
    const commandChannelId = row?.command_channel_id ?? null;
    const postChannelId = row?.post_channel_id ?? null;
    if ((commandChannelId === null) !== (postChannelId === null)) {
      throw new Error("Saved channel settings are incomplete. Restore a valid pair of channels.");
    }
    if (commandChannelId !== null) {
      assertId(commandChannelId, "Saved command channel ID");
      assertId(postChannelId, "Saved post channel ID");
      if (commandChannelId === postChannelId) throw new Error("The saved command and post channels must differ.");
    }
    const revision = row?.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Saved settings have an invalid revision.");
    return { commandChannelId, postChannelId, targets, revision };
  }

  async setChannels(commandId, postId) {
    assertId(commandId, "Command channel ID");
    assertId(postId, "Post channel ID");
    if (commandId === postId) throw new Error("The command channel and post channel must be different.");
    checkResult(await this.db.prepare(`
      INSERT INTO guild_settings (guild_id, command_channel_id, post_channel_id, revision)
      VALUES (?1, ?2, ?3, 1)
      ON CONFLICT (guild_id) DO UPDATE SET
        command_channel_id = excluded.command_channel_id,
        post_channel_id = excluded.post_channel_id,
        revision = guild_settings.revision + 1
      WHERE guild_settings.command_channel_id IS NOT excluded.command_channel_id
         OR guild_settings.post_channel_id IS NOT excluded.post_channel_id
    `).bind(this.guildId, commandId, postId).run());
    return this.getSettings();
  }

  async addTarget(value) {
    const target = targetRecord(value, this.guildId);
    const results = await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?1)").bind(this.guildId),
      this.db.prepare(`
        INSERT OR IGNORE INTO targets (guild_id, kind, target_id)
        SELECT ?1, ?2, ?3
        WHERE (SELECT COUNT(*) FROM targets WHERE guild_id = ?1) < ?4
      `).bind(this.guildId, target.kind, target.id, MAX_SAVED_TARGETS),
      this.db.prepare(
        "SELECT 1 AS present FROM targets WHERE guild_id = ?1 AND kind = ?2 AND target_id = ?3",
      ).bind(this.guildId, target.kind, target.id),
    ]);
    results.forEach(checkResult);
    if (changed(results[1]) > 0) return "added";
    return results[2].results?.length ? "exists" : "limit";
  }

  async removeTarget(value) {
    let result;
    if (typeof value === "string") {
      assertId(value, "Target ID");
      result = await this.db.prepare("DELETE FROM targets WHERE guild_id = ?1 AND target_id = ?2")
        .bind(this.guildId, value).run();
    } else {
      const target = targetRecord(value, this.guildId);
      result = await this.db.prepare("DELETE FROM targets WHERE guild_id = ?1 AND kind = ?2 AND target_id = ?3")
        .bind(this.guildId, target.kind, target.id).run();
    }
    return changed(result) > 0;
  }

  async clearTargets() {
    return changed(await this.db.prepare("DELETE FROM targets WHERE guild_id = ?1").bind(this.guildId).run());
  }

  async acquireJob(interactionId, nowSeconds = Math.floor(Date.now() / 1000)) {
    assertId(interactionId, "Interaction ID");
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("The job timestamp is invalid.");
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM interaction_jobs WHERE guild_id = ?1 AND created_at < ?2")
        .bind(this.guildId, nowSeconds - JOB_RETENTION_SECONDS),
      this.db.prepare(`
        INSERT OR IGNORE INTO interaction_jobs
          (interaction_id, guild_id, status, created_at, updated_at)
        VALUES (?1, ?2, 'processing', ?3, ?3)
      `).bind(interactionId, this.guildId, nowSeconds),
    ]);
    results.forEach(checkResult);
    // Every existing status remains claimed, including interrupted/uncertain sends.
    return changed(results[1]) > 0;
  }

  async finishJob(interactionId, status, messageId = null) {
    assertId(interactionId, "Interaction ID");
    if (!TERMINAL_STATES.has(status)) throw new Error("The final job status is invalid.");
    if (messageId !== null) assertId(messageId, "Message ID");
    return changed(await this.db.prepare(`
      UPDATE interaction_jobs SET status = ?1, updated_at = ?2, message_id = ?3
      WHERE interaction_id = ?4 AND guild_id = ?5 AND status = 'processing'
    `).bind(status, Math.floor(Date.now() / 1000), messageId, interactionId, this.guildId).run()) > 0;
  }

  async getJob(interactionId) {
    assertId(interactionId, "Interaction ID");
    const row = await this.db.prepare(`
      SELECT interaction_id, status, created_at, updated_at, message_id
      FROM interaction_jobs WHERE interaction_id = ?1 AND guild_id = ?2
    `).bind(interactionId, this.guildId).first();
    if (!row) return null;
    return {
      interactionId: row.interaction_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageId: row.message_id,
    };
  }
}
