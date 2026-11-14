// The content manager is a fork feature, so its tables have their own migration record:
// `content_schema_migrations`, with versions that count from 1. The core record (`schema_migrations`)
// stays the same as upstream OpenBot's, so the core version numbers of a merge never collide with these.
// The official app reads only `schema_migrations`, so it opens a database that this fork changed.
//
// `DatabaseCore` calls `adoptForkContentSchema` before the core migrations and `migrateContentSchema`
// after them, on one connection.

import type { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { CONTENT_SCHEMA_SQL } from "./content-schema";

const logger = createOpenBotLogger("content-migrations");

const CONTENT_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS content_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

/** The content tables: a step checks only their foreign keys, as other tables are not the content steps' work. */
const CONTENT_TABLES = ["content_accounts", "content_posts", "content_variants"] as const;

/**
 * The first core version that the fork used for the content tables. Upstream shipped core 60 and 61 with other
 * changes, so a fork database that recorded 60 and later never ran them.
 */
const FIRST_FORK_CORE_VERSION = 60;

interface ContentMigration {
  version: number;
  up: (db: DatabaseSync) => void;
}

/** Each step is idempotent: a database that the fork changed before this record existed runs them again. */
const CONTENT_MIGRATIONS: readonly ContentMigration[] = [
  // The three content tables and their indexes, empty.
  { version: 1, up: (db) => db.exec(CONTENT_SCHEMA_SQL) },
  // The link that a network returns for a published post. No default: a post published before it has no link.
  { version: 2, up: addVariantUrl },
];

/** The newest content version that this build knows. */
export const LATEST_CONTENT_SCHEMA_VERSION = CONTENT_MIGRATIONS.at(-1)?.version ?? 0;

/**
 * A database that a fork build migrated before the content record existed has the content tables, and its core
 * record has the fork's versions (60 and 61 before the 0.69 merge, 62 and 63 after it). Those core versions are
 * removed. The core migrations then run upstream's 60 and later, which are idempotent, and the content steps
 * record their own versions. The evidence is the schema, not a version number: a database from a later official
 * release has its own 62 and later, and no content tables.
 */
export function adoptForkContentSchema(db: DatabaseSync): void {
  if (
    !hasTable(db, "content_variants") ||
    hasTable(db, "content_schema_migrations") ||
    !hasTable(db, "schema_migrations")
  )
    return;
  const removed = db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(FIRST_FORK_CORE_VERSION).changes;
  logger.info("The content tables now have their own migration record.", { removedCoreVersions: removed });
}

/** Runs the pending content steps, one transaction each, after the core migrations. */
export function migrateContentSchema(db: DatabaseSync, appliedAt = new Date().toISOString()): void {
  db.exec(CONTENT_MIGRATIONS_SQL);
  const applied = readAppliedVersions(db);
  const newest = applied.at(-1) ?? 0;
  // A plain Error: `NewerDatabaseError` would start the recovery that installs the official release over the fork.
  if (newest > LATEST_CONTENT_SCHEMA_VERSION)
    throw new Error(
      `OpenBot content database version ${newest} is newer than this build supports (${LATEST_CONTENT_SCHEMA_VERSION}).`,
    );
  for (let version = 1; version <= newest; version += 1)
    if (!applied.includes(version)) throw new Error(`OpenBot content migration history is missing version ${version}.`);
  for (const migration of CONTENT_MIGRATIONS) {
    if (migration.version <= newest) continue;
    try {
      runMigration(db, migration, appliedAt);
    } catch (error) {
      logger.error(`OpenBot content migration to version ${migration.version} failed.`, toLogValue(error));
      throw new Error(`OpenBot content migration to version ${migration.version} failed.`, { cause: error });
    }
  }
}

function runMigration(db: DatabaseSync, migration: ContentMigration, appliedAt: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    migration.up(db);
    db.prepare("INSERT INTO content_schema_migrations(version, applied_at) VALUES (?, ?)").run(
      migration.version,
      appliedAt,
    );
    for (const table of CONTENT_TABLES) {
      if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0)
        throw new Error(`OpenBot content migration produced foreign-key violations in ${table}.`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function addVariantUrl(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(content_variants)").all();
  if (columns.some((column) => isDynamicRecord(column) && column.name === "external_url")) return;
  db.exec("ALTER TABLE content_variants ADD COLUMN external_url TEXT");
}

function readAppliedVersions(db: DatabaseSync): number[] {
  return db
    .prepare("SELECT version FROM content_schema_migrations ORDER BY version")
    .all()
    .map((row) => {
      if (!isDynamicRecord(row) || !isNumber(row.version) || !Number.isInteger(row.version))
        throw new Error("OpenBot database contains an invalid content migration version.");
      return row.version;
    });
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
