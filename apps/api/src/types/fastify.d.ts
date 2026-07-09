import type { User } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: Pick<User, "id" | "email" | "displayName">;
    authSessionId?: string;
    csrfToken?: string;
  }
}
