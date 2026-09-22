"use client";

import { useActionState } from "react";
import { acceptInvitation, declineInvitation, type InviteActionState } from "./actions";
import { Button, FormError, Notice } from "@/components/ui";

const initial: InviteActionState = {};

export function InviteActions({ token }: { token: string }) {
  const [acceptState, acceptAction, accepting] = useActionState(acceptInvitation, initial);
  const [declineState, declineAction, declining] = useActionState(declineInvitation, initial);

  return (
    <div className="space-y-4">
      <FormError message={acceptState.error ?? declineState.error} />
      {declineState.message ? <Notice>{declineState.message}</Notice> : null}

      {!declineState.message ? (
        <div className="flex gap-3">
          <form action={acceptAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" disabled={accepting || declining}>
              {accepting ? "Accepting..." : "Accept"}
            </Button>
          </form>

          <form action={declineAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" variant="secondary" disabled={accepting || declining}>
              {declining ? "Declining..." : "Decline"}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
