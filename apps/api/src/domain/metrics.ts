import { prisma } from "../lib/prisma.js";
import { APP_ROLE_ADMIN } from "./app-roles.js";

// Metrics for the CoMa monitoring dashboard. All reads go through a tiny TTL
// cache so the dashboard's ~3s polling (and multiple admins) can't turn into a
// steady stream of identical aggregate queries against the DB.

export type WindowKey = "6h" | "12h" | "24h";
export const WINDOW_HOURS: Record<WindowKey, number> = {
  "6h": 6,
  "12h": 12,
  "24h": 24,
};

export function parseWindow(value: unknown): WindowKey {
  return value === "6h" || value === "12h" || value === "24h" ? value : "24h";
}

const CACHE_TTL_MS = 2_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function since(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** COUNT(DISTINCT userId) of activity in the given window — cheap, index-backed. */
async function distinctActiveUsers(from: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT "userId")::bigint AS count
    FROM "ActivityEvent"
    WHERE "createdAt" >= ${from} AND "userId" IS NOT NULL
  `;
  return Number(rows[0]?.count ?? 0n);
}

export type OverviewMetrics = {
  totalUsers: number;
  adminUsers: number;
  normalUsers: number;
  activeUsers24h: number;
  inactiveUsers: number;
  totalWorkspaces: number;
  totalPages: number;
  totalStorageBytes: number;
  generatedAt: string;
};

export async function getOverviewMetrics(): Promise<OverviewMetrics> {
  return cached("overview", async () => {
    const [totalUsers, adminUsers, active24h, totalWorkspaces, totalPages, storage] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { appRole: { key: APP_ROLE_ADMIN } } }),
        distinctActiveUsers(since(24)),
        prisma.workspace.count(),
        prisma.page.count({ where: { deletedAt: null } }),
        prisma.pageAttachment.aggregate({ _sum: { size: true } }),
      ]);

    return {
      totalUsers,
      adminUsers,
      normalUsers: totalUsers - adminUsers,
      activeUsers24h: active24h,
      inactiveUsers: Math.max(totalUsers - active24h, 0),
      totalWorkspaces,
      totalPages,
      totalStorageBytes: storage._sum.size ?? 0,
      generatedAt: new Date().toISOString(),
    };
  });
}

export type ActivityMetrics = {
  window: WindowKey;
  activeUsers: number;
  apiCalls: number;
  newUsers: number;
  generatedAt: string;
};

export async function getActivityMetrics(
  window: WindowKey,
): Promise<ActivityMetrics> {
  return cached(`activity:${window}`, async () => {
    const from = since(WINDOW_HOURS[window]);
    const [activeUsers, apiCalls, newUsers] = await Promise.all([
      distinctActiveUsers(from),
      prisma.activityEvent.count({
        where: { createdAt: { gte: from }, eventType: "http" },
      }),
      prisma.user.count({ where: { createdAt: { gte: from } } }),
    ]);
    return {
      window,
      activeUsers,
      apiCalls,
      newUsers,
      generatedAt: new Date().toISOString(),
    };
  });
}
