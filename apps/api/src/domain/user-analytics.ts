import { prisma } from "../lib/prisma.js";

export type AnalyticsWindowKey = "24h" | "7d" | "14d" | "30d" | "365d";

export const ANALYTICS_WINDOW_DAYS: Record<AnalyticsWindowKey, number> = {
  "24h": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "365d": 365,
};

export function parseAnalyticsWindow(value: unknown): AnalyticsWindowKey {
  return value === "24h" || value === "7d" || value === "14d" || value === "30d" || value === "365d"
    ? value
    : "7d";
}

function since(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export type UserActivityHeatmapCell = {
  date: string;
  count: number;
};

export type UserActivityTarget = {
  label: string;
  count: number;
};

export type UserActivityDayHighlight = {
  date: string;
  topTargets: UserActivityTarget[];
};

export type UserActivityRecentEvent = {
  createdAt: string;
  eventType: string;
  target: string | null;
  pageId: string | null;
  durationMs: number | null;
};

export type UserActivitySummary = {
  window: AnalyticsWindowKey;
  generatedAt: string;
  isSynthetic: boolean;
  totalEvents: number;
  clickEvents: number;
  dwellMs: number;
  scrollDepthMax: number;
  scrollDepthAvg: number;
  attentionScore: number;
  uniquePages: number;
  heatmap: UserActivityHeatmapCell[];
  clickHeatmap: number[][];
  clickHeatmapTotal: number;
  topTargets: UserActivityTarget[];
  dayHighlights: UserActivityDayHighlight[];
  recentEvents: UserActivityRecentEvent[];
};

let analyticsColumnsCache: { checkedAt: number; ready: boolean } | null = null;
const ANALYTICS_COLUMNS_TTL_MS = 60_000;
const AUTO_SEED_DEMO_ANALYTICS =
  (process.env.AUTO_SEED_DEMO_ANALYTICS ?? "true") === "true";
const MIN_DEMO_HEATMAP_DAYS = 14;

function emptySummary(window: AnalyticsWindowKey): UserActivitySummary {
  return {
    window,
    generatedAt: new Date().toISOString(),
    isSynthetic: false,
    totalEvents: 0,
    clickEvents: 0,
    dwellMs: 0,
    scrollDepthMax: 0,
    scrollDepthAvg: 0,
    attentionScore: 0,
    uniquePages: 0,
    heatmap: [],
    clickHeatmap: Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0)),
    clickHeatmapTotal: 0,
    topTargets: [],
    dayHighlights: [],
    recentEvents: [],
  };
}

export function shouldRecordAnalyticsForUser(
  hasMeaningfulProductActivity: boolean,
  hasExplicitDemoActivity: boolean,
): boolean {
  return hasMeaningfulProductActivity || hasExplicitDemoActivity;
}

async function shouldShowAnalyticsForUser(userId: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ hasMeaningfulProductActivity: boolean; hasExplicitDemoActivity: boolean }[]>`
      SELECT
        (
          EXISTS (SELECT 1 FROM "Workspace" WHERE "ownerId" = ${userId}) OR
          EXISTS (SELECT 1 FROM "WorkspaceMember" WHERE "userId" = ${userId}) OR
          EXISTS (SELECT 1 FROM "Page" WHERE "creatorId" = ${userId})
        ) AS "hasMeaningfulProductActivity",
        EXISTS (
          SELECT 1
          FROM "ActivityEvent"
          WHERE "userId" = ${userId}
            AND "eventType" <> 'http'
            AND COALESCE("target", '') LIKE 'demo:%'
        ) AS "hasExplicitDemoActivity"
    `;

    const row = rows[0];
    return shouldRecordAnalyticsForUser(
      row?.hasMeaningfulProductActivity ?? false,
      row?.hasExplicitDemoActivity ?? false,
    );
  } catch (error) {
    console.error("[user-analytics] failed to evaluate analytics visibility", { userId, error });
    return false;
  }
}

