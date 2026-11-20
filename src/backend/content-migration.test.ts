// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptForkContentSchema,
  LATEST_CONTENT_SCHEMA_VERSION,
  migrateContentSchema,
} from "./content/content-migrations";
import { CONTENT_SCHEMA_SQL } from "./content/content-schema";
import { migrateOpenBotDatabase, NewerDatabaseError } from "./openbot-database-schema";

// Failure modes: the content steps change or lose a row of any table; a failed step leaves a column or its
// marker; a newer or incomplete content history is accepted, or refused with the core error that installs the
// official release; the core record gets a content version, so an upstream merge collides with it; a database
// that a fork build migrated under core 60/61 or 62/63 keeps those rows and never runs upstream's 60 and 61;
// deleting a post leaves its variants; deleting an account deletes its variants instead of unbinding them.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** The newest core version of this build: read from a fresh database, so an upstream merge needs no change here. */
const CORE_LATEST = (() => {
  const db = new DatabaseSync(":memory:");
  migrateOpenBotDatabase(db);
  const version = Number(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version);
  db.close();
  return version;
})();
const CONTENT_OBJECTS = [
  { type: "table", name: "content_accounts" },
  { type: "table", name: "content_posts" },
  { type: "index", name: "content_posts_schedule" },
  { type: "table", name: "content_schema_migrations" },
  { type: "table", name: "content_variants" },
  { type: "index", name: "content_variants_account" },
  { type: "index", name: "content_variants_status" },
];

/** The start path of `DatabaseCore#migrate`, in its order. */
function start(db: DatabaseSync): void {
  adoptForkContentSchema(db);
  migrateOpenBotDatabase(db);
  migrateContentSchema(db);
}

/** A database migrated by the core steps up to `version`, with no content tables: what an official build left. */
function coreAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateCoreTo(db, version);
  return db;
}

/** Runs the core steps up to `version` and stops there. */
function migrateCoreTo(db: DatabaseSync, version: number): void {
  if (version >= CORE_LATEST) {
    migrateOpenBotDatabase(db);
    return;
  }
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** Rows in tables of core schema 59: an event, a memory, a Slack connection and a ping. */
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

/** Content rows: an account, two posts, and a published, a failed and a waiting variant. */
function seedContent(db: DatabaseSync): void {
  db.prepare(`INSERT INTO content_accounts
    (account_id, platform, external_account_id, handle, token_ciphertext, scopes, status, created_at, updated_at,
     last_event_sequence)
    VALUES ('account-1', 'x', 'external-1', '@acme', 'ciphertext', 'tweet.write', 'connected', '2026-01-04',
      '2026-01-04', 3)`).run();
  for (const postId of ["post-1", "post-2"])
    db.prepare(`INSERT INTO content_posts
      (post_id, body, approval_state, timezone, author_agent_id, created_at, updated_at, last_event_sequence)
      VALUES (?, 'Launch 界', 'pending', 'Europe/Warsaw', 'herald', '2026-01-04', '2026-01-04', 4)`).run(postId);
  db.prepare(`INSERT INTO content_variants
    (variant_id, post_id, platform, account_id, body, status, attempt, pending_data, external_post_id, error_code, error,
     published_at, created_at, updated_at, last_event_sequence)
    VALUES
      ('variant-1', 'post-1', 'x', 'account-1', 'Own 界', 'published', 1, NULL, '1001', NULL, NULL, '2026-01-05',
       '2026-01-04', '2026-01-05', 5),
      ('variant-2', 'post-1', 'linkedin', NULL, NULL, 'failed', 2, NULL, NULL, 'rejected', 'LinkedIn refused "it"',
       NULL, '2026-01-04', '2026-01-05', 6),
      ('variant-3', 'post-2', 'instagram', 'account-1', NULL, 'publishing', 1,
       '{"checkAt":"2026-01-06","data":"container-1","hostedKey":"t/abc.jpg","reason":"processing"}', NULL, NULL, NULL,
       NULL, '2026-01-04', '2026-01-05', 7)`).run();
}

/**
 * A database that a fork build migrated before the content record existed: the content tables (with the link
 * column when `withLink`), and the fork's core versions. Before the 0.69 merge the fork recorded 60 and 61 in
 * place of upstream's work; after it, upstream's 60 and 61 ran and the fork recorded 62 and 63.
 */
function forkDatabase(forkVersions: readonly number[], withLink: boolean): DatabaseSync {
  const db = coreAt(59);
  seed(db);
  // The 0.69 fork build ran upstream's 60 and 61 only; upstream's own 62 came later.
  if (forkVersions.includes(62)) migrateCoreTo(db, 61);
  db.exec(CONTENT_SCHEMA_SQL);
  if (withLink) db.exec("ALTER TABLE content_variants ADD COLUMN external_url TEXT");
  const insert = db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 'fork')");
  for (const version of forkVersions) insert.run(version);
  seedContent(db);
  return db;
}

