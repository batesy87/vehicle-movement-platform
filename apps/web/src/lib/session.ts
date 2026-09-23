/**
 * Who is asking, and which company they are acting as.
 *
 * The active company lives in a cookie, but the cookie is never trusted. Every
 * read of it is validated against the memberships the database reports, and a
 * cookie naming a company the user does not belong to is discarded rather than
 * honoured. Row level security would reject it regardless; this just turns a
 * policy violation into a sensible redirect.
 *
 * What it does NOT do is pick a company when the user has not. The rule lives
 * in chooseActiveCompany, in @platform/db, with the reasoning next to it.
 * Short version: the database refuses to guess which tenant a write belongs
 * to, and an application that guesses on its behalf has removed the protection
 * rather than implemented it.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { chooseActiveCompany, listMemberships, type Membership } from "@platform/db";
import { createClient } from "./supabase/server";

export const ACTIVE_COMPANY_COOKIE = "active_company";

export interface AppSession {
  userId: string;
  email: string;
  memberships: Membership[];
  /**
   * Null in two different situations, which callers must tell apart by looking
   * at `memberships`: the user has no companies yet, which means onboarding,
   * or they have several and have not chosen, which means asking them.
   */
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

  return {
    userId: user.id,
    email: user.email ?? "",
    memberships,
    activeCompany: chooseActiveCompany(memberships, requested),
  };
}

/**
 * For pages that act on behalf of a company.
 *
 * Three outcomes, kept distinct on purpose. Nobody signed in goes to sign-in.
 * Nobody with a company goes to onboarding, which is where a company gets
 * created. Somebody with several and no choice made goes to the picker, which
 * is emphatically not onboarding: sending them there would invite them to
 * create a fourth company when what they needed was to say which of their
 * three they meant.
 */
export async function requireCompanySession(): Promise<AppSession & { activeCompany: Membership }> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.memberships.length === 0) redirect("/onboarding");
  if (!session.activeCompany) redirect("/select-company");
  return session as AppSession & { activeCompany: Membership };
}

export async function requireUser(): Promise<AppSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
