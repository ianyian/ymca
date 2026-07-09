export type FlatPage = {
  id: string;
  parentPageId: string | null;
  title: string;
  icon: string | null;
  position: string | null; // Decimal serialized as string
  version: number;
  deletedAt: Date | null;
};

export type PageNode = FlatPage & {
  children: PageNode[];
};

/**
 * Build a nested page tree from a flat list of non-deleted pages.
 * Pages are sorted by position (numeric ascending) then createdAt order
 * (preserved from input array order for stability).
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

  const sortNodes = (nodes: PageNode[]): PageNode[] =>
    nodes
      .sort((a, b) => {
        const ap = a.position !== null ? parseFloat(a.position) : Infinity;
        const bp = b.position !== null ? parseFloat(b.position) : Infinity;
        return ap - bp;
      })
      .map((n) => ({ ...n, children: sortNodes(n.children) }));

  return sortNodes(roots);
}
