// Shared by migration v60 and the separate new-database schema. IF NOT EXISTS throughout.
//
// The content manager: connected social accounts, posts, and one variant of each post for each
// platform. A variant is keyed by platform, not by account, because an agent writes it before an
// account is connected. `account_id` is bound when the variant is published, and a disconnected
// account keeps its variants. `author_agent_id` has no foreign key: a post stays when the agent that
// wrote it is deleted. The post status is not stored; `contentPostStatus` derives it from the variants.
export const CONTENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS content_accounts (
    account_id TEXT PRIMARY KEY,
    -- No CHECK on platform: the set of networks grows, and SQLite can change a CHECK only by a table
    -- rebuild. The decoder validates it.
    platform TEXT NOT NULL,
    external_account_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT,
    token_ciphertext TEXT NOT NULL,
    refresh_ciphertext TEXT,
    scopes TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('connected', 'expired', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(platform, external_account_id)
  );

  CREATE TABLE IF NOT EXISTS content_posts (
    post_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    media_json TEXT,
    approval_state TEXT NOT NULL CHECK(approval_state IN ('none', 'pending', 'approved')),
    scheduled_for TEXT,
    timezone TEXT NOT NULL,
    author_agent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS content_posts_schedule ON content_posts(scheduled_for, post_id);

  CREATE TABLE IF NOT EXISTS content_variants (
    variant_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES content_posts(post_id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    account_id TEXT REFERENCES content_accounts(account_id) ON DELETE SET NULL,
    body TEXT,
    title TEXT,
    media_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'queued', 'publishing', 'published', 'failed', 'skipped')),
    attempt INTEGER NOT NULL DEFAULT 0,
    pending_data TEXT,
    external_post_id TEXT,
    error_code TEXT,
    error TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(post_id, platform)
  );
  CREATE INDEX IF NOT EXISTS content_variants_status ON content_variants(status, post_id);
  CREATE INDEX IF NOT EXISTS content_variants_account ON content_variants(account_id);
`;
