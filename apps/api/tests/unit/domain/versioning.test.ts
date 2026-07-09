import test from "node:test";
import assert from "node:assert/strict";
import { getNextVersion, hasVersionConflict } from "../../../src/domain/versioning.ts";

test("hasVersionConflict returns false when versions match", () => {
  assert.equal(hasVersionConflict(3, 3), false);
});

test("hasVersionConflict returns true when versions differ", () => {
  assert.equal(hasVersionConflict(4, 3), true);
});

test("getNextVersion increments by one", () => {
  assert.equal(getNextVersion(9), 10);
});
