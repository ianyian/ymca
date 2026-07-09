import type { FastifyReply, FastifyRequest } from "fastify";

export function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    reply.status(401).send({
      code: "UNAUTHORIZED",
      message: "Authentication is required",
      traceId: request.id
    });
    return null;
  }

  return request.authUser;
}
