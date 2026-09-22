/**
 * Accepting or declining an invitation.
 *
 * The recipient usually cannot see the invitation row at all: they have no
 * membership yet, so every policy on the table evaluates false for them. Both
 * actions therefore go through SECURITY DEFINER functions which look the
 * invitation up by token hash and check, themselves, that the accepting
 * account's verified email matches the address it was sent to. A forwarded
 * link is useless to anyone else.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { InviteActions } from "./actions-form";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getSession();

  if (!session) {
    // Come back here once they have an account.
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-12">
      <PageHeader
        title="You have been invited"
        description="Accepting shares your profile with this company and lets them assign you work."
      />

      <Card>
        <p className="text-sm text-ink-600 dark:text-ink-300">
          You are signed in as <strong>{session.email}</strong>. An invitation can only be accepted
          by the account it was sent to.
        </p>

        <div className="mt-6">
          <InviteActions token={token} />
        </div>

        <p className="mt-6 text-xs text-ink-500 dark:text-ink-300">
          If this is not your invitation,{" "}
          <Link href="/" className="text-accent-600 hover:underline">
            go back
          </Link>
          .
        </p>
      </Card>
    </main>
  );
}