function buildSyntheticSummary(
  userId: string,
  window: AnalyticsWindowKey,
): UserActivitySummary {
  const days = ANALYTICS_WINDOW_DAYS[window];
  const from = since(days);
  const fromDay = startOfDay(new Date(from.getTime() + 24 * 60 * 60 * 1000));
  const random = rand(hashSeed(`${userId}:${window}:synthetic`));

  const heatmap: UserActivityHeatmapCell[] = [];
  const clickHeatmap = Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => 0),
  );
  const topTargets = [
    { label: "demo:home:open_page", count: 0 },
    { label: "demo:editor:focus", count: 0 },
    { label: "demo:sidebar:new_page", count: 0 },
    { label: "demo:profile:open", count: 0 },
  ];

  const dayHighlights: UserActivityDayHighlight[] = [];
  const recentEvents: UserActivityRecentEvent[] = [];
  let totalEvents = 0;
  let clickEvents = 0;
  let dwellMs = 0;
  let uniquePages = 0;
  let scrollDepthMax = 0;
  let scrollDepthSum = 0;
  let scrollDepthCount = 0;

  for (let i = 0; i < days; i += 1) {
    const date = new Date(fromDay);
    date.setDate(date.getDate() + i);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const base = weekend ? 1 : 3;
    const intensity = base + Math.floor(random() * 5);
    const dayKey = date.toISOString().slice(0, 10);
    heatmap.push({ date: dayKey, count: intensity });
    dayHighlights.push({
      date: dayKey,
      topTargets: topTargets.slice(0, 3).map((item, index) => ({
        label: item.label,
        count: Math.max(1, intensity - index),
      })),
    });
    totalEvents += intensity;
  }

  const sampleDays = Math.min(14, days);
  for (let i = 0; i < sampleDays; i += 1) {
    const dayOffset = sampleDays - 1 - i;
    const baseTs = Date.now() - dayOffset * 24 * 60 * 60 * 1000;
    const clicks = 2 + Math.floor(random() * 6);
    const dwell = 20_000 + Math.floor(random() * 180_000);
    const scroll = 35 + Math.floor(random() * 65);
    const pageCount = 1 + Math.floor(random() * 3);

    clickEvents += clicks;
    dwellMs += dwell;
    uniquePages += pageCount;
    scrollDepthMax = Math.max(scrollDepthMax, scroll);
    scrollDepthSum += scroll;
    scrollDepthCount += 1;

    for (let c = 0; c < clicks; c += 1) {
      const x = Math.floor(random() * 5);
      const y = Math.floor(random() * 5);
      clickHeatmap[y]![x]! += 1;
      topTargets[c % topTargets.length]!.count += 1;
    }

    if (recentEvents.length < 16) {
      recentEvents.push({
        createdAt: new Date(baseTs + 9 * 60 * 1000).toISOString(),
        eventType: "ui_click",
        target: "demo:home:open_page",
        pageId: null,
        durationMs: null,
      });
      recentEvents.push({
        createdAt: new Date(baseTs + 19 * 60 * 1000).toISOString(),
        eventType: "surface_scroll",
        target: "demo:page",
        pageId: null,
        durationMs: null,
      });
      recentEvents.push({
        createdAt: new Date(baseTs + 24 * 60 * 1000).toISOString(),
        eventType: "surface_dwell",
        target: "demo:page",
        pageId: null,
        durationMs: dwell,
      });
    }
  }

  recentEvents.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const clickHeatmapTotal = clickHeatmap
    .flat()
    .reduce((sum, count) => sum + count, 0);
  const scrollDepthAvg =
    scrollDepthCount > 0 ? Math.round(scrollDepthSum / scrollDepthCount) : 0;
  const attentionScore = Math.round(
    Math.max(
      0,
      Math.min(
        (Math.min(dwellMs / (10 * 60 * 1000), 1) * 40) +
          (Math.min(clickEvents / 35, 1) * 25) +
          ((scrollDepthAvg / 100) * 20 + (scrollDepthMax / 100) * 10) +
          Math.min(uniquePages / 8, 1) * 5,
        100,
      ),
    ),
  );

  return {
    window,
    generatedAt: new Date().toISOString(),
    isSynthetic: true,
    totalEvents: Math.max(totalEvents, clickEvents + sampleDays * 2),
    clickEvents,
    dwellMs,
    scrollDepthMax,
    scrollDepthAvg,
    attentionScore,
    uniquePages,
    heatmap,
    clickHeatmap,
    clickHeatmapTotal,
    topTargets: topTargets.filter((item) => item.count > 0),
    dayHighlights,
    recentEvents: recentEvents.slice(0, 16),
  };
}

function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export type DemoActivitySeedResult = {
  seededDays: number;
  seededRecords: number;
  skipped: boolean;
};

