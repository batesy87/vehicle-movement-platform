/**
 * Development seed.
 *
 * Builds two tenants with overlapping staff and one driver who works for both,
 * because that overlap is where tenancy bugs actually live. A single-tenant
 * seed would let a broken policy look fine.
 *
 * Auth users are inserted directly into auth.users. That works against the
 * local shim and against a local `supabase start`. Against a hosted Supabase
 * project, create the users through the Auth admin API first and pass their ids
 * in, or this will insert rows the Auth service does not know about and nobody
 * will be able to sign in as them.
 *
 * Idempotent: running it twice leaves the same two companies.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";

const connectionString =
  process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "";

if (!connectionString) {
  console.error("Set DATABASE_URL before seeding.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !process.env.ALLOW_PRODUCTION_SEED) {
  console.error("Refusing to seed a production database. Set ALLOW_PRODUCTION_SEED=1 to override.");
  process.exit(1);
}

interface SeedPerson {
  email: string;
  name: string;
}

const PEOPLE = {
  alphaOwner: { email: "owner@alpha-transport.test", name: "Ada Owner" },
  alphaDispatcher: { email: "dispatch@alpha-transport.test", name: "Dev Dispatcher" },
  bravoOwner: { email: "owner@bravo-logistics.test", name: "Bo Owner" },
  driver: { email: "driver@example.test", name: "Sam Driver" },
} satisfies Record<string, SeedPerson>;

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query("begin");

    const userIds = new Map<string, string>();
    for (const [key, person] of Object.entries(PEOPLE)) {
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), $1)
         on conflict (id) do nothing
         returning id`,
        [person.email],
      );
      if (rows[0]) {
        userIds.set(key, rows[0].id);
      } else {
        const { rows: existing } = await client.query<{ id: string }>(
          "select id from auth.users where email = $1",
          [person.email],
        );
        userIds.set(key, existing[0]!.id);
      }
    }

    // auth.users has no unique constraint on email in the shim, so dedupe here
    // rather than relying on ON CONFLICT.
    for (const [key, person] of Object.entries(PEOPLE)) {
      const { rows } = await client.query<{ id: string }>(
        "select id from auth.users where email = $1 order by created_at limit 1",
        [person.email],
      );
      userIds.set(key, rows[0]!.id);
      await client.query("delete from auth.users where email = $1 and id <> $2", [
        person.email,
        rows[0]!.id,
      ]);
    }

    const alphaId = await ensureCompany(client, userIds.get("alphaOwner")!, "Alpha Transport", "growth");
    const bravoId = await ensureCompany(client, userIds.get("bravoOwner")!, "Bravo Logistics", "starter");

    // Alpha's dispatcher.
    await client.query(
      `insert into public.company_users (company_id, user_id, role)
       values ($1, $2, 'dispatcher')
       on conflict (company_id, user_id) do update set role = excluded.role`,
      [alphaId, userIds.get("alphaDispatcher")],
    );

    // One driver, accepted at both companies. This is the case the spec calls
    // out and the one a single-tenant model cannot represent.
    const driverProfileId = await ensureDriverProfile(
      client,
      userIds.get("driver")!,
      PEOPLE.driver.name,
      PEOPLE.driver.email,
    );

    for (const companyId of [alphaId, bravoId]) {
      await client.query(
        `insert into public.driver_company_links
           (driver_profile_id, company_id, driver_type, status, accepted_at)
         values ($1, $2, 'self_employed', 'active', now())
         on conflict (driver_profile_id, company_id)
         do update set status = 'active', accepted_at = coalesce(public.driver_company_links.accepted_at, now())`,
        [driverProfileId, companyId],
      );
    }

    await seedOperations(client, alphaId, driverProfileId, "Alpha");
    await seedOperations(client, bravoId, driverProfileId, "Bravo");

    await client.query("commit");

    console.log("\nSeeded two tenants.\n");
    console.table(
      Object.entries(PEOPLE).map(([key, person]) => ({
        who: key,
        email: person.email,
        userId: userIds.get(key),
      })),
    );
    console.log(`\n  Alpha Transport: ${alphaId}  (Growth plan)`);
    console.log(`  Bravo Logistics: ${bravoId}  (Starter plan)`);
    console.log(`  Shared driver profile: ${driverProfileId}\n`);
    console.log("Sign-in passwords are not set here. Use the Supabase Auth admin API,");
    console.log("or sign up through the app and link the account manually.\n");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function ensureCompany(
  client: pg.Client,
  ownerId: string,
  name: string,
  planKey: string,
): Promise<string> {
  const { rows: existing } = await client.query<{ id: string }>(
    "select id from public.companies where name = $1",
    [name],
  );
  if (existing[0]) return existing[0].id;

  // Through the real signup RPC, acting as the owner, so the seed exercises the
  // same path a real signup takes.
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: ownerId, role: "authenticated" }),
  ]);
  const { rows } = await client.query<{ id: string }>(
    "select public.create_company($1, $2) as id",
    [name, planKey],
  );
  return rows[0]!.id;
}

async function ensureDriverProfile(
  client: pg.Client,
  authUserId: string,
  name: string,
  email: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.driver_profiles
       (auth_user_id, name, email, phone, licence_number, vehicle_capability, is_confirmed)
     values ($1, $2, $3, '07700 900000', 'DRIVER801011SD9AB', 'flatbed', true)
     on conflict (auth_user_id) do update set name = excluded.name
     returning id`,
    [authUserId, name, email],
  );
  return rows[0]!.id;
}

async function seedOperations(
  client: pg.Client,
  companyId: string,
  driverProfileId: string,
  prefix: string,
): Promise<void> {
  const { rows: existing } = await client.query(
    "select 1 from public.consignments where company_id = $1 limit 1",
    [companyId],
  );
  if (existing[0]) return;

  const { rows: clientRows } = await client.query<{ id: string }>(
    `insert into public.clients (company_id, name, contact_name, email)
     values ($1, $2, 'Fleet Manager', $3) returning id`,
    [companyId, `${prefix} Leasing Ltd`, `fleet@${prefix.toLowerCase()}-leasing.test`],
  );
  const clientId = clientRows[0]!.id;

  const { rows: depotRows } = await client.query<{ id: string }>(
    `insert into public.locations (company_id, name, kind, address, latitude, longitude)
     values ($1, $2, 'depot', $3::jsonb, 53.800800, -1.549100) returning id`,
    [
      companyId,
      `${prefix} Depot`,
      JSON.stringify({
        line1: "Unit 4, Kirkstall Road",
        city: "Leeds",
        postcode: "LS3 1HS",
        country: "United Kingdom",
      }),
    ],
  );
  const depotId = depotRows[0]!.id;

  const { rows: collectionRows } = await client.query<{ id: string }>(
    `insert into public.locations (company_id, name, kind, address, latitude, longitude)
     values ($1, $2, 'pickup', $3::jsonb, 53.483000, -2.244400) returning id`,
    [
      companyId,
      `${prefix} Collection Compound`,
      JSON.stringify({
        line1: "Compound 7, Trafford Park",
        city: "Manchester",
        postcode: "M17 1AB",
        country: "United Kingdom",
      }),
    ],
  );
  const collectionId = collectionRows[0]!.id;

  const { rows: rateCardRows } = await client.query<{ id: string }>(
    `insert into public.rate_cards (company_id, name, basis, is_default)
     values ($1, 'Standard banded', 'banded', true) returning id`,
    [companyId],
  );
  const rateCardId = rateCardRows[0]!.id;

  // Banded pricing carried over from the legacy engine: a flat fee plus a
  // per-mile rate for the portion of the journey inside each band.
  for (const band of [
    { from: 0, to: 50, flat: 25.0, per: 1.2 },
    { from: 50, to: 150, flat: 0, per: 0.95 },
    { from: 150, to: 10000, flat: 0, per: 0.8 },
  ]) {
    await client.query(
      `insert into public.rate_card_bands
         (company_id, rate_card_id, range_from, range_to, value_flat, value_per)
       values ($1, $2, $3, $4, $5, $6)`,
      [companyId, rateCardId, band.from, band.to, band.flat, band.per],
    );
  }

  await client.query("update public.clients set default_rate_card_id = $1 where id = $2", [
    rateCardId,
    clientId,
  ]);

  // A two-leg consignment: collected in Manchester, handed over at the Leeds
  // depot, delivered onward. This is the shape the legacy system could not
  // model without duplicating every column with a ts_ prefix.
  const { rows: consignmentRows } = await client.query<{ id: string }>(
    `insert into public.consignments
       (company_id, client_id, status, pickup_mode, pickup_location_id, dropoff_location_id,
        rate_card_id, scheduled_for, client_reference)
     values ($1, $2, 'scheduled', 'single', $3, $4, $5, now() + interval '1 day', $6)
     returning id`,
    [companyId, clientId, collectionId, depotId, rateCardId, `PO-${prefix.toUpperCase()}-0001`],
  );
  const consignmentId = consignmentRows[0]!.id;

  const { rows: vehicleRows } = await client.query<{ id: string }>(
    `insert into public.vehicles (company_id, registration, make, model, colour, body_type)
     values ($1, $2, 'Ford', 'Transit Custom', 'White', 'van') returning id`,
    [companyId, prefix === "Alpha" ? "AB12CDE" : "XY34ZAB"],
  );
  const vehicleId = vehicleRows[0]!.id;

  const { rows: cvRows } = await client.query<{ id: string }>(
    `insert into public.consignment_vehicles
       (company_id, consignment_id, vehicle_id, sequence, registration, make, model, body_type)
     values ($1, $2, $3, 1, $4, 'Ford', 'Transit Custom', 'van') returning id`,
    [companyId, consignmentId, vehicleId, prefix === "Alpha" ? "AB12CDE" : "XY34ZAB"],
  );
  const consignmentVehicleId = cvRows[0]!.id;

  const { rows: tripRows } = await client.query<{ id: string }>(
    `insert into public.trips (company_id, driver_profile_id, trip_date, status, transport_used)
     values ($1, $2, current_date, 'planned', 'Flatbed FB19 TRK') returning id`,
    [companyId, driverProfileId],
  );
  const tripId = tripRows[0]!.id;

  const legs = [
    { sequence: 1, from: collectionId, to: depotId },
    { sequence: 2, from: depotId, to: collectionId },
  ];

  let stopSequence = 1;
  for (const leg of legs) {
    const { rows: legRows } = await client.query<{ id: string }>(
      `insert into public.legs
         (company_id, consignment_vehicle_id, sequence, driver_profile_id, trip_id,
          from_location_id, to_location_id, status, distance_miles, planned_start)
       values ($1, $2, $3, $4, $5, $6, $7, 'assigned', 43.5, now() + interval '1 day')
       returning id`,
      [companyId, consignmentVehicleId, leg.sequence, driverProfileId, tripId, leg.from, leg.to],
    );
    const legId = legRows[0]!.id;

    for (const kind of ["collection", "delivery"] as const) {
      await client.query(
        `insert into public.trip_stops (company_id, trip_id, leg_id, kind, sequence)
         values ($1, $2, $3, $4, $5)`,
        [companyId, tripId, legId, kind, stopSequence++],
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error("\nSeed failed.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
