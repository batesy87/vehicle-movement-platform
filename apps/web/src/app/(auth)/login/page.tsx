"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, type ActionState } from "../actions";
import { Button, Card, FormError, Input, Label } from "@/components/ui";

const initial: ActionState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, initial);

  return (
    <Card>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
        Dispatchers and drivers use the same account.
      </p>

      <form action={formAction} className="space-y-4">
        <FormError message={state.error} />

        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      <div className="mt-6 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-accent-600 hover:underline">
          Forgot your password?
        </Link>
        <Link href="/signup" className="text-accent-600 hover:underline">
          Create an account
        </Link>
      </div>
    </Card>
  );
}
