"use server";

/**
 * Authentication actions.
 *
 * These talk to Supabase Auth only. Nothing here touches tenant data, and
 * nothing here grants access to a company: signing up creates an account with
 * no memberships at all, which row level security treats as seeing nothing.
 * Joining a company happens afterwards, through onboarding or an invitation.
 */

import { redirect } from "next/navigation";
import { signInSchema, signUpSchema, emailSchema } from "@platform/shared";
import { createClient } from "@/lib/supabase/server";

export interface ActionState {
  error?: string;
  message?: string;
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Check the details and try again.";
}

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/auth/callback`,
    },
  });

  if (error) return { error: error.message };

  redirect("/onboarding");
}

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  // Deliberately vague: distinguishing "no such account" from "wrong password"
  // turns the sign-in form into an account enumeration oracle.
  if (error) return { error: "That email and password do not match an account." };

  redirect("/");
}

export async function requestPasswordReset(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) return { error: "Enter a valid email address." };

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/auth/callback?next=/reset-password`,
  });

  // Always the same answer, whether or not the address exists.
  return { message: "If that address has an account, a reset link is on its way." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
