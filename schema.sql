-- Apply once with Wrangler D1 execute. IDs stay TEXT to avoid precision loss.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY NOT NULL,
  command_channel_id TEXT,
  post_channel_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK (
    (command_channel_id IS NULL AND post_channel_id IS NULL)
    OR (command_channel_id IS NOT NULL AND post_channel_id IS NOT NULL
        AND command_channel_id <> post_channel_id)
  )
);

CREATE TABLE IF NOT EXISTS targets (
  guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'role')),
  target_id TEXT NOT NULL,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (guild_id, kind, target_id),
  CHECK (kind <> 'role' OR target_id <> guild_id)
);

CREATE TRIGGER IF NOT EXISTS targets_limit
BEFORE INSERT ON targets
WHEN NOT EXISTS (
  SELECT 1 FROM targets
  WHERE guild_id = NEW.guild_id AND kind = NEW.kind AND target_id = NEW.target_id
)
AND (SELECT COUNT(*) FROM targets WHERE guild_id = NEW.guild_id) >= 25
BEGIN
  SELECT RAISE(ABORT, 'Saved target limit reached');
END;

CREATE TRIGGER IF NOT EXISTS targets_revision_insert
AFTER INSERT ON targets
BEGIN
  UPDATE guild_settings SET revision = revision + 1 WHERE guild_id = NEW.guild_id;
END;

CREATE TRIGGER IF NOT EXISTS targets_revision_delete
AFTER DELETE ON targets
BEGIN
  UPDATE guild_settings SET revision = revision + 1 WHERE guild_id = OLD.guild_id;
END;

-- Records contain no bot token, interaction token, attachment URL, or image data.
CREATE TABLE IF NOT EXISTS interaction_jobs (
  interaction_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed', 'uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_id TEXT
);

CREATE INDEX IF NOT EXISTS interaction_jobs_cleanup
ON interaction_jobs (guild_id, created_at);
