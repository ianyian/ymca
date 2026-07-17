import type { FastifyReply, FastifyRequest } from "fastify";
import { isAdminRole } from "../domain/app-roles.js";

/**
 * Guard for CoMa (Configuration Manager) endpoints. Returns the authenticated
 * admin user, or sends a 401/403 and returns null. The role is read from the
 * request payload (denormalized during auth resolution) — no extra query.
 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    reply.status(401).send({
      code: "UNAUTHORIZED",
      message: "Authentication is required",
      traceId: request.id,
    });
    return null;
  }

  if (!isAdminRole(request.authUser.appRoleKey)) {
    reply.status(403).send({
      code: "FORBIDDEN",
      message: "Administrator privileges are required",
      traceId: request.id,
    });
    return null;
  }

  return request.authUser;
}
