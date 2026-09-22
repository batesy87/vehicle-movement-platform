/**
 * Schema guard.
 *
 * The isolation suite proves the policies that exist behave correctly. This one
 * proves no table slipped through without any.
 *
 * It matters more than it looks. A lot of the query code on this project will
 * be generated, and generated code adds tables. A new table with row level
 * security left off is not a subtle bug, it is every tenant reading every other
 * tenant's rows, and it produces no error and no failing test anywhere else.
 * So the rule is mechanical: if it is in `public` and it is not a documented
 * exception, it is protected, and CI says so.
 */

import { afterAll, describe, expect, it } from "vitest";
import { adminPool, asAdmin } from "./helpers";

/** Tables allowed to sit outside the tenant rule, each with its reason. */
const EXEMPT: Record<string, string> = {
  plans: "global reference data, deliberately world-readable",
  companies: "the tenant root; scoped by id, not by company_id",
  driver_profiles: "global driver identity, shared across tenants by design",
};

afterAll(async () => {
  await adminPool.end();
});

describe("row level security", () => {
  it("is enabled on every table in public", async () => {
    const offenders = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
          order by c.relname`,
      );
      return rows.map((r) => r.relname);
    });
    expect(offenders).toEqual([]);
  });

  it("is FORCED on every table in public", async () => {
    // Without FORCE, the table owner is exempt from its own policies. On a
    // managed Postgres the owner is the role migrations and some tooling run
    // as, so this is not a theoretical gap.
    const offenders = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relrowsecurity and not c.relforcerowsecurity
          order by c.relname`,
      );
      return rows.map((r) => r.relname);
    });
    expect(offenders).toEqual([]);
  });

  it("gives every protected table at least one policy", async () => {
    // RLS enabled with no policies denies everything, which is safe but almost
    // certainly a mistake rather than an intention.
    const bare = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
            and not exists (
              select 1 from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname
            )
          order by c.relname`,
      );
      return rows.map((r) => r.relname);
    });
    expect(bare).toEqual([]);
  });
});

describe("policy shape", () => {
  it("contains no USING (true) anywhere", async () => {
    // A blanket-true policy is how a tenant boundary quietly stops existing.
    const permissive = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string; qual: string }>(
        `select tablename, policyname, qual
           from pg_policies
          where schemaname = 'public'
            and qual is not null
            and regexp_replace(lower(qual), '\\s', '', 'g') = 'true'`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname}`);
    });
    expect(permissive).toEqual([]);
  });

  it("contains no WITH CHECK (true) anywhere", async () => {
    const permissive = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname
           from pg_policies
          where schemaname = 'public'
            and with_check is not null
            and regexp_replace(lower(with_check), '\\s', '', 'g') = 'true'`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname}`);
    });
    expect(permissive).toEqual([]);
  });

  it("gives every INSERT and UPDATE policy a WITH CHECK", async () => {
    // An UPDATE policy with USING but no WITH CHECK lets a row be edited out of
    // its own tenant on the way past: you can see it, so you can move it.
    const missing = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string; cmd: string }>(
        `select tablename, policyname, cmd
           from pg_policies
          where schemaname = 'public'
            and cmd in ('INSERT', 'UPDATE')
            and with_check is null
          order by tablename, policyname`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname} (${r.cmd})`);
    });
    expect(missing).toEqual([]);
  });

  it("uses no FOR ALL policies", async () => {
    // FOR ALL silently reuses USING as WITH CHECK, which reads as safer than
    // it is. One policy per operation keeps intent visible.
    const forAll = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname from pg_policies
          where schemaname = 'public' and cmd = 'ALL'`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname}`);
    });
    expect(forAll).toEqual([]);
  });

  it("grants no policy to PUBLIC", async () => {
    const toPublic = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname from pg_policies
          where schemaname = 'public' and roles::text[] && array['public']`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname}`);
    });
    expect(toPublic).toEqual([]);
  });
});

describe("tenant columns", () => {
  it("requires a non-nullable company_id outside the documented exceptions", async () => {
    const offenders = await asAdmin(async (tx) => {
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

    const undocumented = offenders.filter((t) => !(t in EXEMPT));
    expect(
      undocumented,
      "A new table needs a non-nullable company_id, or an entry in EXEMPT explaining why not.",
    ).toEqual([]);
  });

  it("points every company_id at companies", async () => {
    const unconstrained = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ table_name: string }>(
        `select c.table_name
           from information_schema.columns c
          where c.table_schema = 'public'
            and c.column_name = 'company_id'
            and not exists (
              select 1
                from information_schema.table_constraints tc
                join information_schema.key_column_usage kcu
                  on kcu.constraint_name = tc.constraint_name
                 and kcu.table_schema = tc.table_schema
                join information_schema.constraint_column_usage ccu
                  on ccu.constraint_name = tc.constraint_name
               where tc.constraint_type = 'FOREIGN KEY'
                 and tc.table_schema = 'public'
                 and tc.table_name = c.table_name
                 and kcu.column_name = 'company_id'
                 and ccu.table_name = 'companies'
            )
          order by c.table_name`,
      );
      return rows.map((r) => r.table_name);
    });
    expect(unconstrained).toEqual([]);
  });
});

describe("cross-tenant references", () => {
  it("carries company_id through every foreign key between tenant tables", async () => {
    // A child referencing only the parent's id can point across the tenant
    // boundary when application code gets an id wrong. Referencing
    // (id, company_id) makes that impossible at the storage layer.
    const singleColumn = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ child: string; parent: string; constraint_name: string }>(
        `with fks as (
           select con.conname as constraint_name,
                  child.relname as child,
                  parent.relname as parent,
                  pn.nspname as parent_schema,
                  (select array_agg(a.attname order by a.attnum)
                     from pg_attribute a
                    where a.attrelid = con.conrelid and a.attnum = any(con.conkey)) as child_cols
             from pg_constraint con
             join pg_class child on child.oid = con.conrelid
             join pg_class parent on parent.oid = con.confrelid
             join pg_namespace n on n.oid = child.relnamespace
             join pg_namespace pn on pn.oid = parent.relnamespace
            where con.contype = 'f' and n.nspname = 'public'
         )
         select constraint_name, child, parent
           from fks
          -- auth.users and the three global tables are identity, not tenant
          -- data: there is no company_id to carry through to them.
          where parent_schema = 'public'
            and parent not in ('companies', 'plans', 'driver_profiles')
            and 'company_id' <> all(child_cols)
          order by child, constraint_name`,
      );
      return rows.map((r) => `${r.child} -> ${r.parent} (${r.constraint_name})`);
    });

    expect(
      singleColumn,
      "These foreign keys do not carry company_id, so they can reference another tenant's row.",
    ).toEqual([]);
  });
});

describe("SECURITY DEFINER functions", () => {
  it("pins a search_path on all of them", async () => {
    // A definer function without a pinned search_path can be hijacked by a
    // caller who creates a same-named object in a schema earlier on the path.
    const unpinned = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ nspname: string; proname: string }>(
        `select n.nspname, p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app')
            and p.prosecdef
            and (p.proconfig is null
                 or not exists (
                   select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
                 ))
          order by n.nspname, p.proname`,
      );
      return rows.map((r) => `${r.nspname}.${r.proname}`);
    });
    expect(unpinned).toEqual([]);
  });

  it("does not expose any of them to anonymous callers", async () => {
    const exposed = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prosecdef
            and has_function_privilege('anon', p.oid, 'execute')
          order by p.proname`,
      );
      return rows.map((r) => r.proname);
    });
    expect(exposed).toEqual([]);
  });
});

describe("evidence tables are append-only", () => {
  it("gives custody_events, media_objects, audit_log and breadcrumbs no delete policy", async () => {
    // Dispute evidence that the accused party can delete is not evidence.
    const withDelete = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname from pg_policies
          where schemaname = 'public'
            and cmd = 'DELETE'
            and tablename in ('custody_events', 'media_objects', 'audit_log', 'leg_location_points')`,
      );
      return rows.map((r) => `${r.tablename}.${r.policyname}`);
    });
    expect(withDelete).toEqual([]);
  });

  it("gives audit_log no update policy", async () => {
    const withUpdate = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ policyname: string }>(
        `select policyname from pg_policies
          where schemaname = 'public' and tablename = 'audit_log' and cmd = 'UPDATE'`,
      );
      return rows.map((r) => r.policyname);
    });
    expect(withUpdate).toEqual([]);
  });
});
