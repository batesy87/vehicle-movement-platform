/**
 * Migration runner.
 *
 * Applies every .sql file in migrations/ in filename order, each in its own
 * transaction, recording what ran in schema_migrations. Deliberately small:
 * the schema is the artefact worth reviewing, not the tool that applies it.
 *
 *   tsx scripts/migrate.ts            apply anything outstanding
 *   tsx scripts/migrate.ts --reset    drop and rebuild from scratch
 *
 * Uses DATABASE_MIGRATION_URL when set, because migrating needs rights that
 * the application's own connection should not have.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error("Set DATABASE_MIGRATION_URL or DATABASE_URL before running migrations.");
  process.exit(1);
}

const shouldReset = process.argv.includes("--reset");

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (shouldReset) {
      console.log("Resetting schema...");
      // `app` and `public` are ours to rebuild. `auth` is left alone: on a real
      // Supabase project it holds the user accounts, and dropping it would take
      // every login with it.
      await client.query(`
        drop schema if exists app cascade;
        drop schema if exists public cascade;
        create schema public;
      `);
      // Recreate the default grants a fresh database would have had.
      await client.query(`grant usage on schema public to public;`);
    }

    await client.query(`
      create table if not exists public.schema_migrations (
        filename    text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      );
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

    const { rows: applied } = await client.query<{ filename: string; checksum: string }>(
      "select filename, checksum from public.schema_migrations",
    );
    const appliedByName = new Map(applied.map((r) => [r.filename, r.checksum]));

    let ran = 0;

    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = appliedByName.get(filename);

      if (previous) {
        if (previous !== checksum) {
          // Editing an applied migration means the database and the repo
          // disagree about what the schema is. Better to stop than to guess.
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
          "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
          [filename, checksum],
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
