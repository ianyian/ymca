export type FlatPage = {
  id: string;
  parentPageId: string | null;
  title: string;
  icon: string | null;
  version: number;
  deletedAt: Date | null;
};

export type PageNode = FlatPage & {
  children: PageNode[];
};

/**
 * Build a nested page tree from a flat list of non-deleted pages.
 * Siblings preserve input order (the caller sorts by createdAt ascending).
 *
 * Orphaned pages (parentPageId references a deleted or missing page) are
 * promoted to the top level.
 */
export function buildPageTree(pages: FlatPage[]): PageNode[] {
  const live = pages.filter((p) => p.deletedAt === null);

  const liveIds = new Set(live.map((p) => p.id));

  const nodeMap = new Map<string, PageNode>();
  for (const p of live) {
    nodeMap.set(p.id, { ...p, children: [] });
  }

  const roots: PageNode[] = [];

  for (const p of live) {
    const node = nodeMap.get(p.id)!;
    const parentId = p.parentPageId;

    if (parentId !== null && liveIds.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
