/**
 * Cross-tenant isolation, table by table.
 *
 * This suite is the reason the foundation phase exists. It enumerates every
 * tenant-scoped table from the live catalogue rather than from a hand-written
 * list, so a table added next year is covered the moment it appears. For each
 * one it seeds a row in company B and asserts that company A cannot see it,
 * cannot claim it, cannot change it and cannot delete it.
 *
 * A missed `where company_id = ...` in application code has to be harmless.
 * That is the property under test.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actingAs,
  adminPool,
  asAdmin,
  createDriverProfile,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers";

/** Tables intentionally outside the company_id rule, with the reason. */
const NOT_TENANT_SCOPED: Record<string, string> = {
  plans: "global reference data, public by design",
  companies: "the tenant itself, scoped by id rather than company_id",
  driver_profiles: "global driver identity, shared across tenants by design",
  schema_migrations: "migration bookkeeping, not application data",
};

let companyA: SeededCompany;
let companyB: SeededCompany;

/**
 * Discovered at module load, not in beforeAll, because `it.each` is resolved
 * while tests are being collected and beforeAll has not run by then. Reading
 * the catalogue here is what makes the suite self-extending: add a table, get
 * its isolation tests for free.
 */
const tenantTables: string[] = await asAdmin(async (tx) => {
  const { rows } = await tx.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return rows.map((r) => r.tablename).filter((t) => !(t in NOT_TENANT_SCOPED));
});

/**
 * One row belonging to company B for each tenant-scoped table, discovered by
 * querying as the owning role after the fixtures are built. Any table the
 * fixture does not populate is reported rather than silently skipped.
 */
let companyBRows: Map<string, string | number>;

beforeAll(async () => {
  await truncateAll();

  const driver = await createDriverProfile("Shared Driver");
  companyA = await seedCompany("Alpha Transport", driver.driverProfileId);
  companyB = await seedCompany("Bravo Logistics", driver.driverProfileId);

  // Give company B a row in every remaining table so there is something for
  // company A to fail to reach.
  await seedRemainingTables(companyB, driver.driverProfileId);

  companyBRows = new Map();
  await asAdmin(async (tx) => {
    for (const table of tenantTables) {
      const { rows: pk } = await tx.query<{ column_name: string }>(
        `select a.attname as column_name
           from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = $1::regclass and i.indisprimary
          limit 1`,
        [`public.${table}`],
      );
      const key = pk[0]?.column_name ?? "company_id";
      const { rows } = await tx.query(
        `select ${key} as id from public.${table} where company_id = $1 limit 1`,
        [companyB.companyId],
      );
      if (rows[0]) companyBRows.set(table, (rows[0] as { id: string | number }).id);
    }
  });
});

afterAll(async () => {
  await adminPool.end();
});

