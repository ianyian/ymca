import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/require-auth.js";
import { isValidWorkspaceSlug, toWorkspaceSlug } from "../domain/workspace.js";

const workspaceBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 }
  },
  required: ["name"],
  additionalProperties: false
} as const;

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.post(
    "/workspaces",
    {
      schema: {
        body: workspaceBodySchema
      }
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) {
        return;
      }

      const body = request.body as { name: string };
      const workspaceName = body.name.trim();
      const workspaceSlug = toWorkspaceSlug(workspaceName);

      if (!isValidWorkspaceSlug(workspaceSlug)) {
        return reply.status(400).send({
          code: "INVALID_WORKSPACE_SLUG",
          message: "Workspace name must produce a slug with at least 3 characters",
          traceId: request.id
        });
      }

      try {
        const workspace = await prisma.$transaction(async (tx) => {
          const createdWorkspace = await tx.workspace.create({
            data: {
              name: workspaceName,
              slug: workspaceSlug,
              ownerId: user.id
            }
          });

          await tx.workspaceMember.create({
            data: {
              workspaceId: createdWorkspace.id,
              userId: user.id,
              role: "WorkspaceOwner"
            }
          });

          return createdWorkspace;
        });

        return reply.status(201).send({
          workspace
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.status(409).send({
            code: "WORKSPACE_SLUG_TAKEN",
            message: "Workspace slug already exists",
            traceId: request.id
          });
        }

        throw error;
      }
    }
  );

  app.get("/workspaces", async (request, reply) => {
    const user = requireAuth(request, reply);
    if (!user) {
      return;
    }

    const memberships = await prisma.workspaceMember.findMany({
      where: {
        userId: user.id
      },
      orderBy: {
        createdAt: "asc"
      },
      include: {
        workspace: true
      }
    });

    return reply.send({
      workspaces: memberships.map((member) => ({
        id: member.workspace.id,
        name: member.workspace.name,
        slug: member.workspace.slug,
        role: member.role,
        createdAt: member.workspace.createdAt,
        updatedAt: member.workspace.updatedAt
      }))
    });
  });
}
