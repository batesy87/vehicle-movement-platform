/**
 * Database access, and the one place where a request's identity is attached to
 * a connection.
 *
 * Architecture note, because this decides how the whole application talks to
 * the database.
 *
 * Writes require an explicitly chosen active company, set per transaction as
 * `app.active_company_id`. A PostgREST-style client cannot do that: each call
 * is its own transaction, so a value set in one request is gone by the next.
 * So the application does not read or write tenant data through supabase-js.
 * Supabase Auth issues the identity; data access goes through this pool, where
 * we control the transaction and can pin the role, the claims and the active
 * company together.
 *
 * Every tenant query therefore runs:
 *
 *   BEGIN
 *   SET LOCAL ROLE authenticated          -- policies now apply to us
 *   SET LOCAL request.jwt.claims = ...    -- auth.uid() resolves
 *   SET LOCAL app.active_company_id = ... -- writes are scoped
 *   ... the actual work ...
 *   COMMIT                                -- all three settings revert
 *
 * SET LOCAL reverts at transaction end, which is what makes this safe on a
 * pooled connection: a transaction cannot leak its identity to whoever gets
 * that connection next.
 */

import pg from "pg";

export interface TenantSession {
  /** The Supabase auth user id. */
  userId: string;
  /**
   * The company this request is acting for. Required for any write: with it
   * unset, every INSERT, UPDATE and DELETE policy in the schema evaluates
   * false. Reads still work across every company the user belongs to.
   */
  companyId?: string | null;
}

export type Queryable = Pick<pg.PoolClient, "query">;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set.");
    }
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Runs `fn` inside a transaction that carries the caller's identity, with row
 * level security in force.
 *
 * This is the only supported way to touch tenant data. Anything that bypasses
 * it is running as the pool's owning role, which is not subject to policies.
 */
export async function withTenantSession<T>(
  session: TenantSession,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!session.userId) {
    throw new Error("withTenantSession requires a userId.");
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    // Dropping to `authenticated` is what subjects this transaction to the
    // policies. Without it we would be running as the pool role, which owns
    // the tables.
    await client.query("set local role authenticated");
    // Parameterised, not interpolated: these values come from a token and a
    // user-selected company id.
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: session.userId, role: "authenticated" }),
    ]);
    await client.query("select set_config('app.active_company_id', $1, true)", [
      session.companyId ?? "",
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
 * Runs `fn` with row level security bypassed.
 *
 * For support tooling, Stripe webhooks and background jobs that genuinely have
 * no user behind them. Every call site should be obvious from a grep, which is
 * why this is named the way it is rather than something comfortable.
 */
export async function withServiceRole<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
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
 * Companies the current session may act for, with the role held in each.
 * What the company switcher renders from.
 */
export interface Membership {
  companyId: string;
  companyName: string;
  planKey: string;
  status: string;
  staffRole: string | null;
  isDriver: boolean;
}

export async function listMemberships(userId: string): Promise<Membership[]> {
  return withTenantSession({ userId }, async (tx) => {
    const { rows } = await tx.query<{
      company_id: string;
      company_name: string;
      plan_key: string;
      status: string;
      staff_role: string | null;
      is_driver: boolean;
    }>("select * from public.my_memberships()");

    return rows.map((r) => ({
      companyId: r.company_id,
      companyName: r.company_name,
      planKey: r.plan_key,
      status: r.status,
      staffRole: r.staff_role,
      isDriver: r.is_driver,
    }));
  });
}

/**
 * Confirms a user may act for a company before anything is written in its name.
 *
 * Row level security enforces this regardless, so this is not the control. It
 * exists so the application can fail with a clear message rather than an opaque
 * policy violation, and so a mistaken company id never reaches a query.
 */
export async function assertMembership(userId: string, companyId: string): Promise<Membership> {
  const memberships = await listMemberships(userId);
  const match = memberships.find((m) => m.companyId === companyId);
  if (!match) {
    throw new Error("You do not have access to that company.");
  }
  return match;
}
