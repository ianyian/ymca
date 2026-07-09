import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma__: PrismaClient | undefined;
}

// Lazy singleton — allows __setTestPrismaClient() to inject a mock before first use.
let _instance: PrismaClient | undefined =
  process.env.NODE_ENV !== "production" ? globalThis.__prisma__ : undefined;

function getInstance(): PrismaClient {
  if (!_instance) {
    _instance = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });
    if (process.env.NODE_ENV !== "production") {
      globalThis.__prisma__ = _instance;
    }
  }
  return _instance;
}

/**
 * Inject a mock Prisma client for integration tests.
 * Must be called before the first request is made.
 * Never use outside of test code.
 */
export function __setTestPrismaClient(client: PrismaClient): void {
  _instance = client;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const instance = getInstance();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? (value as Function).bind(instance) : value;
  },
});
