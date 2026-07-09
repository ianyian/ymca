/**
 * Local TCP proxy that bridges Prisma (plain-text localhost:5433)
 * to Neon (direct TLS on port 5432).
 *
 * Why: Neon's .c-2. endpoints require "sslnegotiation=direct" which
 * is a libpq 17+ feature that Prisma's Rust engine does not support.
 * This proxy handles the TLS upgrade transparently so Prisma connects
 * to localhost:5433 without SSL while the proxy secures the link to Neon.
 */
import * as net from "node:net";
import * as tls from "node:tls";

const NEON_HOST = process.env.NEON_PROXY_HOST ?? "";
const NEON_PORT = 5432;
const LOCAL_PORT = parseInt(process.env.NEON_PROXY_LOCAL_PORT ?? "5433", 10);

export function startNeonProxy(): Promise<void> {
  if (!NEON_HOST) return Promise.resolve(); // No proxy needed

  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const queue: Buffer[] = [];
      let neonReady = false;

      const neonSocket = tls.connect(
        { host: NEON_HOST, port: NEON_PORT, servername: NEON_HOST, rejectUnauthorized: false },
        () => {
          neonReady = true;
          queue.forEach((d) => neonSocket.write(d));
          queue.length = 0;
        }
      );

      clientSocket.on("data", (d) => {
        if (neonReady) neonSocket.write(d);
        else queue.push(d);
      });

      neonSocket.on("data", (d) => clientSocket.write(d));

      clientSocket.on("error", () => { if (!neonSocket.destroyed) neonSocket.destroy(); });
      neonSocket.on("error", (e) => {
        console.error("[neon-proxy] Neon socket error:", e.message);
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
      clientSocket.on("close", () => { if (!neonSocket.destroyed) neonSocket.destroy(); });
      neonSocket.on("close", () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
    });

    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        // Already running (e.g. hot reload) — that's fine
        console.log(`[neon-proxy] Port ${LOCAL_PORT} already in use, assuming proxy is running`);
        resolve();
      } else {
        reject(e);
      }
    });

    server.listen(LOCAL_PORT, "127.0.0.1", () => {
      console.log(`[neon-proxy] ${NEON_HOST}:${NEON_PORT} <-- TLS --> localhost:${LOCAL_PORT} <-- plain`);
      resolve();
    });
  });
}
