/**
 * Test harness.
 *
 * Runs against a real Postgres, never a mock. Row level security is a property
 * of the database, so testing it anywhere else tests nothing.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";

const connectionString =
  process.env.DATABASE_TEST_URL ??
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new pg.Pool({ connectionString, max: 5 });

/** Runs SQL as the owning role, bypassing every policy. Setup only. */
export async function asAdmin<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export interface ActingAs {
  userId: string;
  companyId?: string | null;
}

/**
 * Runs SQL exactly as the application would: as the `authenticated` role, with
 * the caller's claims and active company set for the transaction only.
 *
 * Mirrors withTenantSession in src/client.ts. If the two ever diverge, the
 * tests stop testing what actually runs, so keep them in step.
 */
export async function actingAs<T>(
  who: ActingAs,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: who.userId, role: "authenticated" }),
    ]);
    await client.query("select set_config('app.active_company_id', $1, true)", [
      who.companyId ?? "",
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs SQL the way PostgREST would: the caller's real access token and nothing
 * else. No server-side override is set, so app.active_company_id() has only the
 * token's app_metadata to read.
 *
 * This is the other half of actingAs. That one mirrors withTenantSession, which
 * holds its own connection and pins the company on it. This one mirrors every
 * caller that cannot, which after 0013 is the case the tenant rule also has to
 * cover. A suite that only exercised actingAs would pass while the claim path
 * was broken.
 */
export async function actingAsToken<T>(
  who: { userId: string; activeCompanyId?: string | null },
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: who.userId,
        role: "authenticated",
        app_metadata: who.activeCompanyId ? { active_company_id: who.activeCompanyId } : {},
      }),
    ]);
    // Deliberately absent: no set_config('app.active_company_id', ...).
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Asserts that a statement is refused.
 *
 * Deliberately accepts any denial: a row level security violation, a
 * permission error, or a constraint that makes the forbidden shape
 * impossible. What matters is that the write did not land, not which layer
 * stopped it.
 */
export async function expectDenied(
  who: ActingAs,
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await actingAs(who, async (tx) => tx.query(sql, params));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected this to be denied, but it succeeded:\n  ${sql}`);
}

export async function createAuthUser(email?: string): Promise<string> {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.query("insert into auth.users (id, email) values ($1, $2)", [
      id,
      email ?? `${id}@example.test`,
    ]),
  );
  return id;
}

export interface SeededCompany {
  companyId: string;
  ownerId: string;
  dispatcherId: string;
  viewerId: string;
  clientId: string;
  locationId: string;
  consignmentId: string;
  consignmentVehicleId: string;
  legId: string;
  tripId: string;
}

/**
 * A complete, realistic tenant: staff at three privilege levels, a client, a
 * depot, and one consignment carrying one vehicle on one assigned leg.
 *
 * Built through the real RPC and the real policies wherever possible, so the
 * fixture exercises the same paths the application does.
 */
export async function seedCompany(
  name: string,
  driverProfileId: string,
  planKey = "pro",
): Promise<SeededCompany> {
  const ownerId = await createAuthUser();
  const dispatcherId = await createAuthUser();
  const viewerId = await createAuthUser();

  const companyId = await actingAs({ userId: ownerId }, async (tx) => {
    const { rows } = await tx.query<{ create_company: string }>(
      "select public.create_company($1, $2) as create_company",
      [name, planKey],
    );
    return rows[0]!.create_company;
  });

  // Staff are added directly rather than through the invitation flow; the
  // invitation flow has its own tests.
  await asAdmin((tx) =>
    tx.query(
      `insert into public.company_users (company_id, user_id, role)
       values ($1, $2, 'dispatcher'), ($1, $3, 'viewer')`,
      [companyId, dispatcherId, viewerId],
    ),
  );

  // Link the shared driver and have them accept, which is what makes the link
  // active and the company able to assign them work.
  await asAdmin((tx) =>
    tx.query(
      `insert into public.driver_company_links
         (driver_profile_id, company_id, status, accepted_at)
       values ($1, $2, 'active', now())`,
      [driverProfileId, companyId],
    ),
  );

  const acting = { userId: dispatcherId, companyId };

  const clientId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into public.clients (company_id, name) values ($1, $2) returning id",
      [companyId, `${name} Client`],
    );
    return rows[0]!.id;
  });

  const locationId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.locations (company_id, name, kind, address)
       values ($1, $2, 'depot', $3::jsonb) returning id`,
      [companyId, `${name} Depot`, JSON.stringify({ line1: "1 Depot Way", city: "Leeds", postcode: "LS1 1AA" })],
    );
    return rows[0]!.id;
  });

  const consignmentId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.consignments
         (company_id, client_id, status, pickup_mode, pickup_location_id, dropoff_location_id)
       values ($1, $2, 'scheduled', 'single', $3, $3) returning id`,
      [companyId, clientId, locationId],
    );
    return rows[0]!.id;
  });

  const consignmentVehicleId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.consignment_vehicles (company_id, consignment_id, registration, make, model)
       values ($1, $2, 'AB12CDE', 'Ford', 'Transit') returning id`,
      [companyId, consignmentId],
    );
    return rows[0]!.id;
  });

  const tripId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.trips (company_id, driver_profile_id, trip_date, status)
       values ($1, $2, current_date, 'planned') returning id`,
      [companyId, driverProfileId],
    );
    return rows[0]!.id;
  });

  const legId = await actingAs(acting, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.legs
         (company_id, consignment_vehicle_id, sequence, driver_profile_id, trip_id,
          from_location_id, to_location_id, status)
       values ($1, $2, 1, $3, $4, $5, $5, 'assigned') returning id`,
      [companyId, consignmentVehicleId, driverProfileId, tripId, locationId],
    );
    return rows[0]!.id;
  });

  return {
    companyId,
    ownerId,
    dispatcherId,
    viewerId,
    clientId,
    locationId,
    consignmentId,
    consignmentVehicleId,
    legId,
    tripId,
  };
}

export async function createDriverProfile(name: string): Promise<{
  driverProfileId: string;
  authUserId: string;
}> {
  const authUserId = await createAuthUser();
  const driverProfileId = await asAdmin(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.driver_profiles (auth_user_id, name, email, is_confirmed)
       values ($1, $2, $3, true) returning id`,
      [authUserId, name, `${authUserId}@drivers.test`],
    );
    return rows[0]!.id;
  });
  return { driverProfileId, authUserId };
}

/** Wipes tenant data between suites. auth.users is cleared last. */
export async function truncateAll(): Promise<void> {
  await asAdmin(async (tx) => {
    const { rows } = await tx.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename <> 'plans'`,
    );
    const names = rows.map((r) => `public.${r.tablename}`).join(", ");
    if (names) {
      await tx.query(`truncate ${names} restart identity cascade`);
    }
    await tx.query("delete from auth.users");
  });
}
