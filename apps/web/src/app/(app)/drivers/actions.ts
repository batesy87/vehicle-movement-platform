"use server";

/**
 * Driver invitations.
 *
 * Two paths, and the difference between them is the point.
 *
 * If the email is unknown, a stub profile is created and the driver is asked
 * to set a password.
 *
 * If a driver with that email already exists, they are NOT linked
 * automatically. A request goes to them and they decide. A driver's licence
 * details and contact information become visible to a new company because they
 * agreed, not because that company knew their email address. Since acceptance
 * is all-or-nothing, the question really being asked is "do you want to work
 * for this company at all".
 *
 * Both paths are decided inside public.invite_driver, under an advisory lock,
 * so two dispatchers inviting the same person at the same moment cannot create
 * two profiles for one driver.
 */

import { revalidatePath } from "next/cache";
import { withTenantSession } from "@platform/db";
import { inviteDriverSchema } from "@platform/shared";
import { requireCompanySession } from "@/lib/session";
import { generateInvitationToken, invitationUrl } from "@/lib/invitations";

export interface InviteDriverState {
  error?: string;
  message?: string;
  /** Shown in development, where no email is actually sent. */
  inviteLink?: string;
}

export async function inviteDriver(
  _prev: InviteDriverState,
  formData: FormData,
): Promise<InviteDriverState> {
  const session = await requireCompanySession();

  const parsed = inviteDriverSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") ?? "",
    phone: formData.get("phone") ?? "",
    driverType: formData.get("driverType") ?? "self_employed",
    vehicleCapability: formData.get("vehicleCapability") ?? "car",
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  }

  const token = generateInvitationToken();

  try {
    const result = await withTenantSession(
      { userId: session.userId, companyId: session.activeCompany.companyId },
      async (tx) => {
        const { rows } = await tx.query<{ result: { path: string } }>(
          "select public.invite_driver($1, $2, $3, $4, $5, $6, $7, $8) as result",
          [
            session.activeCompany.companyId,
            parsed.data.email,
            token,
            parsed.data.name || null,
            parsed.data.phone || null,
            parsed.data.driverType,
            parsed.data.vehicleCapability,
            parsed.data.notes || null,
          ],
        );
        return rows[0]!.result;
      },
    );

    revalidatePath("/drivers");

    const message =
      result.path === "new_profile"
        ? `Invitation sent to ${parsed.data.email}. They will be asked to create an account.`
        : `${parsed.data.email} already has a driver profile. They have been asked to confirm they want to work with you, and will appear here once they accept.`;

    // TODO: send the email. Until then the link is surfaced so the flow is
    // usable end to end in development.
    return { message, inviteLink: invitationUrl(token) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not send that invitation.",
    };
  }
}
