"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUp, type ActionState } from "../actions";
import { Button, Card, FormError, Input, Label } from "@/components/ui";

const initial: ActionState = {};

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, initial);

  return (
    <Card>
      <h1 className="text-xl font-semibold">Create an account</h1>
      <p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-300">
        You will set up your transport company next. No card needed to start.
      </p>

      <form action={formAction} className="space-y-4">
        <FormError message={state.error} />

        <div>
          <Label htmlFor="fullName">Your name</Label>
          <Input id="fullName" name="fullName" autoComplete="name" required />
        </div>

        <div>
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
          />
          <p className="mt-1.5 text-xs text-ink-500 dark:text-ink-300">
            At least 12 characters, with upper and lower case and a number.
          </p>
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating account..." : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-sm">
        Already have an account?{" "}
        <Link href="/login" className="text-accent-600 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
