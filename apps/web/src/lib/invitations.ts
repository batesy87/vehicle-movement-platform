/**
 * Invitation tokens.
 *
 * The plaintext token exists twice: once in the email, once in the link the
 * recipient clicks. The database stores only its SHA-256 hash, so a dump of
 * the invitations table cannot be used to accept anybody's invitation.
 *
 * Hashing happens in Postgres rather than here, inside the same function that
 * looks the invitation up, which keeps the algorithm in one place and means a
 * caller cannot accidentally pass an already-hashed value.
 */

import { randomBytes } from "node:crypto";

/** 256 bits of entropy, URL-safe. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function invitationUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/invite/${encodeURIComponent(token)}`;
}
