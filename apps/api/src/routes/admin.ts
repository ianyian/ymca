import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../auth/require-admin.js";
import { APP_ROLE_ADMIN } from "../domain/app-roles.js";
import {
  getActivityMetrics,
  getAllUsersHeatmap,
  getOverviewMetrics,
  parseWindow,
} from "../domain/metrics.js";
import {
  getUserActivitySummary,
  parseAnalyticsWindow,
} from "../domain/user-analytics.js";

const setRoleBodySchema = {
  type: "object",
  properties: {
    appRoleKey: { type: "string", minLength: 1, maxLength: 32 },
  },
  required: ["appRoleKey"],
  additionalProperties: false,
} as const;

const MAX_PAGE_SIZE = 100;

export async function registerAdminRoutes(app: FastifyInstance) {
  // ── Assignable roles (for the User Management dropdown) ──────────────────
  app.get("/admin/roles", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const roles = await prisma.appRole.findMany({
      where: { isAssignable: true },
      orderBy: { rank: "desc" },
      select: { id: true, key: true, label: true, description: true, rank: true },
    });
    return reply.send({ roles });
  });

  // ── Paginated user list ─────────────────────────────────────────────────
  app.get("/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const query = request.query as {
      search?: string;
      page?: string;
      pageSize?: string;
    };
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number.parseInt(query.pageSize ?? "25", 10) || 25),
    );
    const search = (query.search ?? "").trim();

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { displayName: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
          appRole: { select: { key: true, label: true } },
          _count: { select: { pagesCreated: true } },
        },
      }),
    ]);

    // Last-seen for just this page of users (bounded, index-backed).
    const userIds = users.map((u) => u.id);
    const lastSeen = userIds.length
      ? await prisma.session.groupBy({
          by: ["userId"],
          where: { userId: { in: userIds } },
          _max: { lastSeenAt: true },
        })
      : [];
    const lastSeenById = new Map(
      lastSeen.map((row) => [row.userId, row._max.lastSeenAt]),
    );

    return reply.send({
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        createdAt: u.createdAt,
        roleKey: u.appRole.key,
        roleLabel: u.appRole.label,
        pageCount: u._count.pagesCreated,
        lastSeenAt: lastSeenById.get(u.id) ?? null,
      })),
    });
  });

  // ── Change a user's global role ─────────────────────────────────────────
  app.patch(
    "/admin/users/:id/role",
    { schema: { body: setRoleBodySchema } },
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;

      const { id } = request.params as { id: string };
      const { appRoleKey } = request.body as { appRoleKey: string };

      const role = await prisma.appRole.findUnique({
        where: { key: appRoleKey },
      });
      if (!role || !role.isAssignable) {
        return reply.status(400).send({
          code: "INVALID_ROLE",
          message: "Unknown or non-assignable role",
          traceId: request.id,
        });
      }

      const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, appRole: { select: { key: true } } },
      });
      if (!target) {
        return reply.status(404).send({
          code: "USER_NOT_FOUND",
          message: "User not found",
          traceId: request.id,
        });
      }

      // Safety: never allow demoting the last remaining admin, which would lock
      // everyone out of the Configuration Manager.
      const demotingAdmin =
        target.appRole.key === APP_ROLE_ADMIN && role.key !== APP_ROLE_ADMIN;
      if (demotingAdmin) {
        const adminCount = await prisma.user.count({
          where: { appRole: { key: APP_ROLE_ADMIN } },
        });
        if (adminCount <= 1) {
          return reply.status(409).send({
            code: "LAST_ADMIN",
            message: "Cannot remove the last administrator",
            traceId: request.id,
          });
        }
      }

      const updated = await prisma.user.update({
        where: { id },
        data: { appRoleId: role.id },
        select: {
          id: true,
          email: true,
          displayName: true,
          appRole: { select: { key: true, label: true } },
        },
      });

      return reply.send({
        user: {
          id: updated.id,
          email: updated.email,
          displayName: updated.displayName,
          roleKey: updated.appRole.key,
          roleLabel: updated.appRole.label,
        },
      });
    },
  );

  // ── Monitoring metrics ──────────────────────────────────────────────────
  app.get("/admin/metrics/overview", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return reply.send(await getOverviewMetrics());
  });

  app.get("/admin/metrics/activity", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const window = parseWindow((request.query as { window?: string }).window);
    return reply.send(await getActivityMetrics(window));
  });

  // Cross-user click heatmap (admin "all users" view).
  app.get("/admin/analytics/heatmap", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const window = parseAnalyticsWindow(
      (request.query as { window?: string }).window,
    );
    return reply.send(await getAllUsersHeatmap(window));
  });

  app.get("/admin/users/:id/activity", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) {
      return reply.status(404).send({
        code: "USER_NOT_FOUND",
        message: "User not found",
        traceId: request.id,
      });
    }
    const window = parseAnalyticsWindow((request.query as { window?: string }).window);
    return reply.send(await getUserActivitySummary(id, window));
  });
}
