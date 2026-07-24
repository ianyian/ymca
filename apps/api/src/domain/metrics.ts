import { prisma } from "../lib/prisma.js";
import { APP_ROLE_ADMIN } from "./app-roles.js";
import { ANALYTICS_WINDOW_DAYS, type AnalyticsWindowKey } from "./user-analytics.js";

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
    try {
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
    } catch {
      return {
        totalUsers: 0,
        adminUsers: 0,
        normalUsers: 0,
        activeUsers24h: 0,
        inactiveUsers: 0,
        totalWorkspaces: 0,
        totalPages: 0,
        totalStorageBytes: 0,
        generatedAt: new Date().toISOString(),
      };
    }
  });
}

export type ActivityMetrics = {
  window: WindowKey;
  activeUsers: number;
  apiCalls: number;
  newUsers: number;
  generatedAt: string;
};

// ── Cross-user click heatmap (admin "all users" view) ───────────────────────
// Aggregates every user's click coordinates into a fixed grid so it's meaningful
// across different screen sizes. Bucketing happens in SQL against the
// eventType+createdAt index, so it stays cheap as the table grows.
const CLICK_COLS = 12;
const CLICK_ROWS = 8;
const REF_W = 1440;
const REF_H = 900;

export type AllUsersHeatmap = {
  window: AnalyticsWindowKey;
  generatedAt: string;
  activeUsers: number;
  totalClicks: number;
  gridCols: number;
  gridRows: number;
  clickHeatmap: number[][];
  clickHeatmapMax: number;
  topTargets: { label: string; count: number }[];
};

function emptyHeatmap(window: AnalyticsWindowKey): AllUsersHeatmap {
  return {
    window,
    generatedAt: new Date().toISOString(),
    activeUsers: 0,
    totalClicks: 0,
    gridCols: CLICK_COLS,
    gridRows: CLICK_ROWS,
    clickHeatmap: Array.from({ length: CLICK_ROWS }, () =>
      Array.from({ length: CLICK_COLS }, () => 0),
    ),
    clickHeatmapMax: 0,
    topTargets: [],
  };
}

export async function getAllUsersHeatmap(
  window: AnalyticsWindowKey,
): Promise<AllUsersHeatmap> {
  return cached(`all-heatmap:${window}`, async () => {
    try {
      const from = since(ANALYTICS_WINDOW_DAYS[window] * 24);
      const colDiv = REF_W / CLICK_COLS;
      const rowDiv = REF_H / CLICK_ROWS;

      const [gridRows, targetRows, meta] = await Promise.all([
        prisma.$queryRaw<{ gx: number; gy: number; c: bigint }[]>`
          SELECT
            LEAST(${CLICK_COLS - 1}, GREATEST(0, floor("x" / ${colDiv})::int)) AS gx,
            LEAST(${CLICK_ROWS - 1}, GREATEST(0, floor("y" / ${rowDiv})::int)) AS gy,
            COUNT(*)::bigint AS c
          FROM "ActivityEvent"
          WHERE "eventType" = 'ui_click' AND "createdAt" >= ${from}
            AND "x" IS NOT NULL AND "y" IS NOT NULL
          GROUP BY 1, 2
        `,
        prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
          SELECT COALESCE("target", "eventType") AS label, COUNT(*)::bigint AS count
          FROM "ActivityEvent"
          WHERE "eventType" = 'ui_click' AND "createdAt" >= ${from}
          GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 12
        `,
        prisma.$queryRaw<{ active_users: bigint; total_clicks: bigint }[]>`
          SELECT COUNT(DISTINCT "userId")::bigint AS active_users,
                 COUNT(*)::bigint AS total_clicks
          FROM "ActivityEvent"
          WHERE "eventType" = 'ui_click' AND "createdAt" >= ${from}
        `,
      ]);

      const grid = Array.from({ length: CLICK_ROWS }, () =>
        Array.from({ length: CLICK_COLS }, () => 0),
      );
      let max = 0;
      for (const r of gridRows) {
        const gy = Math.min(CLICK_ROWS - 1, Math.max(0, Number(r.gy)));
        const gx = Math.min(CLICK_COLS - 1, Math.max(0, Number(r.gx)));
        const c = Number(r.c);
        grid[gy]![gx] = c;
        if (c > max) max = c;
      }

      return {
        window,
        generatedAt: new Date().toISOString(),
        activeUsers: Number(meta[0]?.active_users ?? 0n),
        totalClicks: Number(meta[0]?.total_clicks ?? 0n),
        gridCols: CLICK_COLS,
        gridRows: CLICK_ROWS,
        clickHeatmap: grid,
        clickHeatmapMax: max,
        topTargets: targetRows
          .map((r) => ({ label: r.label ?? "Unknown", count: Number(r.count) }))
          .filter((r) => r.count > 0),
      };
    } catch (error) {
      console.error("[metrics] all-users heatmap failed", error);
      return emptyHeatmap(window);
    }
  });
}

export async function getActivityMetrics(
  window: WindowKey,
): Promise<ActivityMetrics> {
  return cached(`activity:${window}`, async () => {
    try {
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
    } catch {
      return {
        window,
        activeUsers: 0,
        apiCalls: 0,
        newUsers: 0,
        generatedAt: new Date().toISOString(),
      };
    }
  });
}
