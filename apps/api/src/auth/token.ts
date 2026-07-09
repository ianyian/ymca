import { createHash, randomBytes } from "node:crypto";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSecureToken(size = 32): string {
  return randomBytes(size).toString("base64url");
}
