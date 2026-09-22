"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withTenantSession } from "@platform/db";
import { ACTIVE_COMPANY_COOKIE, requireUser } from "@/lib/session";

export interface InviteActionState {
  error?: string;
  message?: string;
}

export async function acceptInvitation(
  _prev: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const session = await requireUser();
  const token = String(formData.get("token") ?? "");
  if (!token) return { error: "That link is not valid." };

  let companyId: string;
  try {
    companyId = await withTenantSession({ userId: session.userId }, async (tx) => {
      const { rows } = await tx.query<{ result: { company_id: string } }>(
        "select public.accept_invitation($1) as result",
        [token],
      );
      return rows[0]!.result.company_id;
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not accept that invitation." };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect("/dashboard");
}

export async function declineInvitation(
  _prev: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const session = await requireUser();
  const token = String(formData.get("token") ?? "");
  if (!token) return { error: "That link is not valid." };

  try {
    await withTenantSession({ userId: session.userId }, async (tx) => {
      await tx.query("select public.decline_invitation($1)", [token]);
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not decline that invitation." };
  }

  return { message: "Declined. The company has been told you are not available." };
}
