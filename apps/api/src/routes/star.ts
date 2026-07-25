import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/require-auth.js";
import { resolvePageAccess } from "../lib/page-access.js";
import { canView } from "../domain/permissions.js";

// Per-user page star (Gmail-style favourite). Starring only needs view access —
// a member can bookmark any page they can see. The star is scoped to the current
// user, so it never affects what other members see.
const starBodySchema = {
  type: "object",
  properties: {
    starred: { type: "boolean" },
  },
  required: ["starred"],
  additionalProperties: false,
} as const;

export async function registerStarRoutes(app: FastifyInstance) {
  app.put(
    "/pages/:id/star",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: starBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id } = request.params as { id: string };
      const { starred } = request.body as { starred: boolean };

      const access = await resolvePageAccess(user.id, id);
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canView(access.pageRole)) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "You do not have access to this page",
          traceId: request.id,
        });
      }

      if (starred) {
        // Idempotent: unique [userId, pageId] means a repeat star is a no-op.
        await prisma.pageStar.upsert({
          where: { userId_pageId: { userId: user.id, pageId: id } },
          create: { userId: user.id, pageId: id },
          update: {},
        });
      } else {
        await prisma.pageStar.deleteMany({
          where: { userId: user.id, pageId: id },
        });
      }

      return reply.send({ id, starred });
    },
  );
}
