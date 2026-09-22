/**
 * Parity between the three places the domain is described.
 *
 * The SQL migrations are the source of truth. The Drizzle tables exist for
 * typed queries, and the shared constants exist for validation and UI. Nothing
 * stops those three drifting apart except this file, and drift here is the
 * quiet kind: a renamed column that only breaks at runtime, an enum value the
 * UI offers and the database rejects, a plan feature that is gated in code and
 * not in the seeded plan row.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PG_ENUMS, PLANS, PLAN_FEATURES } from "@platform/shared";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { adminPool, asAdmin } from "./helpers";
import * as tables from "../src/schema/tables";

afterAll(async () => {
  await adminPool.end();
});

describe("enums", () => {
  it("match the database exactly, in both directions", async () => {
    const inDatabase = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ type_name: string; values: string[] }>(
        // enumlabel is `name`, and node-postgres has no parser for name[], so
        // it would arrive as the raw string "{a,b,c}". Cast to text[].
        `select t.typname as type_name,
                array_agg(en.enumlabel::text order by en.enumsortorder) as values
           from pg_type t
           join pg_enum en on en.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
          group by t.typname`,
      );
      return new Map(rows.map((r) => [r.type_name, r.values]));
    });

    for (const [name, values] of Object.entries(PG_ENUMS)) {
      expect(inDatabase.has(name), `enum ${name} is declared in shared but missing from the database`).toBe(true);
      expect([...values].sort(), `enum ${name} differs between shared and the database`).toEqual(
        [...inDatabase.get(name)!].sort(),
      );
    }

    // And nothing in the database that shared does not know about.
    const undeclared = [...inDatabase.keys()].filter((n) => !(n in PG_ENUMS));
    expect(undeclared, "these enums exist in the database but are not declared in shared").toEqual([]);
  });
});

describe("drizzle tables", () => {
  const declared = Object.entries(tables).filter(
    ([, value]) => typeof value === "object" && value !== null,
  ) as [string, PgTable][];

  it("cover every table in the database", async () => {
    const inDatabase = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      return rows.map((r) => r.tablename).sort();
    });

    const inDrizzle = declared.map(([, t]) => getTableConfig(t).name).sort();
    expect(inDrizzle).toEqual(inDatabase);
  });

  it("declare columns that all exist, with matching nullability", async () => {
    const columns = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(
        `select table_name, column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public'`,
      );
      const map = new Map<string, Map<string, boolean>>();
      for (const r of rows) {
        if (!map.has(r.table_name)) map.set(r.table_name, new Map());
        map.get(r.table_name)!.set(r.column_name, r.is_nullable === "YES");
      }
      return map;
    });

    const problems: string[] = [];

    for (const [exportName, table] of declared) {
      const config = getTableConfig(table);
      const dbColumns = columns.get(config.name);
      if (!dbColumns) {
        problems.push(`${exportName}: table ${config.name} does not exist`);
        continue;
      }

      for (const column of config.columns) {
        if (!dbColumns.has(column.name)) {
          problems.push(`${config.name}.${column.name} is declared in Drizzle but not in the database`);
          continue;
        }
        const dbNullable = dbColumns.get(column.name)!;
        const drizzleNullable = !column.notNull;
        if (dbNullable !== drizzleNullable) {
          problems.push(
            `${config.name}.${column.name}: database says ${dbNullable ? "nullable" : "NOT NULL"}, Drizzle says ${drizzleNullable ? "nullable" : "NOT NULL"}`,
          );
        }
      }

      // The reverse direction: a column added in SQL and forgotten in Drizzle
      // is invisible to every query the application writes.
      const drizzleNames = new Set(config.columns.map((c) => c.name));
      for (const dbColumn of dbColumns.keys()) {
        if (!drizzleNames.has(dbColumn)) {
          problems.push(`${config.name}.${dbColumn} exists in the database but is missing from Drizzle`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe("plans", () => {
  it("seed the same tiers the code gates on", async () => {
    const inDatabase = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{
        key: string;
        price_monthly: string;
        included_jobs_per_month: number | null;
        features: Record<string, boolean>;
      }>("select key, price_monthly, included_jobs_per_month, features from public.plans");
      return new Map(rows.map((r) => [r.key, r]));
    });

    for (const plan of PLANS) {
      const row = inDatabase.get(plan.key);
      expect(row, `plan "${plan.key}" is defined in shared but not seeded`).toBeDefined();
      expect(Number(row!.price_monthly), `price differs for ${plan.key}`).toBe(plan.priceMonthly);
      expect(row!.included_jobs_per_month, `included jobs differ for ${plan.key}`).toBe(
        plan.includedJobsPerMonth,
      );

      for (const feature of PLAN_FEATURES) {
        expect(
          row!.features[feature],
          `feature "${feature}" differs between shared and the seeded plan for ${plan.key}`,
        ).toBe(plan.features[feature]);
      }
    }

    const unknown = [...inDatabase.keys()].filter((k) => !PLANS.some((p) => p.key === k));
    expect(unknown, "these plans are seeded but unknown to the application").toEqual([]);
  });

  it("gives every seeded plan a complete feature map", async () => {
    // A missing key reads as false, which silently removes a feature a
    // customer is paying for.
    const incomplete = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ key: string; features: Record<string, boolean> }>(
        "select key, features from public.plans",
      );
      return rows
        .map((r) => ({
          key: r.key,
          missing: PLAN_FEATURES.filter((f) => !(f in r.features)),
        }))
        .filter((r) => r.missing.length > 0);
    });
    expect(incomplete).toEqual([]);
  });
});
