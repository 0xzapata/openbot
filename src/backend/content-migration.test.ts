// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves a content table
// or its marker; a newer or incomplete history is accepted; deleting a post leaves its variants; deleting
// an account deletes its variants instead of unbinding them; a post gets two variants of one platform.
// These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CONTENT_TABLES = { content_accounts: [], content_posts: [], content_variants: [] };
const CONTENT_OBJECTS = [
  { type: "table", name: "content_accounts" },
  { type: "table", name: "content_posts" },
  { type: "index", name: "content_posts_schedule" },
  { type: "table", name: "content_variants" },
  { type: "index", name: "content_variants_account" },
  { type: "index", name: "content_variants_status" },
];

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** Rows in several tables of schema 59: an event, a memory, a Slack connection and a ping. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO orchestration_events
    (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
    VALUES ('event-1', 'command-1', 'agent-routine', 'routine-1', 'agent-routine.created', '2026-01-01',
      '{"name":"Daily 界"}')`).run();
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Post at 9 界"\\', 'post at 9 界"\\', 'manual', NULL, '2026-01-01', '2026-01-01', 2)`).run();
  db.prepare(`INSERT INTO projection_messaging_connections
    (connection_id, platform, workspace_id, workspace_name, enabled, bot_user_id, app_id, orchestrator_agent_id,
     last_error_code, created_at, updated_at)
    VALUES ('slack-1', 'slack', 'T1', 'Acme 界', 1, 'UBOT', 'A1', 'chief', NULL, '2026-01-02', '2026-01-02')`).run();
  db.prepare(`INSERT INTO projection_messaging_pings
    (connection_id, platform_channel_id, thread_key, user_id, agent_id, text, created_at)
    VALUES ('slack-1', 'C1', '1700000000.000100', 'U1', 'research', 'Which logo?', '2026-01-03')`).run();
}

/** Every row of every table, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function contentObjects(db: DatabaseSync) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'content_%' ORDER BY name").all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 60 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

function insertAccount(db: DatabaseSync, accountId: string): void {
  db.prepare(`INSERT INTO content_accounts
    (account_id, platform, external_account_id, handle, token_ciphertext, scopes, status, created_at, updated_at,
     last_event_sequence)
    VALUES (?, 'x', ?, '@acme', 'ciphertext', 'tweet.write', 'connected', '2026-01-04', '2026-01-04', 3)`).run(
    accountId,
    `external-${accountId}`,
  );
}

function insertPost(db: DatabaseSync, postId: string): void {
  db.prepare(`INSERT INTO content_posts
    (post_id, body, approval_state, timezone, author_agent_id, created_at, updated_at, last_event_sequence)
    VALUES (?, 'Launch 界', 'pending', 'Europe/Warsaw', 'herald', '2026-01-04', '2026-01-04', 4)`).run(postId);
}

function insertVariant(
  db: DatabaseSync,
  variantId: string,
  postId: string,
  platform: string,
  accountId: string | null,
) {
  db.prepare(`INSERT INTO content_variants
    (variant_id, post_id, platform, account_id, status, created_at, updated_at, last_event_sequence)
    VALUES (?, ?, ?, ?, 'draft', '2026-01-04', '2026-01-04', 4)`).run(variantId, postId, platform, accountId);
}

describe("content migration", () => {
  it("preserves every row from schema 59 and adds the empty content tables", () => {
    const db = databaseAt(59);
    seed(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...CONTENT_TABLES });
    expect(contentObjects(db)).toEqual(CONTENT_OBJECTS);
    expectHealthy(db);
  });

  it.each([8, 25, 40, 58])("preserves every row from released schema %i through migration 60", (version) => {
    const db = databaseAt(version);
    // The earlier migrations run first; the rows after them are what v60 must keep.
    migrateUpTo(db, 59);
    seed(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...CONTENT_TABLES });
    expectHealthy(db);
  });

  it("rolls back the tables and the marker after a late failure, then retries", () => {
    const db = databaseAt(59);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=60
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 60 failed");
    expect(contents(db)).toEqual(before);
    expect(contentObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=60").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...CONTENT_TABLES });
    expect(contentObjects(db)).toEqual(CONTENT_OBJECTS);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it creates the tables", () => {
    const db = databaseAt(59);
    seed(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(61,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=61; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(contentObjects(db)).toEqual([]);
  });

  it("deletes variants with their post, unbinds them from a deleted account, and keeps one per platform", () => {
    const db = databaseAt(59);
    seed(db);
    migrateOpenBotDatabase(db);
    insertAccount(db, "account-1");
    insertPost(db, "post-1");
    insertPost(db, "post-2");
    insertVariant(db, "variant-1", "post-1", "x", "account-1");
    insertVariant(db, "variant-2", "post-1", "linkedin", null);
    insertVariant(db, "variant-3", "post-2", "x", "account-1");
    expect(() => insertVariant(db, "variant-4", "post-1", "x", null)).toThrow("UNIQUE constraint failed");
    expect(() => insertVariant(db, "variant-5", "missing", "x", null)).toThrow("FOREIGN KEY constraint failed");
    expect(() => insertVariant(db, "variant-6", "post-1", "threads", "missing")).toThrow(
      "FOREIGN KEY constraint failed",
    );

    db.prepare("DELETE FROM content_posts WHERE post_id = 'post-1'").run();
    expect(db.prepare("SELECT variant_id FROM content_variants ORDER BY variant_id").all()).toEqual([
      { variant_id: "variant-3" },
    ]);

    db.prepare("DELETE FROM content_accounts WHERE account_id = 'account-1'").run();
    expect(db.prepare("SELECT variant_id, account_id FROM content_variants").all()).toEqual([
      { variant_id: "variant-3", account_id: null },
    ]);
    expect(db.prepare("SELECT post_id, author_agent_id FROM content_posts").all()).toEqual([
      { post_id: "post-2", author_agent_id: "herald" },
    ]);
    expectHealthy(db);
  });

  it("refuses a stored status or approval state outside the released values", () => {
    const db = databaseAt(59);
    migrateOpenBotDatabase(db);
    expect(() =>
      db
        .prepare(`INSERT INTO content_posts
          (post_id, body, approval_state, timezone, created_at, updated_at, last_event_sequence)
          VALUES ('post-1', 'x', 'rejected', 'UTC', 'now', 'now', 1)`)
        .run(),
    ).toThrow("CHECK constraint failed");
    insertPost(db, "post-1");
    expect(() =>
      db
        .prepare(`INSERT INTO content_variants
          (variant_id, post_id, platform, status, created_at, updated_at, last_event_sequence)
          VALUES ('variant-1', 'post-1', 'x', 'needs-attention', 'now', 'now', 1)`)
        .run(),
    ).toThrow("CHECK constraint failed");
    expectHealthy(db);
  });
});
