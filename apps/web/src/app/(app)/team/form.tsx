"use client";

import { useActionState } from "react";
import { inviteTeammate, type InviteTeammateState } from "./actions";
import { Button, Card, FormError, Input, Label, Notice, Select } from "@/components/ui";

const initial: InviteTeammateState = {};

const ROLE_HELP: Record<string, string> = {
  admin: "Everything except transferring ownership, including finance.",
  dispatcher: "Books and assigns work. Cannot see rate cards or invoices.",
  viewer: "Read-only.",
};

export function InviteTeammateForm() {
  const [state, formAction, pending] = useActionState(inviteTeammate, initial);

  return (
    <Card>
      <h2 className="font-medium">Invite a teammate</h2>

      <form action={formAction} className="mt-4 space-y-4">
        <FormError message={state.error} />
        {state.message ? <Notice>{state.message}</Notice> : null}
        {state.inviteLink ? (
          <Notice>
            Email delivery is not wired up yet, so here is the link:{" "}
            <code className="break-all text-xs">{state.inviteLink}</code>
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div>
            <Label htmlFor="role">Role</Label>
            <Select id="role" name="role" defaultValue="dispatcher">
              <option value="admin">Admin</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="viewer">Viewer</option>
            </Select>
          </div>
        </div>

        <p className="text-xs text-ink-500 dark:text-ink-300">
          {Object.entries(ROLE_HELP)
            .map(([role, help]) => `${role}: ${help}`)
            .join("  ")}
        </p>

        <Button type="submit" disabled={pending}>
          {pending ? "Sending..." : "Send invitation"}
        </Button>
      </form>
    </Card>
  );
}