async function seedRemainingTables(company: SeededCompany, driverProfileId: string): Promise<void> {
  const acting = { userId: company.dispatcherId, companyId: company.companyId };
  const owner = { userId: company.ownerId, companyId: company.companyId };

  await actingAs(acting, async (tx) => {
    await tx.query(
      `insert into public.vehicles (company_id, registration, make, model)
       values ($1, 'ZZ99ZZZ', 'Vauxhall', 'Vivaro')`,
      [company.companyId],
    );
    await tx.query(
      `insert into public.trip_stops (company_id, trip_id, leg_id, kind, sequence)
       values ($1, $2, $3, 'collection', 1)`,
      [company.companyId, company.tripId, company.legId],
    );
    // Through the real RPC, so the fixture exercises the invitation path
    // rather than hand-writing a row the application would never produce.
    await tx.query("select public.invite_driver($1, $2, $3)", [
      company.companyId,
      `pending-${company.companyId}@drivers.test`,
      randomUUID() + randomUUID(),
    ]);
  });

  await actingAs(owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.rate_cards (company_id, name, basis, flat_amount)
       values ($1, 'Standard', 'flat', 120.00) returning id`,
      [company.companyId],
    );
    await tx.query(
      `insert into public.rate_card_bands (company_id, rate_card_id, range_from, range_to, value_flat, value_per)
       values ($1, $2, 0, 50, 15.00, 1.20)`,
      [company.companyId, rows[0]!.id],
    );
    const { rows: inv } = await tx.query<{ id: string }>(
      `insert into public.invoices (company_id, client_id, invoice_no, status)
       values ($1, $2, 1, 'draft') returning id`,
      [company.companyId, company.clientId],
    );
    await tx.query(
      `insert into public.invoice_lines (company_id, invoice_id, description, unit_amount, line_total)
       values ($1, $2, 'Vehicle movement', 120.00, 120.00)`,
      [company.companyId, inv[0]!.id],
    );
    await tx.query(
      `insert into public.audit_log (company_id, table_name, record_id, action)
       values ($1, 'consignments', $2, 'update')`,
      [company.companyId, company.consignmentId],
    );
  });

  // Driver-owned rows: custody evidence, media and breadcrumbs.
  const driverAuthId = await asAdmin(async (tx) => {
    const { rows } = await tx.query<{ auth_user_id: string }>(
      "select auth_user_id from public.driver_profiles where id = $1",
      [driverProfileId],
    );
    return rows[0]!.auth_user_id;
  });

  await actingAs({ userId: driverAuthId, companyId: company.companyId }, async (tx) => {
    const { rows: media } = await tx.query<{ id: string }>(
      `insert into public.media_objects
         (company_id, kind, object_key, content_type, uploaded_by)
       values ($1, 'photo', $2, 'image/jpeg', $3) returning id`,
      [company.companyId, `${company.companyId}/test/photo.jpg`, driverProfileId],
    );
    const { rows: event } = await tx.query<{ id: string }>(
      `insert into public.custody_events
         (company_id, leg_id, event_type, captured_by_driver_id, odometer)
       values ($1, $2, 'collection', $3, 41234) returning id`,
      [company.companyId, company.legId, driverProfileId],
    );
    await tx.query(
      `insert into public.condition_findings
         (company_id, custody_event_id, scope, body_type, section_key, damage_type_key, media_id)
       values ($1, $2, 'exterior', 'car', 'offside_front_door', 'paint_scratch', $3)`,
      [company.companyId, event[0]!.id, media[0]!.id],
    );
    await tx.query(
      `insert into public.leg_location_points
         (company_id, leg_id, driver_profile_id, latitude, longitude, recorded_at)
       values ($1, $2, $3, 53.8008, -1.5491, now())`,
      [company.companyId, company.legId, driverProfileId],
    );
  });

  // usage_counters and company_counters are populated by triggers already.
}

describe("every tenant-scoped table has a company_id", () => {
  it("leaves no table unaccounted for", async () => {
    const missing = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string }>(
        `select t.tablename
           from pg_tables t
          where t.schemaname = 'public'
            and not exists (
              select 1 from information_schema.columns c
               where c.table_schema = 'public'
                 and c.table_name = t.tablename
                 and c.column_name = 'company_id'
                 and c.is_nullable = 'NO'
            )
          order by t.tablename`,
      );
      return rows.map((r) => r.tablename);
    });

    // Anything without a non-nullable company_id must be a documented
    // exception. A new table that forgets one fails here.
    expect(missing.filter((t) => !(t in NOT_TENANT_SCOPED))).toEqual([]);
  });
});

describe("cross-tenant reads", () => {
  it("covers every tenant-scoped table", () => {
    const uncovered = tenantTables.filter((t) => !companyBRows.has(t));
    expect(
      uncovered,
      `These tables have no company B fixture row, so isolation is untested for them. Add one to seedRemainingTables.`,
    ).toEqual([]);
  });

  it.each(tenantTables.map((t) => [t] as const))(
    "%s: company A's owner sees none of company B's rows",
    async (table: string) => {
      const count = await actingAs(
        { userId: companyA.ownerId, companyId: companyA.companyId },
        async (tx) => {
          const { rows } = await tx.query<{ n: string }>(
            `select count(*)::text as n from public.${table} where company_id = $1`,
            [companyB.companyId],
          );
          return Number(rows[0]!.n);
        },
      );
      expect(count).toBe(0);
    },
  );

  it.each(tenantTables.map((t) => [t] as const))(
    "%s: an unfiltered select returns nothing belonging to company B",
    async (table: string) => {
      // This is the case that matters. It simulates application code that
      // forgot its company_id filter entirely.
      const leaked = await actingAs(
        { userId: companyA.ownerId, companyId: companyA.companyId },
        async (tx) => {
          const { rows } = await tx.query<{ n: string }>(
            `select count(*)::text as n
               from public.${table}
              where company_id <> $1`,
            [companyA.companyId],
          );
          return Number(rows[0]!.n);
        },
      );
      expect(leaked).toBe(0);
    },
  );
});

describe("cross-tenant writes", () => {
  it.each(tenantTables.map((t) => [t] as const))(
    "%s: company A cannot update company B's row",
    async (table: string) => {
      const id = companyBRows.get(table);
      if (id === undefined) return;

      const affected = await actingAs(
        { userId: companyA.ownerId, companyId: companyA.companyId },
        async (tx) => {
          const { rowCount } = await tx.query(
            `update public.${table} set company_id = company_id where company_id = $1`,
            [companyB.companyId],
          );
          return rowCount ?? 0;
        },
      ).catch(() => 0); // A table with no update policy throws; also a pass.

      expect(affected).toBe(0);
    },
  );

  it.each(tenantTables.map((t) => [t] as const))(
    "%s: company A cannot delete company B's row",
    async (table: string) => {
      const affected = await actingAs(
        { userId: companyA.ownerId, companyId: companyA.companyId },
        async (tx) => {
          const { rowCount } = await tx.query(
            `delete from public.${table} where company_id = $1`,
            [companyB.companyId],
          );
          return rowCount ?? 0;
        },
      ).catch(() => 0);

      expect(affected).toBe(0);
    },
  );
});

describe("inserting into another tenant", () => {
  it("refuses a client row stamped with another company's id", async () => {
    await expect(
      actingAs({ userId: companyA.ownerId, companyId: companyA.companyId }, (tx) =>
        tx.query("insert into public.clients (company_id, name) values ($1, $2)", [
          companyB.companyId,
          "Smuggled",
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a consignment stamped with another company's id", async () => {
    await expect(
      actingAs({ userId: companyA.ownerId, companyId: companyA.companyId }, (tx) =>
        tx.query(
          `insert into public.consignments (company_id, client_id, status, pickup_mode, pickup_address, dropoff_address)
           values ($1, $2, 'draft', 'single', '{}'::jsonb, '{}'::jsonb)`,
          [companyB.companyId, companyB.clientId],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("writes require an explicitly chosen active company", () => {
  it("refuses a write when no active company is set, even for a real member", async () => {
    await expect(
      actingAs({ userId: companyA.ownerId, companyId: null }, (tx) =>
        tx.query("insert into public.clients (company_id, name) values ($1, $2)", [
          companyA.companyId,
          "No Active Company",
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("still allows reads with no active company set", async () => {
    const count = await actingAs({ userId: companyA.ownerId, companyId: null }, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.clients",
      );
      return Number(rows[0]!.n);
    });
    expect(count).toBeGreaterThan(0);
  });

  it("refuses a write aimed at company A while acting as company B", async () => {
    await expect(
      actingAs({ userId: companyA.ownerId, companyId: companyB.companyId }, (tx) =>
        tx.query("insert into public.clients (company_id, name) values ($1, $2)", [
          companyA.companyId,
          "Wrong Active Company",
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("a signed-in stranger", () => {
  it("sees nothing at all", async () => {
    const strangerId = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "insert into auth.users (email) values ('stranger@example.test') returning id",
      );
      return rows[0]!.id;
    });

    for (const table of tenantTables) {
      const count = await actingAs({ userId: strangerId }, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`,
        );
        return Number(rows[0]!.n);
      });
      expect(count, `${table} leaked rows to a user with no memberships`).toBe(0);
    }
  });
});
