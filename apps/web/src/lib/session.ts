/**
 * Who is asking, and which company they are acting as.
 *
 * The active company lives in a cookie, but the cookie is never trusted. Every
 * read of it is validated against the memberships the database reports, and a
 * cookie naming a company the user does not belong to is discarded rather than
 * honoured. Row level security would reject it regardless; this just turns a
 * policy violation into a sensible redirect.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listMemberships, type Membership } from "@platform/db";
import { createClient } from "./supabase/server";

export const ACTIVE_COMPANY_COOKIE = "active_company";

export interface AppSession {
  userId: string;
  email: string;
  memberships: Membership[];
  /** Null when the user has no companies yet, which means onboarding. */
  activeCompany: Membership | null;
}

/** Returns null when nobody is signed in. */
export async function getSession(): Promise<AppSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const memberships = await listMemberships(user.id);
  const cookieStore = await cookies();
  const requested = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;

  const activeCompany =
    memberships.find((m) => m.companyId === requested) ?? memberships[0] ?? null;

  return {
    userId: user.id,
    email: user.email ?? "",
    memberships,
    activeCompany,
  };
}

/** Redirects to sign-in, or to onboarding when the user has no company yet. */
export async function requireCompanySession(): Promise<AppSession & { activeCompany: Membership }> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.activeCompany) redirect("/onboarding");
  return session as AppSession & { activeCompany: Membership };
}

export async function requireUser(): Promise<AppSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
