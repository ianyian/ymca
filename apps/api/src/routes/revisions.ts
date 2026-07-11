import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/require-auth.js";
import { resolvePageAccess } from "../lib/page-access.js";
import { canEdit, canView } from "../domain/permissions.js";
import { getNextVersion, pruneRevisions } from "../domain/versioning.js";
import type { Prisma } from "@prisma/client";

const MAX_REVISIONS = 50;

export async function registerRevisionRoutes(app: FastifyInstance) {
  // List revisions for a page (most recent first, max 50)
  app.get(
    "/pages/:id/revisions",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id } = request.params as { id: string };

      const access = await resolvePageAccess(user.id, id);
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canView(access.pageRole)) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "No access to page",
          traceId: request.id,
        });
      }

      const revisions = await prisma.pageRevision.findMany({
        where: { pageId: id },
        orderBy: { createdAt: "desc" },
        take: MAX_REVISIONS,
        select: {
          id: true,
          pageId: true,
          version: true,
          createdBy: true,
          createdAt: true,
        },
      });

      return reply.send({ revisions });
    },
  );

  // Restore a page to a specific revision snapshot
  app.post(
    "/pages/:id/revisions/:revisionId/restore",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            revisionId: { type: "string", format: "uuid" },
          },
          required: ["id", "revisionId"],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id, revisionId } = request.params as {
        id: string;
        revisionId: string;
      };

      const access = await resolvePageAccess(user.id, id);
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canEdit(access.pageRole)) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "You do not have edit access to this page",
          traceId: request.id,
        });
      }
      const page = access.page;

      const revision = await prisma.pageRevision.findUnique({
        where: { id: revisionId },
      });
      if (!revision || revision.pageId !== id) {
        return reply.status(404).send({
          code: "REVISION_NOT_FOUND",
          message: "Revision not found",
          traceId: request.id,
        });
      }

      const nextVersion = getNextVersion(page.version);
      const snapshot = revision.snapshot as Prisma.InputJsonValue;

      const restored = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const updated = await tx.page.update({
            where: { id },
            data: { content: snapshot, version: nextVersion },
          });
          await tx.pageRevision.create({
            data: {
              pageId: id,
              version: nextVersion,
              snapshot,
              createdBy: user.id,
            },
          });
          await pruneRevisions(tx, id);
          return updated;
        },
      );

      return reply.send({ page: restored });
    },
  );
}
