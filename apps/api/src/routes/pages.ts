import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/require-auth.js";
import { getNextVersion, hasVersionConflict } from "../domain/versioning.js";

const createPageBodySchema = {
  type: "object",
  properties: {
    parentPageId: {
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
    },
    title: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const pageMetaBodySchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    icon: { type: "string", maxLength: 32 },
    coverImageUrl: { type: "string", maxLength: 512 },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 64 },
      maxItems: 30,
    },
  },
  additionalProperties: false,
} as const;

const pageContentBodySchema = {
  type: "object",
  properties: {
    expectedVersion: { type: "integer", minimum: 1 },
    content: {},
  },
  required: ["expectedVersion", "content"],
  additionalProperties: false,
} as const;

async function assertWorkspaceAccess(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
  });

  return membership !== null;
}

export async function registerPageRoutes(app: FastifyInstance) {
  app.post(
    "/workspaces/:workspaceId/pages",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            workspaceId: { type: "string", format: "uuid" },
          },
          required: ["workspaceId"],
        },
        body: createPageBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) {
        return;
      }

      const params = request.params as { workspaceId: string };
      const body = request.body as { parentPageId?: string; title?: string };

      const hasAccess = await assertWorkspaceAccess(
        user.id,
        params.workspaceId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "No access to workspace",
          traceId: request.id,
        });
      }

      if (body.parentPageId) {
        const parent = await prisma.page.findUnique({
          where: { id: body.parentPageId },
        });
        if (!parent || parent.workspaceId !== params.workspaceId) {
          return reply.status(400).send({
            code: "INVALID_PARENT_PAGE",
            message: "Parent page is not in the target workspace",
            traceId: request.id,
          });
        }
      }

      const page = await prisma.page.create({
        data: {
          workspaceId: params.workspaceId,
          parentPageId: body.parentPageId,
          creatorId: user.id,
          title: body.title?.trim() || "Untitled",
          content: {
            type: "doc",
            content: [],
          },
        },
      });

      return reply.status(201).send({ page });
    },
  );

  app.get(
    "/pages/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) {
        return;
      }

      const params = request.params as { id: string };
      const page = await prisma.page.findUnique({
        where: { id: params.id },
      });

      if (!page || page.deletedAt) {
        return reply.status(404).send({
          code: "PAGE_NOT_FOUND",
          message: "Page not found",
          traceId: request.id,
        });
      }

      const hasAccess = await assertWorkspaceAccess(user.id, page.workspaceId);
      if (!hasAccess) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "No access to page",
          traceId: request.id,
        });
      }

      return reply.send({ page });
    },
  );

  app.patch(
    "/pages/:id/meta",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        body: pageMetaBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) {
        return;
      }

      const params = request.params as { id: string };
      const body = request.body as {
        title?: string;
        icon?: string;
        coverImageUrl?: string;
        tags?: string[];
      };

      const existingPage = await prisma.page.findUnique({
        where: { id: params.id },
      });
      if (!existingPage || existingPage.deletedAt) {
        return reply.status(404).send({
          code: "PAGE_NOT_FOUND",
          message: "Page not found",
          traceId: request.id,
        });
      }

      const hasAccess = await assertWorkspaceAccess(
        user.id,
        existingPage.workspaceId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "No access to page",
          traceId: request.id,
        });
      }

      const page = await prisma.page.update({
        where: { id: params.id },
        data: {
          title: body.title?.trim() || existingPage.title,
          icon: typeof body.icon === "string" ? body.icon : existingPage.icon,
          coverImageUrl:
            typeof body.coverImageUrl === "string"
              ? body.coverImageUrl
              : existingPage.coverImageUrl,
          ...(Array.isArray(body.tags) && {
            tags: body.tags.map((t) => t.trim()).filter(Boolean),
          }),
        },
      });

      return reply.send({ page });
    },
  );

  app.put(
    "/pages/:id/content",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        body: pageContentBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) {
        return;
      }

      const params = request.params as { id: string };
      const body = request.body as {
        expectedVersion: number;
        content: unknown;
      };

      const page = await prisma.page.findUnique({
        where: { id: params.id },
      });
      if (!page || page.deletedAt) {
        return reply.status(404).send({
          code: "PAGE_NOT_FOUND",
          message: "Page not found",
          traceId: request.id,
        });
      }

      const hasAccess = await assertWorkspaceAccess(user.id, page.workspaceId);
      if (!hasAccess) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "No access to page",
          traceId: request.id,
        });
      }

      if (hasVersionConflict(page.version, body.expectedVersion)) {
        return reply.status(409).send({
          code: "VERSION_CONFLICT",
          message: "Page has a newer version",
          traceId: request.id,
          latest: {
            version: page.version,
            updatedAt: page.updatedAt,
          },
        });
      }

      const nextVersion = getNextVersion(page.version);
      const contentJson = body.content as Prisma.InputJsonValue;
      const updatedPage = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const saved = await tx.page.update({
            where: { id: page.id },
            data: {
              content: contentJson,
              version: nextVersion,
            },
          });

          await tx.pageRevision.create({
            data: {
              pageId: page.id,
              version: nextVersion,
              snapshot: contentJson,
              createdBy: user.id,
            },
          });

          return saved;
        },
      );

      return reply.send({ page: updatedPage });
    },
  );
}
