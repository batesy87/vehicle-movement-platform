import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { chooseCompany } from "./actions";

/**
 * Asks which company the user is acting for.
 *
 * Only reachable by someone who belongs to more than one and has not chosen,
 * which in practice means a self-employed driver working for several operators
 * or an administrator of more than one business. Everyone else is redirected
 * straight past it.
 *
 * It exists because the alternative is choosing for them, and the company a
 * session is acting for decides which set of books a new record lands in.
 * Getting that wrong is not a cosmetic error, and it is not one the database
 * can catch, because a write to a company you genuinely belong to looks
 * exactly like a write you meant.
 */
export default async function SelectCompanyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.memberships.length === 0) redirect("/onboarding");
  if (session.activeCompany) redirect("/dashboard");

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <PageHeader
        title="Which company are you working as?"
        description="You belong to more than one. Anything you create will be recorded against the one you pick, so this is not a display setting. You can change it at any time from the header."
      />

      <div className="grid gap-3">
        {session.memberships.map((m) => (
          <Card key={m.companyId}>
            <form action={chooseCompany} className="flex flex-wrap items-center gap-4">
              <input type="hidden" name="companyId" value={m.companyId} />
              <div className="min-w-0">
                <p className="font-medium">{m.companyName}</p>
                <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300">
                  {m.staffRole ? m.staffRole : "driver"}
                  {m.status === "active" ? "" : ` · ${m.status}`}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <Badge>{m.planKey}</Badge>
                <Button type="submit">Continue</Button>
              </div>
            </form>
          </Card>
        ))}
      </div>
    </main>
  );
}
