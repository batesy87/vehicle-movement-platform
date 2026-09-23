/**
 * Where the active company comes from.
 *
 * Migration 0013 gave app.active_company_id() two sources: a server-side
 * override set on the connection, and a selection carried in the access token.
 * Both are meant, so both are tested here, along with the precedence between
 * them.
 *
 * The property being protected is the one docs/tenancy.md is built on. A claim
 * may name a company and must never make anyone a member of one, so every test
 * showing the token path working is paired with one showing it do nothing for
 * a company the caller does not belong to.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actingAs,
  actingAsToken,
  adminPool,
  asAdmin,
  createAuthUser,
  createDriverProfile,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers";

let alpha: SeededCompany;
let beta: SeededCompany;
let driverProfileId: string;
let driverUserId: string;

beforeAll(async () => {
  await truncateAll();

  const driver = await createDriverProfile("Source Driver");
  driverProfileId = driver.driverProfileId;
  driverUserId = driver.authUserId;

  alpha = await seedCompany("Source Alpha", driverProfileId);
  beta = await seedCompany("Source Beta", driverProfileId);
});

afterAll(async () => {
  await adminPool.end();
});

describe("the server-side override", () => {
  it("decides when it is set", async () => {
    const active = await actingAs(
      { userId: alpha.ownerId, companyId: alpha.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ id: string | null }>(
          "select app.active_company_id() as id",
        );
        return rows[0]!.id;
      },
    );
    expect(active).toBe(alpha.companyId);
  });

  it("means no active company when left empty", async () => {
    // withTenantSession builds request.jwt.claims itself, as {sub, role}, so
    // the pooled path has no app_metadata to fall through to. Every call site
    // that passes no company is relying on that still meaning no writes.
    const active = await actingAs({ userId: alpha.ownerId }, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>(
        "select app.active_company_id() as id",
      );
      return rows[0]!.id;
    });
    expect(active).toBeNull();
  });
});

describe("the token", () => {
  it("supplies the active company when no override is set", async () => {
    const active = await actingAsToken(
      { userId: alpha.ownerId, activeCompanyId: alpha.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ id: string | null }>(
          "select app.active_company_id() as id",
        );
        return rows[0]!.id;
      },
    );
    expect(active).toBe(alpha.companyId);
  });

  it("leaves it null when the token carries no selection", async () => {
    const active = await actingAsToken({ userId: alpha.ownerId }, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>(
        "select app.active_company_id() as id",
      );
      return rows[0]!.id;
    });
    expect(active).toBeNull();
  });

  it("carries a real write through, which is the point of the change", async () => {
    const clientId = await actingAsToken(
      { userId: alpha.ownerId, activeCompanyId: alpha.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into public.clients (company_id, name)
           values ($1, 'Written without a server-side override') returning id`,
          [alpha.companyId],
        );
        return rows[0]!.id;
      },
    );
    expect(clientId).toBeTruthy();
  });

  it("still refuses a write with no selection at all", async () => {
    await expect(
      actingAsToken({ userId: alpha.ownerId }, async (tx) =>
        tx.query(`insert into public.clients (company_id, name) values ($1, 'No selection')`, [
          alpha.companyId,
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe("a claim is a selection, never an authorisation", () => {
  it("does not let a stranger write to a company by naming it", async () => {
    const stranger = await createAuthUser("stranger@example.test");

    await expect(
      actingAsToken({ userId: stranger, activeCompanyId: alpha.companyId }, async (tx) =>
        tx.query(`insert into public.clients (company_id, name) values ($1, 'Nope')`, [
          alpha.companyId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("does not let a member of one company write to another by naming it", async () => {
    // beta.ownerId is a real user with a real company. Pointing their claim at
    // alpha is exactly the forgery this design has to survive.
    await expect(
      actingAsToken({ userId: beta.ownerId, activeCompanyId: alpha.companyId }, async (tx) =>
        tx.query(`insert into public.clients (company_id, name) values ($1, 'Cross-tenant')`, [
          alpha.companyId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("stops working the moment the link goes inactive, token unchanged", async () => {
    // The property that ruled out carrying membership in a token. The driver
    // presents the same claim throughout. Only the table changes.
    await asAdmin((tx) =>
      tx.query(
        `update public.driver_company_links set status = 'active'
          where driver_profile_id = $1 and company_id = $2`,
        [driverProfileId, beta.companyId],
      ),
    );

    const whileLinked = await actingAsToken(
      { userId: driverUserId, activeCompanyId: beta.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.companies where id = $1",
          [beta.companyId],
        );
        return Number(rows[0]!.n);
      },
    );
    expect(whileLinked).toBe(1);

    await asAdmin((tx) =>
      tx.query(
        `update public.driver_company_links set status = 'inactive'
          where driver_profile_id = $1 and company_id = $2`,
        [driverProfileId, beta.companyId],
      ),
    );

    const afterRevoke = await actingAsToken(
      { userId: driverUserId, activeCompanyId: beta.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "select count(*)::text as n from public.companies where id = $1",
          [beta.companyId],
        );
        return Number(rows[0]!.n);
      },
    );
    expect(afterRevoke).toBe(0);
  });
});

describe("precedence", () => {
  it("gives the override the last word when both are present", async () => {
    // Both companies here are ones this user legitimately belongs to, so this
    // tests precedence rather than authorisation. A server that has gone to the
    // trouble of pinning a company means it.
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({
          sub: alpha.ownerId,
          role: "authenticated",
          app_metadata: { active_company_id: beta.companyId },
        }),
      ]);
      await client.query("select set_config('app.active_company_id', $1, true)", [alpha.companyId]);

      const { rows } = await client.query<{ id: string | null }>(
        "select app.active_company_id() as id",
      );
      await client.query("commit");

      expect(rows[0]!.id).toBe(alpha.companyId);
    } finally {
      client.release();
    }
  });
});
