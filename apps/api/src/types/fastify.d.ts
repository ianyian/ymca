import type { User } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: Pick<User, "id" | "email" | "displayName"> & {
      // Global app role, denormalized onto the request for fast authorization
      // checks (CoMa access, etc.) without an extra query per request.
      appRoleKey: string;
      appRoleRank: number;
    };
    authSessionId?: string;
    csrfToken?: string;
    // True when the session was resolved from an Authorization: Bearer header
    // rather than the cookie. Bearer requests are immune to CSRF (the token is
    // never sent automatically by the browser), so the CSRF check is skipped.
    authViaBearer?: boolean;
  }
}
