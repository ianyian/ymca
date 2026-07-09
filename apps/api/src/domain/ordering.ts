/**
 * Fractional-index helpers for sibling page ordering.
 *
 * Positions are stored as Decimal strings. We use a simple midpoint
 * strategy: positions are floating-point numbers in (0, 1).
 *
 * Initial position for a new page appended to the end of a list is
 * computed as `lastPosition + 1.0`. This lets the list grow without
 * rebalancing most of the time.
 *
 * Rebalancing assigns evenly-spaced integers: 1.0, 2.0, 3.0, …
 * to avoid floating-point precision issues after many insertions.
 */

const REBALANCE_THRESHOLD = 1e-9;

/**
 * Generate a position value that sits between `before` and `after`.
 *
 * @param before - position of the preceding sibling (null = start of list)
 * @param after  - position of the following sibling (null = end of list)
 * @returns a decimal string for the new position
 * @throws if the gap is too small (< REBALANCE_THRESHOLD) — caller should rebalance
 */
export function generatePositionBetween(
  before: string | null,
  after: string | null,
): string {
  const a = before !== null ? parseFloat(before) : 0;
  const b = after !== null ? parseFloat(after) : a + 2;

  if (b - a < REBALANCE_THRESHOLD) {
    throw new Error('Position gap too small — rebalance required');
  }

  const mid = (a + b) / 2;
  return String(mid);
}

/**
 * Generate a position for a new item appended after `last`.
 */
export function appendPosition(last: string | null): string {
  const a = last !== null ? parseFloat(last) : 0;
  return String(a + 1);
}

/**
 * Assign evenly-spaced integer positions (1, 2, 3, …) to an ordered list
 * of page IDs. Returns a map of id → new position string.
 */
export function rebalancePositions(orderedIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  orderedIds.forEach((id, i) => result.set(id, String(i + 1)));
  return result;
}
