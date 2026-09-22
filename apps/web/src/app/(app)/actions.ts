"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { assertMembership } from "@platform/db";
import { ACTIVE_COMPANY_COOKIE, requireUser } from "@/lib/session";

/**
 * Changes which company the session is acting for.
 *
 * Validated against the database before the cookie is written, so a user
 * cannot select a company they do not belong to. Row level security would stop
 * them regardless, but failing here gives a clear error instead of a page that
 * mysteriously shows nothing.
 */
export async function switchCompany(companyId: string): Promise<void> {
  const session = await requireUser();
  await assertMembership(session.userId, companyId);

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
}