export async function seedDemoActivityForUser(userId: string): Promise<DemoActivitySeedResult> {

  const [stats] = await prisma.$queryRaw<
    { total_events: bigint; real_events: bigint }[]
  >`
    SELECT
      COUNT(*)::bigint AS total_events,
      COUNT(*) FILTER (WHERE COALESCE("target", '') NOT LIKE 'demo:%')::bigint AS real_events
    FROM "ActivityEvent"
    WHERE "userId" = ${userId}
      AND "eventType" <> 'http'
  `;

  if (Number(stats?.real_events ?? 0n) > 0) {
    return { seededDays: 0, seededRecords: 0, skipped: true };
  }

  const seedFrom = since(MIN_DEMO_HEATMAP_DAYS);
  const seededRows = await prisma.$queryRaw<{ day: Date }[]>`
    SELECT date_trunc('day', "createdAt") AS day
    FROM "ActivityEvent"
    WHERE "userId" = ${userId}
      AND "eventType" <> 'http'
      AND "createdAt" >= ${seedFrom}
    GROUP BY 1
  `;
  const existingDays = new Set(
    seededRows.map((row) => startOfDay(row.day).toISOString().slice(0, 10)),
  );
  const missingDays: Date[] = [];
  for (let d = MIN_DEMO_HEATMAP_DAYS - 1; d >= 0; d -= 1) {
    const day = startOfDay(new Date(Date.now() - d * 24 * 60 * 60 * 1000));
    const key = day.toISOString().slice(0, 10);
    if (!existingDays.has(key)) {
      missingDays.push(day);
    }
  }

  if (missingDays.length === 0 && Number(stats?.total_events ?? 0n) > 0) {
    return { seededDays: 0, seededRecords: 0, skipped: true };
  }

  const random = rand(hashSeed(userId));
  const records: Array<{
    userId: string;
    eventType: string;
    method: string;
    path: string;
    target: string;
    pageId: string | null;
    x: number | null;
    y: number | null;
    statusCode: number;
    durationMs: number | null;
    createdAt: Date;
  }> = [];

  const daysToSeed = missingDays.length > 0 ? missingDays : [startOfDay(new Date())];
  for (const dayDate of daysToSeed) {
    const sessions = 1 + Math.floor(random() * 2);
    for (let s = 0; s < sessions; s += 1) {
      const sessionStart = new Date(dayDate.getTime() + Math.floor(random() * 12 * 60 * 60 * 1000));
      const surface = random() > 0.75 ? "demo:admin" : random() > 0.35 ? "demo:home" : "demo:page";
      const dwellMs = 15_000 + Math.floor(random() * 210_000);
      const scrollPct = 35 + Math.floor(random() * 66);
      records.push({
        userId,
        eventType: "surface_view",
        method: "CLIENT",
        path: "/analytics/events",
        target: surface,
        pageId: null,
        x: null,
        y: null,
        statusCode: 200,
        durationMs: null,
        createdAt: sessionStart,
      });
      records.push({
        userId,
        eventType: "surface_dwell",
        method: "CLIENT",
        path: "/analytics/events",
        target: surface,
        pageId: null,
        x: null,
        y: null,
        statusCode: 200,
        durationMs: dwellMs,
        createdAt: new Date(sessionStart.getTime() + 30_000),
      });
      records.push({
        userId,
        eventType: "surface_scroll",
        method: "CLIENT",
        path: "/analytics/events",
        target: surface,
        pageId: null,
        x: null,
        y: scrollPct,
        statusCode: 200,
        durationMs: null,
        createdAt: new Date(sessionStart.getTime() + 45_000),
      });

      const clicks = 3 + Math.floor(random() * 8);
      for (let i = 0; i < clicks; i += 1) {
        const slot = i % 4;
        const target =
          slot === 0
            ? "demo:sidebar:open"
            : slot === 1
              ? "demo:home:open_page"
              : slot === 2
                ? "demo:editor:focus"
                : "demo:profile:toggle";
        records.push({
          userId,
          eventType: "ui_click",
          method: "CLIENT",
          path: "/analytics/events",
          target,
          pageId: null,
          x: 20 + Math.floor(random() * 1100),
          y: 30 + Math.floor(random() * 700),
          statusCode: 200,
          durationMs: null,
          createdAt: new Date(sessionStart.getTime() + 60_000 + i * 12_000),
        });
      }
    }
  }

  await prisma.activityEvent.createMany({ data: records });

  return { seededDays: daysToSeed.length, seededRecords: records.length, skipped: false };
}

