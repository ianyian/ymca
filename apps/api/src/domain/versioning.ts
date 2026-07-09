export function hasVersionConflict(currentVersion: number, expectedVersion: number): boolean {
  return currentVersion !== expectedVersion;
}

export function getNextVersion(currentVersion: number): number {
  return currentVersion + 1;
}
