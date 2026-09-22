import { withTenantSession } from "@platform/db";
import { canStartConsignment, PLANS_BY_KEY } from "@platform/shared";
import { requireCompanySession } from "@/lib/session";
import { Card, Notice, PageHeader } from "@/components/ui";

export default async function DashboardPage() {
  const session = await requireCompanySession();
  const { companyId, planKey, companyName, status } = session.activeCompany;

  // Everything below runs through row level security as this user. A bug that
  // dropped the company filter would return nothing rather than another
  // tenant's numbers.
  const stats = await withTenantSession({ userId: session.userId, companyId }, async (tx) => {
    const [consignments, vehicles, drivers, usage, trial] = await Promise.all([
      tx.query<{ n: string }>(
        `select count(*)::text as n from public.consignments where status not in ('draft','cancelled')`,
      ),
      tx.query<{ n: string }>(
        `select count(*)::text as n from public.consignment_vehicles where current_status <> 'delivered'`,
      ),
      tx.query<{ n: string }>(
        `select count(*)::text as n from public.driver_company_links where status = 'active'`,
      ),
      tx.query<{ n: string }>(
        `select coalesce(sum(consignments_started), 0)::text as n
           from public.usage_counters
          where period_start = date_trunc('month', now())::date`,
      ),
      tx.query<{ trial_ends_at: Date | null }>(
        "select trial_ends_at from public.companies limit 1",
      ),
    ]);

    return {
      activeConsignments: Number(consignments.rows[0]?.n ?? 0),
      vehiclesInFlight: Number(vehicles.rows[0]?.n ?? 0),
      activeDrivers: Number(drivers.rows[0]?.n ?? 0),
      usedThisMonth: Number(usage.rows[0]?.n ?? 0),
      trialEndsAt: trial.rows[0]?.trial_ends_at ?? null,
    };
  });

  const plan = PLANS_BY_KEY[planKey];
  const allowance = canStartConsignment(planKey, stats.usedThisMonth);

  return (
    <>
      <PageHeader
        title={companyName}
        description={
          status === "trial" && stats.trialEndsAt
            ? `Trial ends ${stats.trialEndsAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`
            : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active consignments" value={stats.activeConsignments} />
        <Stat label="Vehicles in flight" value={stats.vehiclesInFlight} />
        <Stat label="Active drivers" value={stats.activeDrivers} />
        <Stat
          label="Jobs this month"
          value={stats.usedThisMonth}
          suffix={
            plan?.includedJobsPerMonth === null || plan === undefined
              ? undefined
              : ` of ${plan.includedJobsPerMonth}`
          }
        />
      </div>

      {!allowance.allowed ? (
        <div className="mt-6">
          <Notice>{allowance.reason}</Notice>
        </div>
      ) : null}

      {allowance.overage ? (
        <div className="mt-6">
          <Notice>
            You are past this month&apos;s included allowance. Further jobs are billed at £
            {plan?.overagePricePerJob} each.
          </Notice>
        </div>
      ) : null}

      <div className="mt-8">
        <Card>
          <h2 className="font-medium">What is here so far</h2>
          <p className="mt-2 text-sm text-ink-500 dark:text-ink-300">
            This build covers the foundation: the multi-tenant schema with row level security on
            every table, authentication, company signup, and the staff and driver invitation flows.
            Consignments, legs, trips and the driver app come next.
          </p>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-ink-500 dark:text-ink-300">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {value}
        {suffix ? <span className="text-base font-normal text-ink-500">{suffix}</span> : null}
      </p>
    </Card>
  );
}