function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('schema_migrations', 'content_schema_migrations') AND name NOT LIKE 'agent_memory_search%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function contentObjects(db: DatabaseSync) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'content_%' ORDER BY name").all();
}

function versions(db: DatabaseSync, table: string): number[] {
  return db
    .prepare(`SELECT version FROM ${table} ORDER BY version`)
    .all()
    .map((row) => Number(row.version));
}

function columns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

/** The rows with one more column set to null, as an ADD COLUMN with no default leaves them. */
function withNullColumn(rows: unknown[], column: string): unknown[] {
  return rows.map((row) => (isDynamicRecord(row) ? { ...row, [column]: null } : row));
}

function expectHealthy(db: DatabaseSync): void {
  const core = versions(db, "schema_migrations").filter((version) => version >= 8);
  expect(core).toEqual(Array.from({ length: CORE_LATEST - 7 }, (_, index) => index + 8));
  expect(versions(db, "content_schema_migrations")).toEqual([1, 2]);
  expect(columns(db, "projection_agent_memories")).toContain("site");
  expect(columns(db, "content_variants")).toContain("external_url");
  // Upstream's 61 and 62 ran, also on an adopted fork database.
  for (const name of ["projection_pinned_thread_messages", "projection_messaging_history"])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(name)).toEqual([{ name }]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("content migrations", () => {
  it("keeps the core record upstream's and puts the content tables in their own record", () => {
    expect(LATEST_CONTENT_SCHEMA_VERSION).toBe(2);
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    start(db);
    expect(contentObjects(db)).toEqual(CONTENT_OBJECTS);
    expectHealthy(db);
  });

  it.each([8, 40, 58])("upgrades released core schema %i and adds the empty content tables", (version) => {
    // Core migrations after `version` may reshape older tables; their own tests cover that. This checks the
    // content tables and the record.
    const db = coreAt(version);
    start(db);
    for (const table of ["content_accounts", "content_posts", "content_variants"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expectHealthy(db);
  });

  it.each([59, 60, 61, 62])(
    "keeps every row from released core schema %i and adds the empty content tables",
    (version) => {
      const db = coreAt(version);
      seed(db);
      const before = contents(db);
      start(db);
      const after = contents(db);
      for (const table of ["content_accounts", "content_posts", "content_variants"]) expect(after[table]).toEqual([]);
      // Each table that existed keeps its rows; core 60 gives each memory a null site.
      for (const [table, rows] of Object.entries(before))
        expect(after[table]).toEqual(
          table === "projection_agent_memories" && version < 60 ? withNullColumn(rows, "site") : rows,
        );
      expectHealthy(db);
    },
  );

  it.each([
    ["the pre-merge fork (content at core 60 and 61)", [60, 61], true],
    ["the pre-merge fork before the link (content at core 60)", [60], false],
    ["the merged fork (content at core 62 and 63)", [62, 63], true],
  ] as const)("adopts a database of %s and runs upstream's 60 and 61", (_name, forkVersions, withLink) => {
    const db = forkDatabase(forkVersions, withLink);
    const variantsBefore = db.prepare("SELECT * FROM content_variants ORDER BY variant_id").all();
    start(db);
    const variantsAfter = db.prepare("SELECT * FROM content_variants ORDER BY variant_id").all();
    expect(variantsAfter).toEqual(withLink ? variantsBefore : withNullColumn(variantsBefore, "external_url"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM content_posts").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT memory_id, site FROM projection_agent_memories").all()).toEqual([
      { memory_id: "memory-1", site: null },
    ]);
    expectHealthy(db);
    // A second start changes nothing.
    const settled = contents(db);
    start(db);
    expect(contents(db)).toEqual(settled);
    expectHealthy(db);
  });

  it("leaves a later official release alone: no content tables, so no adoption", () => {
    const db = coreAt(CORE_LATEST);
    db.prepare("INSERT INTO schema_migrations VALUES (?, 'official')").run(CORE_LATEST + 1);
    adoptForkContentSchema(db);
    expect(versions(db, "schema_migrations").at(-1)).toBe(CORE_LATEST + 1);
    // This build does not know the next core version, so the core refusal of a newer database still applies.
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
  });

  it("rolls back a failed content step and its marker, then retries", () => {
    const db = coreAt(CORE_LATEST);
    db.exec("CREATE TABLE content_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON content_schema_migrations WHEN new.version = 2
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateContentSchema(db)).toThrow("content migration to version 2 failed");
    expect(versions(db, "content_schema_migrations")).toEqual([1]);
    expect(columns(db, "content_variants")).not.toContain("external_url");
    expect(db.isTransaction).toBe(false);
    db.exec("DROP TRIGGER fail_marker");
    migrateContentSchema(db);
    expect(versions(db, "content_schema_migrations")).toEqual([1, 2]);
    expect(columns(db, "content_variants")).toContain("external_url");
  });

  it("refuses a newer or incomplete content history with a plain error, and changes nothing", () => {
    const db = coreAt(CORE_LATEST);
    start(db);
    db.exec("INSERT INTO content_schema_migrations VALUES (3, 'newer')");
    const before = contents(db);
    let newer: unknown = null;
    try {
      migrateContentSchema(db);
    } catch (error) {
      newer = error;
    }
    expect(String(newer)).toContain("content database version 3 is newer than this build supports (2)");
    // Not the core NewerDatabaseError: that one starts the recovery that installs the official release.
    expect(newer).toBeInstanceOf(Error);
    expect(newer).not.toBeInstanceOf(NewerDatabaseError);
    db.exec("DELETE FROM content_schema_migrations WHERE version IN (1, 3)");
    expect(() => migrateContentSchema(db)).toThrow("content migration history is missing version 1");
    expect(contents(db)).toEqual(before);
  });

  it("deletes variants with their post, unbinds them from a deleted account, and keeps one per platform", () => {
    const db = coreAt(CORE_LATEST);
    start(db);
    seedContent(db);
    const insertVariant = (variantId: string, postId: string) =>
      db
        .prepare(`INSERT INTO content_variants (variant_id, post_id, platform, status, created_at, updated_at,
          last_event_sequence) VALUES (?, ?, 'x', 'draft', 'now', 'now', 1)`)
        .run(variantId, postId);
    expect(() => insertVariant("variant-4", "post-1")).toThrow("UNIQUE constraint failed");
    expect(() => insertVariant("variant-5", "missing")).toThrow("FOREIGN KEY constraint failed");
    db.prepare("DELETE FROM content_posts WHERE post_id = 'post-1'").run();
    expect(db.prepare("SELECT variant_id FROM content_variants ORDER BY variant_id").all()).toEqual([
      { variant_id: "variant-3" },
    ]);
    db.prepare("DELETE FROM content_accounts WHERE account_id = 'account-1'").run();
    expect(db.prepare("SELECT variant_id, account_id FROM content_variants").all()).toEqual([
      { variant_id: "variant-3", account_id: null },
    ]);
    expect(() =>
      db
        .prepare(`INSERT INTO content_posts (post_id, body, approval_state, timezone, created_at, updated_at,
          last_event_sequence) VALUES ('post-9', 'x', 'rejected', 'UTC', 'now', 'now', 1)`)
        .run(),
    ).toThrow("CHECK constraint failed");
    expectHealthy(db);
  });
});