async function hasAnalyticsColumns(): Promise<boolean> {
  if (analyticsColumnsCache && Date.now() - analyticsColumnsCache.checkedAt < ANALYTICS_COLUMNS_TTL_MS) {
    return analyticsColumnsCache.ready;
  }

  const rows = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ActivityEvent'
      AND column_name IN ('eventType', 'target', 'pageId', 'x', 'y')
  `;
  const found = new Set(rows.map((r) => r.column_name));
  const ready =
    found.has("eventType") &&
    found.has("target") &&
    found.has("pageId") &&
    found.has("x") &&
    found.has("y");

  analyticsColumnsCache = { checkedAt: Date.now(), ready };
  return ready;
}

export async function getUserActivitySummary(
  userId: string,
  window: AnalyticsWindowKey,
): Promise<UserActivitySummary> {
  try {
    if (!(await shouldShowAnalyticsForUser(userId))) {
      return emptySummary(window);
    }

    if (!(await hasAnalyticsColumns())) {
      return buildSyntheticSummary(userId, window);
    }

    const days = ANALYTICS_WINDOW_DAYS[window];
    const from = since(days);
    const fromDay = startOfDay(new Date(from.getTime() + 24 * 60 * 60 * 1000));

    const [totals, targetRows, heatmapRows, dayTargetRows, clickRows, scrollRows, recentRows] = await Promise.all([
      prisma.$queryRaw<{ total_events: bigint; click_events: bigint; dwell_ms: bigint; unique_pages: bigint; real_events: bigint }[]>`
        SELECT
          COUNT(*)::bigint AS total_events,
          COUNT(*) FILTER (WHERE "eventType" = 'ui_click')::bigint AS click_events,
          COALESCE(SUM("durationMs") FILTER (WHERE "eventType" = 'surface_dwell'), 0)::bigint AS dwell_ms,
          COUNT(DISTINCT "pageId") FILTER (WHERE "pageId" IS NOT NULL)::bigint AS unique_pages,
          COUNT(*) FILTER (WHERE COALESCE("target", '') NOT LIKE 'demo:%')::bigint AS real_events
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${from}
          AND "eventType" <> 'http'
      `,
      prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
        SELECT COALESCE("target", "eventType") AS label, COUNT(*)::bigint AS count
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${from}
          AND "eventType" = 'ui_click'
        GROUP BY COALESCE("target", "eventType")
        ORDER BY COUNT(*) DESC
        LIMIT 8
      `,
      prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${fromDay}
          AND "eventType" <> 'http'
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prisma.$queryRaw<{ day: Date; label: string | null; count: bigint }[]>`
        SELECT
          date_trunc('day', "createdAt") AS day,
          COALESCE("target", "eventType") AS label,
          COUNT(*)::bigint AS count
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${fromDay}
          AND "eventType" <> 'http'
        GROUP BY 1, 2
        ORDER BY 1 ASC, COUNT(*) DESC
      `,
      prisma.$queryRaw<{ x: number | null; y: number | null }[]>`
        SELECT "x", "y"
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${from}
          AND "eventType" = 'ui_click'
          AND "x" IS NOT NULL
          AND "y" IS NOT NULL
        ORDER BY "createdAt" DESC
        LIMIT 1000
      `,
      prisma.$queryRaw<{ y: number | null }[]>`
        SELECT "y"
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${from}
          AND "eventType" = 'surface_scroll'
          AND "y" IS NOT NULL
        ORDER BY "createdAt" DESC
        LIMIT 1000
      `,
      prisma.$queryRaw<{ createdAt: Date; eventType: string; target: string | null; pageId: string | null; durationMs: number | null }[]>`
        SELECT "createdAt", "eventType", "target", "pageId", "durationMs"
        FROM "ActivityEvent"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${from}
          AND "eventType" <> 'http'
        ORDER BY "createdAt" DESC
        LIMIT 16
      `,
    ]);

    const countsByDay = new Map(
      heatmapRows.map((row) => [startOfDay(row.day).toISOString().slice(0, 10), Number(row.count)]),
    );
    const dayTargetsByDay = new Map<string, UserActivityTarget[]>();
    for (const row of dayTargetRows) {
      const key = startOfDay(row.day).toISOString().slice(0, 10);
      const targets = dayTargetsByDay.get(key) ?? [];
      if (targets.length < 3) {
        targets.push({ label: row.label ?? "Unknown", count: Number(row.count) });
        dayTargetsByDay.set(key, targets);
      }
    }
    const heatmap: UserActivityHeatmapCell[] = [];
    const dayHighlights: UserActivityDayHighlight[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = new Date(fromDay);
      date.setDate(date.getDate() + i);
      const key = date.toISOString().slice(0, 10);
      heatmap.push({ date: key, count: countsByDay.get(key) ?? 0 });
      dayHighlights.push({ date: key, topTargets: dayTargetsByDay.get(key) ?? [] });
    }

    const gridSize = 5;
    const clickHeatmap = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => 0));
    const xs = clickRows.map((row) => row.x).filter((value): value is number => typeof value === "number");
    const ys = clickRows.map((row) => row.y).filter((value): value is number => typeof value === "number");
    const minX = xs.length > 0 ? Math.min(...xs) : 0;
    const maxX = xs.length > 0 ? Math.max(...xs) : 1;
    const minY = ys.length > 0 ? Math.min(...ys) : 0;
    const maxY = ys.length > 0 ? Math.max(...ys) : 1;
    const rangeX = Math.max(maxX - minX, 1);
    const rangeY = Math.max(maxY - minY, 1);
    let clickHeatmapTotal = 0;
    for (const row of clickRows) {
      if (row.x == null || row.y == null) continue;
      const xBucket = Math.min(gridSize - 1, Math.max(0, Math.floor(((row.x - minX) / rangeX) * gridSize)));
      const yBucket = Math.min(gridSize - 1, Math.max(0, Math.floor(((row.y - minY) / rangeY) * gridSize)));
      clickHeatmap[yBucket]![xBucket]! += 1;
      clickHeatmapTotal += 1;
    }

    const scrollDepthValues = scrollRows
      .map((row) => row.y)
      .filter((value): value is number => typeof value === "number");
    const scrollDepthMax = scrollDepthValues.length > 0 ? Math.max(...scrollDepthValues) : 0;
    const scrollDepthAvg =
      scrollDepthValues.length > 0
        ? Math.round(scrollDepthValues.reduce((sum, value) => sum + value, 0) / scrollDepthValues.length)
        : 0;
    const isSynthetic = Number(totals[0]?.total_events ?? 0n) > 0 && Number(totals[0]?.real_events ?? 0n) === 0;
    const dwellScore = Math.min((Number(totals[0]?.dwell_ms ?? 0n) / (15 * 60 * 1000)) * 40, 40);
    const clickScore = Math.min((Number(totals[0]?.click_events ?? 0n) / 30) * 25, 25);
    const scrollScore = Math.min((scrollDepthAvg / 100) * 20 + (scrollDepthMax / 100) * 10, 35);
    const pageScore = Math.min(Number(totals[0]?.unique_pages ?? 0n) * 5, 10);
    const attentionScore = Math.round(Math.max(0, Math.min(dwellScore + clickScore + scrollScore + pageScore, 100)));

    const result = {
      window,
      generatedAt: new Date().toISOString(),
      isSynthetic,
      totalEvents: Number(totals[0]?.total_events ?? 0n),
      clickEvents: Number(totals[0]?.click_events ?? 0n),
      dwellMs: Number(totals[0]?.dwell_ms ?? 0n),
      scrollDepthMax,
      scrollDepthAvg,
      attentionScore,
      uniquePages: Number(totals[0]?.unique_pages ?? 0n),
      heatmap,
      clickHeatmap,
      clickHeatmapTotal,
      topTargets: targetRows
        .map((row) => ({ label: row.label ?? "Unknown", count: Number(row.count) }))
        .filter((row) => row.count > 0),
      dayHighlights,
      recentEvents: recentRows.map((row) => ({
        createdAt: row.createdAt.toISOString(),
        eventType: row.eventType,
        target: row.target,
        pageId: row.pageId,
        durationMs: row.durationMs,
      })),
    };

    if (result.totalEvents === 0) {
      return emptySummary(window);
    }

    return result;
  } catch (error) {
    console.error("[user-analytics] failed to build activity summary", { userId, window, error });
    return emptySummary(window);
  }
}