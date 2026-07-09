import test from "node:test";
import assert from "node:assert/strict";
import { isValidWorkspaceSlug, toWorkspaceSlug } from "../../../src/domain/workspace.ts";

test("toWorkspaceSlug normalizes spaces and casing", () => {
  assert.equal(toWorkspaceSlug("  Team Alpha Workspace  "), "team-alpha-workspace");
});

test("toWorkspaceSlug removes unsupported symbols", () => {
  assert.equal(toWorkspaceSlug("Ops & Product @ HQ!"), "ops-product-hq");
});

test("toWorkspaceSlug collapses duplicate dashes", () => {
  assert.equal(toWorkspaceSlug("alpha---beta   gamma"), "alpha-beta-gamma");
});

test("isValidWorkspaceSlug enforces minimum length", () => {
  assert.equal(isValidWorkspaceSlug("ab"), false);
  assert.equal(isValidWorkspaceSlug("abc"), true);
});
