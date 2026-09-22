import { withTenantSession } from "@platform/db";
import { requireCompanySession } from "@/lib/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { InviteDriverForm } from "./form";

interface DriverRow {
  link_id: string;
  status: string;
  driver_type: string;
  accepted_at: Date | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  vehicle_capability: string | null;
}

export default async function DriversPage() {
  const session = await requireCompanySession();
  const { companyId } = session.activeCompany;

  const drivers = await withTenantSession(
    { userId: session.userId, companyId },
    async (tx) => {
      // The join to driver_profiles is filtered by that table's own policy: a
      // driver's details are only readable once they have accepted. An invited
      // but not-yet-accepted link therefore shows with null columns, which is
      // exactly the consent boundary made visible.
      const { rows } = await tx.query<DriverRow>(
        `select dcl.id as link_id,
                dcl.status::text as status,
                dcl.driver_type::text as driver_type,
                dcl.accepted_at,
                dp.name,
                dp.email,
                dp.phone,
                dp.vehicle_capability::text as vehicle_capability
           from public.driver_company_links dcl
           left join public.driver_profiles dp on dp.id = dcl.driver_profile_id
          order by dcl.status, dcl.invited_at desc`,
      );
      return rows;
    },
  );

  const pendingInvites = await withTenantSession(
    { userId: session.userId, companyId },
    async (tx) => {
      const { rows } = await tx.query<{ email: string; kind: string; expires_at: Date }>(
        `select email, kind::text as kind, expires_at
           from public.invitations
          where status = 'pending' and kind in ('driver_new', 'driver_link')
          order by created_at desc`,
      );
      return rows;
    },
  );

  const canInvite =
    session.activeCompany.staffRole !== null && session.activeCompany.staffRole !== "viewer";

  return (
    <>
      <PageHeader
        title="Drivers"
        description="Drivers have one account across every company they work for. Adding one asks their permission first."
      />

      {canInvite ? (
        <div className="mb-8">
          <InviteDriverForm />
        </div>
      ) : null}

      <Card>
        <h2 className="mb-4 font-medium">Linked drivers</h2>

        {drivers.length === 0 ? (
          <p className="text-sm text-ink-500 dark:text-ink-300">
            No drivers yet. Invite one above to get started.
          </p>
        ) : (
          <ul className="divide-y divide-ink-200 dark:divide-ink-700">
            {drivers.map((driver) => (
              <li key={driver.link_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {driver.name ?? (
                      <span className="text-ink-500 dark:text-ink-300">
                        Awaiting their consent
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-ink-500 dark:text-ink-300">
                    {driver.email ?? "Details become visible when they accept"}
                    {driver.phone ? ` · ${driver.phone}` : ""}
                  </p>
                </div>
                {driver.vehicle_capability ? <Badge>{driver.vehicle_capability}</Badge> : null}
                <Badge>{driver.driver_type.replace("_", " ")}</Badge>
                <Badge>{driver.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pendingInvites.length > 0 ? (
        <div className="mt-6">
          <Card>
            <h2 className="mb-4 font-medium">Pending invitations</h2>
            <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {pendingInvites.map((invite) => (
                <li key={invite.email} className="flex items-center justify-between py-2">
                  <span>{invite.email}</span>
                  <span className="text-ink-500 dark:text-ink-300">
                    {invite.kind === "driver_link" ? "Awaiting consent" : "Awaiting sign-up"} ·
                    expires {invite.expires_at.toLocaleDateString("en-GB")}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}
    </>
  );
}
