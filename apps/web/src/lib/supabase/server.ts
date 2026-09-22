/**
 * Supabase clients.
 *
 * Supabase is the identity provider here and nothing else. It issues and
 * refreshes the session; it is not used to read or write tenant data. That
 * goes through the Postgres pool in @platform/db, where a transaction can pin
 * the role, the claims and the active company together, which is what row
 * level security needs in order to scope a write.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

type CookieToSet = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

/** Reads the caller's session. Use in server components and server actions. */
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a server component, where cookies are read-only.
            // The middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

/**
 * Admin client, for creating users and sending invitation emails.
 *
 * Holds the service role key, which bypasses row level security entirely, so
 * it must never be constructed anywhere that could run in the browser.
 */
export function createAdminClient(): SupabaseClient {
  return createSupabaseClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
