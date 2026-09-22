import Link from "next/link";
import { requireCompanySession } from "@/lib/session";
import { signOut } from "../(auth)/actions";
import { CompanySwitcher } from "./company-switcher";
import { Badge } from "@/components/ui";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/team", label: "Team" },
  { href: "/drivers", label: "Drivers" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCompanySession();

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <CompanySwitcher
            memberships={session.memberships}
            activeCompanyId={session.activeCompany.companyId}
          />

          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-1.5 hover:bg-ink-100 dark:hover:bg-ink-700"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <Badge>{session.activeCompany.planKey}</Badge>
            <span className="hidden text-ink-500 sm:inline dark:text-ink-300">{session.email}</span>
            <form action={signOut}>
              <button type="submit" className="text-accent-600 hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
