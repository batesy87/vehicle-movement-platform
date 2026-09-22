"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type ActionState } from "../actions";
import { Button, Card, FormError, Input, Label, Notice } from "@/components/ui";

const initial: ActionState = {};

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initial);

  return (
    <Card>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
        We will email you a link to set a new one.
      </p>

      <form action={formAction} className="space-y-4">
        <FormError message={state.error} />
        {state.message ? <Notice>{state.message}</Notice> : null}

        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-sm">
        <Link href="/login" className="text-accent-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}
