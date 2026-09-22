import { withTenantSession } from "@platform/db";
import { requireCompanySession } from "@/lib/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { InviteTeammateForm } from "./form";

export default async function TeamPage() {
  const session = await requireCompanySession();
  const { companyId, staffRole } = session.activeCompany;

  const [members, invites] = await withTenantSession(
    { userId: session.userId, companyId },
    async (tx) => {
      const membersResult = await tx.query<{
        id: string;
        role: string;
        is_active: boolean;
        created_at: Date;
      }>(
        `select id, role::text as role, is_active, created_at
           from public.company_users
          order by case role
                     when 'owner' then 1 when 'admin' then 2
                     when 'dispatcher' then 3 else 4 end, created_at`,
      );

      const invitesResult = await tx.query<{ email: string; role: string; expires_at: Date }>(
        `select email, role::text as role, expires_at
           from public.invitations
          where status = 'pending' and kind = 'company_user'
          order by created_at desc`,
      );

      return [membersResult.rows, invitesResult.rows] as const;
    },
  );

  const canInvite = staffRole === "owner" || staffRole === "admin" || staffRole === "dispatcher";

  return (
    <>
      <PageHeader
        title="Team"
        description="Who can see and manage this company's work. Drivers are managed separately."
      />

      {canInvite ? (
        <div className="mb-8">
          <InviteTeammateForm />
        </div>
      ) : null}

      <Card>
        <h2 className="mb-4 font-medium">Members</h2>
        <ul className="divide-y divide-ink-200 dark:divide-ink-700">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between py-3">
              <span className="text-sm">
                Joined {member.created_at.toLocaleDateString("en-GB")}
              </span>
              <span className="flex items-center gap-2">
                {!member.is_active ? <Badge>inactive</Badge> : null}
                <Badge>{member.role}</Badge>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-ink-500 dark:text-ink-300">
          Names and email addresses come from the auth service and are not joined here yet.
        </p>
      </Card>

      {invites.length > 0 ? (
        <div className="mt-6">
          <Card>
            <h2 className="mb-4 font-medium">Pending invitations</h2>
            <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-700">
              {invites.map((invite) => (
                <li key={invite.email} className="flex items-center justify-between py-2">
                  <span>{invite.email}</span>
                  <span className="flex items-center gap-2 text-ink-500 dark:text-ink-300">
                    <Badge>{invite.role}</Badge>
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
