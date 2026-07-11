import type { Prisma } from "@prisma/client";

export function hasVersionConflict(currentVersion: number, expectedVersion: number): boolean {
  return currentVersion !== expectedVersion;
}

export function getNextVersion(currentVersion: number): number {
  return currentVersion + 1;
}

/** Max content snapshots retained per page. Older revisions are pruned. */
export const MAX_REVISIONS_PER_PAGE = 50;

/**
 * Delete revisions beyond the most recent MAX_REVISIONS_PER_PAGE for a page.
 * Keeps history bounded so full-snapshot revisions don't grow without limit.
 */
export async function pruneRevisions(
  tx: Prisma.TransactionClient,
  pageId: string,
): Promise<void> {
  const keep = await tx.pageRevision.findMany({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    take: MAX_REVISIONS_PER_PAGE,
    select: { id: true },
  });
  await tx.pageRevision.deleteMany({
    where: { pageId, id: { notIn: keep.map((r) => r.id) } },
  });
}
