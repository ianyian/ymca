/**
 * Integration tests for CoMa (Configuration Manager) admin routes.
 *
 * Focus: the requireAdmin authorization guard. The mock session fixture has no
 * admin app-role, so an authenticated-but-normal user must be rejected with 403,
 * and an unauthenticated request with 401. Prisma is mocked — no real database.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestPrismaClient } from '../../src/lib/prisma.ts';
import { mockPrisma, resetMockState, setAuthSession } from './helpers/mock-prisma.ts';

process.env['DATABASE_URL'] = 'postgresql://mock:mock@localhost:5432/ymca_test';
process.env['NODE_ENV'] = 'test';
process.env['BCRYPT_ROUNDS'] = '10';
process.env['SESSION_TTL_DAYS'] = '30';
process.env['API_HOST'] = '0.0.0.0';
process.env['API_PORT'] = '4000';

__setTestPrismaClient(mockPrisma as never);

const { createServer } = await import('../../src/server.ts');

const ADMIN_ROUTES = [
  { method: 'GET' as const, url: '/admin/users' },
  { method: 'GET' as const, url: '/admin/roles' },
  { method: 'GET' as const, url: '/admin/metrics/overview' },
  { method: 'GET' as const, url: '/admin/metrics/activity?window=6h' },
];

describe('CoMa admin routes — authorization', () => {
  afterEach(() => resetMockState());

  for (const route of ADMIN_ROUTES) {
    it(`${route.method} ${route.url} → 401 when unauthenticated`, async () => {
      const app = createServer();
      const response = await app.inject({ method: route.method, url: route.url });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json<{ code: string }>().code, 'UNAUTHORIZED');
    });

    it(`${route.method} ${route.url} → 403 for a non-admin user`, async () => {
      setAuthSession();
      const app = createServer();
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer fixture-raw-token' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json<{ code: string }>().code, 'FORBIDDEN');
    });
  }

  it('PATCH /admin/users/:id/role → 403 for a non-admin user', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/users/00000000-0000-0000-0000-000000000000/role',
      headers: { authorization: 'Bearer fixture-raw-token' },
      payload: { appRoleKey: 'admin' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ code: string }>().code, 'FORBIDDEN');
  });
});
