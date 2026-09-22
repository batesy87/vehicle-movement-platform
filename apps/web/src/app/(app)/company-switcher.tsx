"use client";

import { useTransition } from "react";
import type { Membership } from "@platform/db";
import { switchCompany } from "./actions";

/**
 * Present for anyone who belongs to more than one company, which includes
 * every self-employed driver working for several operators. Switching sets a
 * cookie; the server revalidates it against real memberships on every request,
 * so a tampered cookie changes nothing.
 */
export function CompanySwitcher({
  memberships,
  activeCompanyId,
}: {
  memberships: Membership[];
  activeCompanyId: string;
}) {
  const [pending, startTransition] = useTransition();

  if (memberships.length <= 1) {
    return <span className="font-medium">{memberships[0]?.companyName ?? "No company"}</span>;
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Active company</span>
      <select
        value={activeCompanyId}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => {
            void switchCompany(next);
          });
        }}
        className="rounded-lg border border-ink-300 bg-white px-2 py-1.5 font-medium dark:border-ink-600 dark:bg-ink-900"
      >
        {memberships.map((m) => (
          <option key={m.companyId} value={m.companyId}>
            {m.companyName}
            {m.staffRole ? ` (${m.staffRole})` : " (driver)"}
          </option>
        ))}
      </select>
    </label>
  );
}
