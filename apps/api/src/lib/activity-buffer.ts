import { prisma } from "./prisma.js";

// Batched, in-memory activity log. Instead of one INSERT per HTTP request (which
// would add heavy write amplification at thousands of users), events are buffered
// in-process and flushed with a single `createMany` on an interval or when the
// buffer fills. This trades a few seconds of durability (a crash loses the current
// buffer — acceptable for monitoring analytics) for far lower DB load.

export type ActivityRecord = {
  userId: string | null;
  eventType?: string;
  method: string;
  path: string;
  target?: string | null;
  pageId?: string | null;
  x?: number | null;
  y?: number | null;
  statusCode: number;
  durationMs: number | null;
  createdAt: Date;
};

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER = 500;

let buffer: ActivityRecord[] = [];
let timer: NodeJS.Timeout | null = null;

export async function flushActivityBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await prisma.activityEvent.createMany({
      data: batch.map((record) => ({
        ...record,
        eventType: record.eventType ?? "http",
        target: record.target ?? null,
        pageId: record.pageId ?? null,
        x: record.x ?? null,
        y: record.y ?? null,
      })),
    });
  } catch (err) {
    // Never let analytics logging break the app; drop the batch and move on.
    // (Re-queueing risks unbounded growth if the DB is down.)
    console.error("[activity-buffer] flush failed, dropping batch", err);
  }
}

export function recordActivity(record: ActivityRecord): void {
  buffer.push(record);
  if (buffer.length >= MAX_BUFFER) {
    void flushActivityBuffer();
  }
}

export function startActivityBuffer(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushActivityBuffer();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the process alive just for the flush timer.
  timer.unref?.();
}

export async function stopActivityBuffer(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flushActivityBuffer();
}

// ── Retention ───────────────────────────────────────────────────────────────
// Keep raw activity for 6 months (experimental phase — we want to trace real
// activity), then prune. A single daily deleteMany is plenty at this scale and
// avoids the table growing unbounded from per-request HTTP logging.
const RETENTION_DAYS = 180;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
let retentionTimer: NodeJS.Timeout | null = null;

export async function pruneOldActivity(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.activityEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      console.log(
        `[activity-retention] pruned ${count} events older than ${RETENTION_DAYS} days`,
      );
    }
  } catch (err) {
    // Never let retention break the app; just log and retry next interval.
    console.error("[activity-retention] prune failed", err);
  }
}

export function startActivityRetention(): void {
  if (retentionTimer) return;
  void pruneOldActivity(); // run once shortly after boot
  retentionTimer = setInterval(() => {
    void pruneOldActivity();
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

export function stopActivityRetention(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
