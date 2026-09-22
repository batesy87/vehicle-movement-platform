/**
 * Behaviour of the tenancy model itself.
 *
 * The isolation suite proves company A cannot reach company B. These are the
 * cases that a naive implementation gets wrong even when that much works: a
 * driver who legitimately spans two tenants, a revocation that has to bite
 * immediately, consent that has to be real, and the rule that a driver records
 * custody only for their own legs.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actingAs,
  adminPool,
  asAdmin,
  createAuthUser,
  createDriverProfile,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers";

let companyA: SeededCompany;
let companyB: SeededCompany;
let companyC: SeededCompany;
let driver: { driverProfileId: string; authUserId: string };
let otherDriver: { driverProfileId: string; authUserId: string };

beforeAll(async () => {
  await truncateAll();
  driver = await createDriverProfile("Shared Driver");
  otherDriver = await createDriverProfile("Other Driver");

  companyA = await seedCompany("Alpha Transport", driver.driverProfileId);
  companyB = await seedCompany("Bravo Logistics", driver.driverProfileId);
  // Company C never links this driver at all.
  companyC = await seedCompany("Charlie Movements", otherDriver.driverProfileId);
});

afterAll(async () => {
  await adminPool.end();
});

describe("a driver working for several companies", () => {
  it("sees exactly the companies that accepted them, and no others", async () => {
    const memberships = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ company_id: string; is_driver: boolean }>(
        "select company_id, is_driver from public.my_memberships()",
      );
      return rows;
    });

    const ids = memberships.map((m) => m.company_id).sort();
    expect(ids).toEqual([companyA.companyId, companyB.companyId].sort());
    expect(memberships.every((m) => m.is_driver)).toBe(true);
  });

  it("reads their legs at both companies", async () => {
    const legCompanies = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ company_id: string }>(
        "select distinct company_id from public.legs",
      );
      return rows.map((r) => r.company_id).sort();
    });
    expect(legCompanies).toEqual([companyA.companyId, companyB.companyId].sort());
  });

  it("is not staff anywhere, so cannot read commercially sensitive data", async () => {
    // Rate cards are staff-only. A self-employed driver must not see what the
    // client is being charged for the job they just ran.
    const visible = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.rate_cards",
      );
      return Number(rows[0]!.n);
    });
    expect(visible).toBe(0);
  });

  it("cannot read invoices", async () => {
    const visible = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.invoices",
      );
      return Number(rows[0]!.n);
    });
    expect(visible).toBe(0);
  });
});

describe("revoking a driver's link", () => {
  it("takes effect on the very next query, with no token refresh", async () => {
    // This is the property the derived-membership design buys, and the reason
    // company_id is not a JWT claim. With the claim approach the driver would
    // keep reading this company's data until their token expired.
    const beforeRevoke = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.legs where company_id = $1",
        [companyB.companyId],
      );
      return Number(rows[0]!.n);
    });
    expect(beforeRevoke).toBeGreaterThan(0);

    await asAdmin((tx) =>
      tx.query(
        "update public.driver_company_links set status = 'inactive' where driver_profile_id = $1 and company_id = $2",
        [driver.driverProfileId, companyB.companyId],
      ),
    );

    try {
      const afterRevoke = await actingAs({ userId: driver.authUserId }, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.legs where company_id = $1",
          [companyB.companyId],
        );
        return Number(rows[0]!.n);
      });
      expect(afterRevoke).toBe(0);

      // Company A is untouched.
      const stillAtA = await actingAs({ userId: driver.authUserId }, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.legs where company_id = $1",
          [companyA.companyId],
        );
        return Number(rows[0]!.n);
      });
      expect(stillAtA).toBeGreaterThan(0);
    } finally {
      // In a finally block so a failure here cannot leave the link revoked and
      // cascade into unrelated tests further down the file.
      await asAdmin((tx) =>
        tx.query(
          "update public.driver_company_links set status = 'active' where driver_profile_id = $1 and company_id = $2",
          [driver.driverProfileId, companyB.companyId],
        ),
      );
    }
  });
});

describe("custody events", () => {
  it("lets the assigned driver record one", async () => {
    const eventId = await actingAs(
      { userId: driver.authUserId, companyId: companyA.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id, odometer)
           values ($1, $2, 'collection', $3, 52000) returning id`,
          [companyA.companyId, companyA.legId, driver.driverProfileId],
        );
        return rows[0]!.id;
      },
    );
    expect(eventId).toBeTruthy();
  });

  it("refuses a driver recording custody for someone else's leg", async () => {
    // otherDriver holds legs at company C only.
    await expect(
      actingAs({ userId: otherDriver.authUserId, companyId: companyA.companyId }, (tx) =>
        tx.query(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id)
           values ($1, $2, 'delivery', $3)`,
          [companyA.companyId, companyA.legId, otherDriver.driverProfileId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a driver filing an event in another driver's name", async () => {
    await expect(
      actingAs({ userId: driver.authUserId, companyId: companyA.companyId }, (tx) =>
        tx.query(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id)
           values ($1, $2, 'delivery', $3)`,
          [companyA.companyId, companyA.legId, otherDriver.driverProfileId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a dispatcher editing a driver's custody event", async () => {
    // Evidence the accused party can rewrite is not evidence.
    const affected = await actingAs(
      { userId: companyA.dispatcherId, companyId: companyA.companyId },
      async (tx) => {
        const { rowCount } = await tx.query(
          "update public.custody_events set odometer = 1 where company_id = $1",
          [companyA.companyId],
        );
        return rowCount ?? 0;
      },
    );
    expect(affected).toBe(0);
  });

  it("allows only one collection and one delivery per leg", async () => {
    await expect(
      actingAs({ userId: driver.authUserId, companyId: companyA.companyId }, (tx) =>
        tx.query(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id)
           values ($1, $2, 'collection', $3)`,
          [companyA.companyId, companyA.legId, driver.driverProfileId],
        ),
      ),
    ).rejects.toThrow(/custody_events_one_per_leg_and_type|duplicate key/i);
  });

  it("refuses a handover pairing two events on the same leg", async () => {
    await expect(
      asAdmin(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "select id from public.custody_events where leg_id = $1 limit 1",
          [companyA.legId],
        );
        const id = rows[0]!.id;
        return tx.query("update public.custody_events set paired_event_id = $1 where id = $1", [id]);
      }),
    ).rejects.toThrow();
  });

  it("preserves the captured time when a submission syncs later", async () => {
    // The legacy driver app had no offline queue, so an event captured in a
    // compound with no signal was simply lost. Here capture time and sync time
    // are independent, and it is capture time that a dispute turns on.
    const captured = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const row = await actingAs(
      { userId: driver.authUserId, companyId: companyA.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ captured_at: Date; offline_captured: boolean }>(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id,
              captured_at, synced_at, offline_captured, idempotency_key)
           values ($1, $2, 'delivery', $3, $4, now(), true, $5)
           returning captured_at, offline_captured`,
          [companyA.companyId, companyA.legId, driver.driverProfileId, captured, randomUUID()],
        );
        return rows[0]!;
      },
    );
    expect(row.offline_captured).toBe(true);
    expect(Math.abs(row.captured_at.getTime() - captured.getTime())).toBeLessThan(1000);
  });

  it("deduplicates a retried offline submission by idempotency key", async () => {
    const key = randomUUID();
    const insert = () =>
      actingAs({ userId: driver.authUserId, companyId: companyB.companyId }, (tx) =>
        tx.query(
          `insert into public.custody_events
             (company_id, leg_id, event_type, captured_by_driver_id, idempotency_key)
           values ($1, $2, 'collection', $3, $4)`,
          [companyB.companyId, companyB.legId, driver.driverProfileId, key],
        ),
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|idempotency/i);
  });
});

describe("staff roles", () => {
  it("lets a viewer read but not write", async () => {
    const visible = await actingAs(
      { userId: companyA.viewerId, companyId: companyA.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.consignments",
        );
        return Number(rows[0]!.n);
      },
    );
    expect(visible).toBeGreaterThan(0);

    await expect(
      actingAs({ userId: companyA.viewerId, companyId: companyA.companyId }, (tx) =>
        tx.query("insert into public.clients (company_id, name) values ($1, 'Viewer Co')", [
          companyA.companyId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("stops a dispatcher reading finance", async () => {
    const visible = await actingAs(
      { userId: companyA.dispatcherId, companyId: companyA.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.rate_cards",
        );
        return Number(rows[0]!.n);
      },
    );
    expect(visible).toBe(0);
  });

  it("stops a dispatcher changing company settings", async () => {
    const affected = await actingAs(
      { userId: companyA.dispatcherId, companyId: companyA.companyId },
      async (tx) => {
        const { rowCount } = await tx.query(
          "update public.companies set name = 'Renamed' where id = $1",
          [companyA.companyId],
        );
        return rowCount ?? 0;
      },
    );
    expect(affected).toBe(0);
  });

  it("refuses to leave a company without an owner", async () => {
    await expect(
      asAdmin((tx) =>
        tx.query(
          "update public.company_users set is_active = false where company_id = $1 and role = 'owner'",
          [companyA.companyId],
        ),
      ),
    ).rejects.toThrow(/at least one active owner/i);
  });
});

describe("driver onboarding", () => {
  it("creates a stub profile when the email is unknown", async () => {
    const email = `new-${randomUUID()}@drivers.test`;
    const result = await actingAs(
      { userId: companyC.dispatcherId, companyId: companyC.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ invite_driver: { path: string; driver_profile_id: string } }>(
          "select public.invite_driver($1, $2, $3, $4) as invite_driver",
          [companyC.companyId, email, randomUUID() + randomUUID(), "New Driver"],
        );
        return rows[0]!.invite_driver;
      },
    );

    expect(result.path).toBe("new_profile");

    const link = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        "select status from public.driver_company_links where driver_profile_id = $1 and company_id = $2",
        [result.driver_profile_id, companyC.companyId],
      );
      return rows[0]!;
    });
    expect(link.status).toBe("invited");
  });

  it("asks for consent rather than auto-linking an existing driver", async () => {
    // The whole point of section 4.0: a second company cannot help itself to a
    // driver's licence details just because it knows their email address.
    const email = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ email: string }>(
        "select email from public.driver_profiles where id = $1",
        [driver.driverProfileId],
      );
      return rows[0]!.email;
    });

    const result = await actingAs(
      { userId: companyC.dispatcherId, companyId: companyC.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ invite_driver: { path: string; driver_profile_id: string } }>(
          "select public.invite_driver($1, $2, $3) as invite_driver",
          [companyC.companyId, email, randomUUID() + randomUUID()],
        );
        return rows[0]!.invite_driver;
      },
    );

    expect(result.path).toBe("consent_requested");
    expect(result.driver_profile_id).toBe(driver.driverProfileId);

    // Crucially, company C still sees nothing of this driver's work, and the
    // driver sees nothing of company C's.
    const cSeesDriverWork = await actingAs(
      { userId: companyC.dispatcherId, companyId: companyC.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.driver_profiles where id = $1",
          [driver.driverProfileId],
        );
        return Number(rows[0]!.n);
      },
    );
    expect(cSeesDriverWork).toBe(0);

    const driverSeesC = await actingAs({ userId: driver.authUserId }, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.legs where company_id = $1",
        [companyC.companyId],
      );
      return Number(rows[0]!.n);
    });
    expect(driverSeesC).toBe(0);
  });

  it("grants sight of the profile only once the driver accepts", async () => {
    const token = randomUUID() + randomUUID();
    const email = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ email: string }>(
        "select email from public.driver_profiles where id = $1",
        [driver.driverProfileId],
      );
      return rows[0]!.email;
    });

    // Re-issue the invitation with a token we know.
    await actingAs({ userId: companyC.dispatcherId, companyId: companyC.companyId }, (tx) =>
      tx.query("select public.invite_driver($1, $2, $3)", [companyC.companyId, email, token]),
    );

    // The driver's auth user has the matching email, which is what the accept
    // path checks; a forwarded link cannot be redeemed by anyone else.
    await asAdmin((tx) =>
      tx.query("update auth.users set email = $1 where id = $2", [email, driver.authUserId]),
    );

    await actingAs({ userId: driver.authUserId }, (tx) =>
      tx.query("select public.accept_invitation($1)", [token]),
    );

    const nowVisible = await actingAs(
      { userId: companyC.dispatcherId, companyId: companyC.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.driver_profiles where id = $1",
          [driver.driverProfileId],
        );
        return Number(rows[0]!.n);
      },
    );
    expect(nowVisible).toBe(1);
  });

  it("refuses an invitation sent to a different address", async () => {
    const token = randomUUID() + randomUUID();
    await actingAs({ userId: companyC.dispatcherId, companyId: companyC.companyId }, (tx) =>
      tx.query("select public.invite_driver($1, $2, $3)", [
        companyC.companyId,
        `someone-else-${randomUUID()}@drivers.test`,
        token,
      ]),
    );

    const stranger = await createAuthUser(`stranger-${randomUUID()}@example.test`);
    await expect(
      actingAs({ userId: stranger }, (tx) =>
        tx.query("select public.accept_invitation($1)", [token]),
      ),
    ).rejects.toThrow(/different email address/i);
  });

  it("refuses to invite a driver for a company the caller does not dispatch for", async () => {
    await expect(
      actingAs({ userId: companyA.dispatcherId, companyId: companyA.companyId }, (tx) =>
        tx.query("select public.invite_driver($1, $2, $3)", [
          companyC.companyId,
          `crossed-${randomUUID()}@drivers.test`,
          randomUUID() + randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/do not have permission/i);
  });
});

describe("company signup", () => {
  it("creates the company, the owner and the trial together", async () => {
    const userId = await createAuthUser();
    const companyId = await actingAs({ userId }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select public.create_company($1, $2) as id",
        ["Delta Deliveries", "starter"],
      );
      return rows[0]!.id;
    });

    const company = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ status: string; trial_ends_at: Date | null }>(
        "select status, trial_ends_at from public.companies where id = $1",
        [companyId],
      );
      return rows[0]!;
    });

    expect(company.status).toBe("trial");
    expect(company.trial_ends_at).toBeInstanceOf(Date);

    const role = await actingAs({ userId }, async (tx) => {
      const { rows } = await tx.query<{ staff_role: string }>(
        "select staff_role from public.my_memberships() where company_id = $1",
        [companyId],
      );
      return rows[0]!.staff_role;
    });
    expect(role).toBe("owner");
  });

  it("refuses an unknown plan", async () => {
    const userId = await createAuthUser();
    await expect(
      actingAs({ userId }, (tx) =>
        tx.query("select public.create_company($1, $2)", ["Nope Ltd", "enterprise-unlimited"]),
      ),
    ).rejects.toThrow(/unknown plan/i);
  });

  it("caps how many companies one account can own", async () => {
    const userId = await createAuthUser();
    for (let i = 0; i < 5; i++) {
      await actingAs({ userId }, (tx) =>
        tx.query("select public.create_company($1, $2)", [`Spray ${i}`, "starter"]),
      );
    }
    await expect(
      actingAs({ userId }, (tx) =>
        tx.query("select public.create_company($1, $2)", ["Spray 6", "starter"]),
      ),
    ).rejects.toThrow(/maximum number of companies/i);
  });

  it("numbers consignments per tenant, starting at 1 for each", async () => {
    // The legacy build had a single global counter. Two tenants must not see
    // each other's volume in their own job numbers.
    const [firstA, firstB] = await asAdmin(async (tx) => {
      const { rows } = await tx.query<{ company_id: string; reference_no: number }>(
        `select company_id, min(reference_no) as reference_no
           from public.consignments
          where company_id in ($1, $2)
          group by company_id`,
        [companyA.companyId, companyB.companyId],
      );
      return [
        rows.find((r) => r.company_id === companyA.companyId)!.reference_no,
        rows.find((r) => r.company_id === companyB.companyId)!.reference_no,
      ];
    });
    expect(firstA).toBe(1);
    expect(firstB).toBe(1);
  });
});

describe("usage metering", () => {
  it("counts a consignment when it leaves draft, not when the draft is created", async () => {
    const before = await currentUsage(companyA.companyId);

    await actingAs({ userId: companyA.dispatcherId, companyId: companyA.companyId }, (tx) =>
      tx.query(
        `insert into public.consignments
           (company_id, client_id, status, pickup_mode, pickup_location_id, dropoff_location_id)
         values ($1, $2, 'draft', 'single', $3, $3)`,
        [companyA.companyId, companyA.clientId, companyA.locationId],
      ),
    );

    expect(await currentUsage(companyA.companyId)).toBe(before);

    await actingAs({ userId: companyA.dispatcherId, companyId: companyA.companyId }, (tx) =>
      tx.query(
        `update public.consignments set status = 'scheduled'
          where company_id = $1 and status = 'draft'`,
        [companyA.companyId],
      ),
    );

    expect(await currentUsage(companyA.companyId)).toBe(before + 1);
  });
});

async function currentUsage(companyId: string): Promise<number> {
  return asAdmin(async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      `select coalesce(sum(consignments_started), 0)::text as n
         from public.usage_counters
        where company_id = $1 and period_start = date_trunc('month', now())::date`,
      [companyId],
    );
    return Number(rows[0]!.n);
  });
}
