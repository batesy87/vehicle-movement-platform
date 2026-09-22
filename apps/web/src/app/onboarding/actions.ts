"use server";

/**
 * Company creation.
 *
 * Calls public.create_company, which is a SECURITY DEFINER function. It has to
 * be: a user who has just signed up belongs to nothing, so row level security
 * correctly refuses to let them insert a company row. The only policy that
 * would allow it is USING (true), and this schema does not contain one of
 * those. The function creates the company and its first owner in a single
 * transaction and re-checks authorisation itself.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withTenantSession } from "@platform/db";
import { createCompanySchema } from "@platform/shared";
import { requireUser } from "@/lib/session";
import { ACTIVE_COMPANY_COOKIE } from "@/lib/session";

export interface OnboardingState {
  error?: string;
}

export async function createCompany(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await requireUser();

  const parsed = createCompanySchema.safeParse({
    name: formData.get("name"),
    tradingName: formData.get("tradingName") ?? "",
    registrationNumber: formData.get("registrationNumber") ?? "",
    planKey: formData.get("planKey"),
    billingModel: "subscription",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  }

  const trialDays = Number(process.env.TRIAL_PERIOD_DAYS ?? 14);

  let companyId: string;
  try {
    companyId = await withTenantSession({ userId: session.userId }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select public.create_company($1, $2, $3, $4, 'subscription', $5) as id",
        [
          parsed.data.name,
          parsed.data.planKey,
          parsed.data.tradingName || null,
          parsed.data.registrationNumber || null,
          Number.isFinite(trialDays) ? trialDays : 14,
        ],
      );
      return rows[0]!.id;
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create the company." };
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
