/**
 * Migration runner.
 *
 * Applies every .sql file in supabase/migrations in filename order, each in its
 * own transaction.
 *
 *   pnpm migrate            apply anything outstanding
 *   pnpm status             list applied and pending, change nothing
 *   pnpm reset              drop and rebuild from scratch (local only)
 *
 * Migrations live under supabase/ and are named the way the Supabase CLI wants
 * them, so `supabase db push` and `supabase start` work on exactly the same
 * files. This runner exists alongside the CLI rather than instead of it,
 * because CI applies the schema to a bare Postgres container where no CLI is
 * installed, and because the row level security suite needs to rebuild the
 * database repeatedly.
 *
 * Crucially it records what it applied in `supabase_migrations.schema_migrations`,
 * the same table the CLI reads. That means the two agree about what is already
 * applied, and running one after the other does not try to create everything
 * twice.
 *
 * Uses DATABASE_MIGRATION_URL when set, because migrating needs rights the
 * application's own connection should not have.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "supabase", "migrations");

const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error("Set DATABASE_MIGRATION_URL or DATABASE_URL before running migrations.");
  process.exit(1);
}

const shouldReset = process.argv.includes("--reset");
/**
 * Read-only. Reports what is applied and what is pending without touching
 * anything, including without creating the ledger table. Worth having before
 * pointing this at a hosted project for the first time: it answers "what is
 * about to happen" without committing to it.
 */
const statusOnly = process.argv.includes("--status");

/** Filenames are <14-digit version>_<name>.sql, as the Supabase CLI requires. */
function parseFilename(filename: string): { version: string; name: string } | null {
  const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
  if (!match) return null;
  return { version: match[1]!, name: match[2]! };
}

function isLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Lists applied and pending migrations. Opens no transaction and writes nothing. */
async function reportStatus(client: pg.Client, files: string[]): Promise<void> {
  // to_regclass rather than a create-if-missing, so asking the question cannot
  // itself change the answer.
  const { rows: ledger } = await client.query<{ present: string | null }>(
    "select to_regclass('supabase_migrations.schema_migrations')::text as present",
  );

  const applied = new Set<string>();
  if (ledger[0]?.present) {
    const { rows } = await client.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations",
    );
    for (const row of rows) applied.add(row.version);
  } else {
    console.log("No migration ledger yet: this database has never been migrated.\n");
  }

  let pending = 0;
  for (const filename of files) {
    const parsed = parseFilename(filename);
    if (!parsed) continue;
    const isApplied = applied.has(parsed.version);
    if (!isApplied) pending += 1;
    console.log(`  ${isApplied ? "applied" : "PENDING"}  ${filename}`);
  }

  // A version in the ledger with no matching file means the database is ahead
  // of this checkout, which is worth knowing before applying anything.
  const known = new Set(
    files.map((f) => parseFilename(f)?.version).filter((v): v is string => Boolean(v)),
  );
  const orphans = [...applied].filter((v) => !known.has(v)).sort();

  console.log(`\n${applied.size} applied, ${pending} pending.`);
  if (orphans.length > 0) {
    console.log(
      `\nWarning: the database records ${orphans.length} migration(s) not present in this checkout:\n  ${orphans.join("\n  ")}\nThat usually means the branch is behind what has been deployed.`,
    );
  }
}

async function main(): Promise<void> {
  if (statusOnly && shouldReset) {
    console.error("--status and --reset do the opposite of each other. Pick one.");
    process.exit(1);
  }

  // Checked before connecting, so a mistyped host fails on this rather than on
  // DNS, and so nothing is opened against a database we are about to refuse to
  // touch. Dropping every table is not something to do to a hosted project by
  // accident, and a mistyped DATABASE_URL is an easy accident.
  if (shouldReset && !isLocal(connectionString!) && !process.env.ALLOW_REMOTE_RESET) {
    console.error(
      "Refusing to reset a non-local database. Set ALLOW_REMOTE_RESET=1 if you really mean it.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (statusOnly) {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      await reportStatus(client, files);
      return;
    }

    if (shouldReset) {
      console.log("Resetting schema...");
      // `app` and `public` are ours to rebuild, and the migration ledger goes
      // with them so everything reapplies. `auth` is left alone: on a real
      // Supabase project it holds the user accounts, and dropping it would take
      // every login with it.
      await client.query(`
        drop schema if exists app cascade;
        drop schema if exists public cascade;
        drop schema if exists supabase_migrations cascade;
        create schema public;
      `);
      await client.query("grant usage on schema public to public;");
    }

    // The CLI's own ledger. Created here so a bare Postgres works too; on a
    // real project it already exists and this is a no-op.
    await client.query(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version    text primary key,
        statements text[],
        name       text
      );
    `);
    // Older projects predate these columns.
    await client.query(`
      alter table supabase_migrations.schema_migrations
        add column if not exists statements text[];
      alter table supabase_migrations.schema_migrations
        add column if not exists name text;
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

    const malformed = files.filter((f) => parseFilename(f) === null);
    if (malformed.length > 0) {
      throw new Error(
        `These migration filenames are not in <version>_<name>.sql form, which the Supabase CLI requires:\n  ${malformed.join("\n  ")}`,
      );
    }

    const { rows: applied } = await client.query<{ version: string; statements: string[] | null }>(
      "select version, statements from supabase_migrations.schema_migrations",
    );
    const appliedByVersion = new Map(applied.map((r) => [r.version, r.statements?.[0] ?? null]));

    let ran = 0;

    for (const filename of files) {
      const { version, name } = parseFilename(filename)!;
      const sql = await readFile(join(migrationsDir, filename), "utf8");

      if (appliedByVersion.has(version)) {
        const previous = appliedByVersion.get(version);
        // Only meaningful for migrations this runner applied; ones applied by
        // the CLI store their statements split differently, so a mismatch
        // there is not evidence of tampering.
        if (previous !== null && previous !== undefined && previous !== sql) {
          throw new Error(
            `${filename} has changed since it was applied. Add a new migration instead of editing this one, or run with --reset in development.`,
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${filename} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          `insert into supabase_migrations.schema_migrations (version, name, statements)
           values ($1, $2, $3)`,
          [version, name, [sql]],
        );
        await client.query("commit");
        console.log("ok");
        ran += 1;
      } catch (error) {
        await client.query("rollback");
        console.log("failed");
        throw error;
      }
    }

    console.log(ran === 0 ? "Already up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("\nMigration failed.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// Checksums are computed the same way regardless of platform; kept as a helper
// so a future `verify` command can reuse it.
export function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}
