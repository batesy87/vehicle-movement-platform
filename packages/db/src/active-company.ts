/**
 * Which company a session is acting for.
 *
 * The database refuses to guess. `app.can_write_company()` requires an
 * explicitly chosen company, and with none chosen nothing is writable, because
 * a dispatcher who works for two operators must say which set of books an
 * action belongs in before it lands in one.
 *
 * This is the application side of that rule, and it exists as its own function
 * because the obvious inline version was wrong. Falling back to the first
 * membership looks harmless and is not: `my_memberships()` orders by company
 * name, so "first" means "alphabetically first", and a user who belongs to
 * several companies and has not chosen silently gets one picked for them.
 *
 * For writes against rows that already exist that fails closed, since the
 * policy compares the active company against the row's own and refuses a
 * mismatch. New rows are the problem. There the active company IS the
 * destination, so there is nothing for the database to disagree with, and an
 * invitation or a consignment lands in a company nobody selected.
 *
 * So: honour a valid choice, default only when there is no choice to make, and
 * otherwise return null and let the caller ask.
 */

import type { Membership } from "./client";

export function chooseActiveCompany(
  memberships: readonly Membership[],
  requested: string | null | undefined,
): Membership | null {
  if (requested) {
    const chosen = memberships.find((m) => m.companyId === requested);
    // A request naming a company the user does not belong to is discarded
    // rather than honoured, and deliberately does not fall through to a
    // default. Someone whose cookie has gone stale should be asked again, not
    // quietly moved to a different tenant.
    if (chosen) return chosen;
    return memberships.length === 1 ? (memberships[0] ?? null) : null;
  }

  // One membership is not a choice, so making the user confirm it would be
  // ceremony. More than one is a choice, and it is theirs.
  if (memberships.length === 1) return memberships[0] ?? null;

  return null;
}
