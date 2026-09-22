"use server";

/**
 * Staff invitations.
 *
 * Simpler than driver invitations: staff belong to one company, so there is no
 * consent gate to negotiate. The invitation row is inserted under the caller's
 * own policies rather than through a definer function, because a dispatcher
 * inviting a colleague is an ordinary write they are already entitled to make.
 */

import { revalidatePath } from "next/cache";
import { withTenantSession } from "@platform/db";
import { inviteCompanyUserSchema } from "@platform/shared";
import { requireCompanySession } from "@/lib/session";
import { generateInvitationToken, invitationUrl } from "@/lib/invitations";

export interface InviteTeammateState {
  error?: string;
  message?: string;
  inviteLink?: string;
}

export async function inviteTeammate(
  _prev: InviteTeammateState,
  formData: FormData,
): Promise<InviteTeammateState> {
  const session = await requireCompanySession();

  const parsed = inviteCompanyUserSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  }

  const token = generateInvitationToken();

  try {
    await withTenantSession(
      { userId: session.userId, companyId: session.activeCompany.companyId },
      async (tx) => {
        await tx.query(
          `insert into public.invitations
             (company_id, kind, email, role, token_hash, status, expires_at, invited_by)
           values ($1, 'company_user', $2, $3,
                   encode(extensions.digest($4, 'sha256'), 'hex'),
                   'pending', now() + interval '14 days', auth.uid())
           on conflict (company_id, kind, lower(email)) where status = 'pending'
           do update set token_hash = excluded.token_hash,
                         role = excluded.role,
                         expires_at = excluded.expires_at,
                         updated_at = now()`,
          [session.activeCompany.companyId, parsed.data.email, parsed.data.role, token],
        );
      },
    );

    revalidatePath("/team");

    return {
      message: `Invitation sent to ${parsed.data.email}.`,
      inviteLink: invitationUrl(token),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not send that invitation." };
  }
}
