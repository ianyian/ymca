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

// ── Usage analytics (admin "Analysis" dashboard) ────────────────────────────
// Aggregates the ActivityEvent log into behavioural views: a daily usage trend,
// the top users (with per-day breakdown for a composite chart), when usage
// happens (hour-of-day + day-of-week, for capacity planning), and what users
// focus on (top interaction targets). All queries are index-backed on createdAt.

export type UsageWindowKey = "7d" | "30d" | "90d";
const USAGE_WINDOW_DAYS: Record<UsageWindowKey, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function parseUsageWindow(value: unknown): UsageWindowKey {
  return value === "30d" || value === "90d" ? value : "7d";
}

export type UsageAnalytics = {
  window: UsageWindowKey;
  generatedAt: string;
  totalEvents: number;
  activeUsers: number;
  avgEventsPerUser: number;
  days: string[];
  daily: { date: string; events: number; users: number }[];
  topUsers: { userId: string; label: string; total: number; daily: number[] }[];
  hourly: number[];
  weekday: number[];
  topTargets: { label: string; count: number }[];
};

function emptyUsage(window: UsageWindowKey): UsageAnalytics {
  return {
    window,
    generatedAt: new Date().toISOString(),
    totalEvents: 0,
    activeUsers: 0,
    avgEventsPerUser: 0,
    days: [],
    daily: [],
    topUsers: [],
    hourly: Array.from({ length: 24 }, () => 0),
    weekday: Array.from({ length: 7 }, () => 0),
    topTargets: [],
  };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getUsageAnalytics(
  window: UsageWindowKey,
): Promise<UsageAnalytics> {
  return cached(`usage:${window}`, async () => {
    try {
      const days = USAGE_WINDOW_DAYS[window];
      const from = since(days * 24);

      // Build the inclusive day axis (UTC) so charts have a stable, gap-free x.
      const startDay = new Date(from);
      startDay.setUTCHours(0, 0, 0, 0);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const dayAxis: string[] = [];
      for (
        let d = new Date(startDay);
        d <= today;
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        dayAxis.push(dayKey(d));
      }
      const dayIndex = new Map(dayAxis.map((k, i) => [k, i]));

      const [totals, dailyRows, topUserRows, hourRows, dowRows, targetRows] =
        await Promise.all([
          prisma.$queryRaw<{ total: bigint; users: bigint }[]>`
            SELECT COUNT(*)::bigint AS total,
                   COUNT(DISTINCT "userId")::bigint AS users
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from} AND "userId" IS NOT NULL
          `,
          prisma.$queryRaw<{ day: Date; events: bigint; users: bigint }[]>`
            SELECT date_trunc('day', "createdAt") AS day,
                   COUNT(*)::bigint AS events,
                   COUNT(DISTINCT "userId")::bigint AS users
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from} AND "userId" IS NOT NULL
            GROUP BY 1 ORDER BY 1
          `,
          prisma.$queryRaw<{ userId: string; total: bigint }[]>`
            SELECT "userId", COUNT(*)::bigint AS total
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from} AND "userId" IS NOT NULL
            GROUP BY "userId" ORDER BY COUNT(*) DESC LIMIT 5
          `,
          prisma.$queryRaw<{ h: number; c: bigint }[]>`
            SELECT EXTRACT(HOUR FROM "createdAt")::int AS h, COUNT(*)::bigint AS c
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from}
            GROUP BY 1
          `,
          prisma.$queryRaw<{ w: number; c: bigint }[]>`
            SELECT EXTRACT(DOW FROM "createdAt")::int AS w, COUNT(*)::bigint AS c
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from}
            GROUP BY 1
          `,
          prisma.$queryRaw<{ label: string | null; c: bigint }[]>`
            SELECT COALESCE(NULLIF("target", ''), "path") AS label, COUNT(*)::bigint AS c
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from}
            GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 10
          `,
        ]);

      const daily = dayAxis.map((date) => ({ date, events: 0, users: 0 }));
      for (const row of dailyRows) {
        const key = dayKey(new Date(row.day));
        const i = dayIndex.get(key);
        if (i != null) {
          daily[i]!.events = Number(row.events);
          daily[i]!.users = Number(row.users);
        }
      }

      // Per-day breakdown for the top users (composite chart).
      const topIds = topUserRows.map((r) => r.userId);
      let topUsers: UsageAnalytics["topUsers"] = [];
      if (topIds.length > 0) {
        const [perUserDaily, users] = await Promise.all([
          prisma.$queryRaw<{ userId: string; day: Date; c: bigint }[]>`
            SELECT "userId", date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS c
            FROM "ActivityEvent"
            WHERE "createdAt" >= ${from} AND "userId" = ANY(${topIds}::uuid[])
            GROUP BY 1, 2
          `,
          prisma.user.findMany({
            where: { id: { in: topIds } },
            select: { id: true, email: true, displayName: true },
          }),
        ]);
        const labelById = new Map(
          users.map((u) => [u.id, u.displayName || u.email.split("@")[0] || "User"]),
        );
        const seriesById = new Map(
          topIds.map((id) => [id, Array.from({ length: dayAxis.length }, () => 0)]),
        );
        for (const row of perUserDaily) {
          const arr = seriesById.get(row.userId);
          const i = dayIndex.get(dayKey(new Date(row.day)));
          if (arr && i != null) arr[i] = Number(row.c);
        }
        topUsers = topUserRows.map((r) => ({
          userId: r.userId,
          label: labelById.get(r.userId) ?? "User",
          total: Number(r.total),
          daily: seriesById.get(r.userId) ?? [],
        }));
      }

      const hourly = Array.from({ length: 24 }, () => 0);
      for (const row of hourRows) {
        const h = Number(row.h);
        if (h >= 0 && h < 24) hourly[h] = Number(row.c);
      }
      const weekday = Array.from({ length: 7 }, () => 0);
      for (const row of dowRows) {
        const w = Number(row.w);
        if (w >= 0 && w < 7) weekday[w] = Number(row.c);
      }

      const totalEvents = Number(totals[0]?.total ?? 0n);
      const activeUsers = Number(totals[0]?.users ?? 0n);

      return {
        window,
        generatedAt: new Date().toISOString(),
        totalEvents,
        activeUsers,
        avgEventsPerUser: activeUsers > 0 ? Math.round(totalEvents / activeUsers) : 0,
        days: dayAxis,
        daily,
        topUsers,
        hourly,
        weekday,
        topTargets: targetRows
          .map((r) => ({ label: r.label ?? "Unknown", count: Number(r.c) }))
          .filter((r) => r.count > 0),
      };
    } catch (error) {
      console.error("[metrics] usage analytics failed", error);
      return emptyUsage(window);
    }
  });
}

// ── Recent errors (admin troubleshooting log) ───────────────────────────────
// Every request is already logged into ActivityEvent (path/method/status/user/
// time), so we can surface a "recent errors" view without a separate table. We
// treat 4xx/5xx as errors, skipping the noisy-but-normal 401 (auth prompts) and
// 429 (rate limit) statuses.
export type RecentErrorItem = {
  at: string;
  statusCode: number;
  method: string;
  path: string;
  user: string | null;
};
export type RecentErrors = {
  window: UsageWindowKey;
  generatedAt: string;
  total: number;
  byStatus: { status: number; count: number }[];
  items: RecentErrorItem[];
};

export async function getRecentErrors(
  window: UsageWindowKey,
): Promise<RecentErrors> {
  return cached(`errors:${window}`, async () => {
    try {
      const from = since(USAGE_WINDOW_DAYS[window] * 24);
      const [rows, statusRows] = await Promise.all([
        prisma.$queryRaw<
          { createdAt: Date; statusCode: number; method: string; path: string; userId: string | null }[]
        >`
          SELECT "createdAt", "statusCode", "method", "path", "userId"
          FROM "ActivityEvent"
          WHERE "eventType" = 'http' AND "statusCode" >= 400
            AND "statusCode" NOT IN (401, 429)
            AND "createdAt" >= ${from}
          ORDER BY "createdAt" DESC
          LIMIT 100
        `,
        prisma.$queryRaw<{ status: number; count: bigint }[]>`
          SELECT "statusCode" AS status, COUNT(*)::bigint AS count
          FROM "ActivityEvent"
          WHERE "eventType" = 'http' AND "statusCode" >= 400
            AND "statusCode" NOT IN (401, 429)
            AND "createdAt" >= ${from}
          GROUP BY 1 ORDER BY 2 DESC
        `,
      ]);

      // Resolve user ids to emails for readability.
      const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
      const users = userIds.length
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
        : [];
      const emailById = new Map(users.map((u) => [u.id, u.email]));

      const byStatus = statusRows.map((r) => ({ status: Number(r.status), count: Number(r.count) }));
      return {
        window,
        generatedAt: new Date().toISOString(),
        total: byStatus.reduce((sum, s) => sum + s.count, 0),
        byStatus,
        items: rows.map((r) => ({
          at: r.createdAt.toISOString(),
          statusCode: r.statusCode,
          method: r.method,
          path: r.path,
          user: r.userId ? emailById.get(r.userId) ?? null : null,
        })),
      };
    } catch (error) {
      console.error("[metrics] recent errors failed", error);
      return { window, generatedAt: new Date().toISOString(), total: 0, byStatus: [], items: [] };
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
