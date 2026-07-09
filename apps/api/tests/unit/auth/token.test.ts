import test from "node:test";
import assert from "node:assert/strict";
import { generateSecureToken, hashSessionToken } from "../../../src/auth/token.ts";

test("hashSessionToken is deterministic", () => {
  const input = "session-token-123";
  assert.equal(hashSessionToken(input), hashSessionToken(input));
});

test("hashSessionToken produces a 64-char hex digest", () => {
  const digest = hashSessionToken("anything");
  assert.equal(digest.length, 64);
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test("generateSecureToken returns url-safe random tokens", () => {
  const first = generateSecureToken();
  const second = generateSecureToken();

  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9\-_]+$/);
  assert.ok(first.length >= 43);
});
