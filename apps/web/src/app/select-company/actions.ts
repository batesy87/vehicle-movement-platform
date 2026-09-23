"use server";

import { redirect } from "next/navigation";
import { switchCompany } from "../(app)/actions";

/**
 * Records the company chosen on the picker and sends the user on.
 *
 * Thin on purpose: switchCompany already validates the id against real
 * memberships before writing the cookie, and row level security would refuse
 * anything it let through. All this adds is the redirect, which the switcher
 * in the app header does not want because it stays on the current page.
 */
export async function chooseCompany(formData: FormData): Promise<void> {
  const companyId = String(formData.get("companyId") ?? "");
  await switchCompany(companyId);
  redirect("/dashboard");
}
