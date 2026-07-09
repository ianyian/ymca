/**
 * Integration tests for workspace routes:
 *   POST /workspaces
 *   GET  /workspaces
 *
 * Prisma is replaced via __setTestPrismaClient() — no real database required.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestPrismaClient } from '../../src/lib/prisma.ts';
import {
  mockPrisma,
  mockState,
  resetMockState,
  setAuthSession,
  FIXTURES,
  makePrismaKnownError,
} from './helpers/mock-prisma.ts';

process.env['DATABASE_URL'] = 'postgresql://mock:mock@localhost:5432/ymca_test';
process.env['NODE_ENV'] = 'test';
process.env['BCRYPT_ROUNDS'] = '10';
process.env['SESSION_TTL_DAYS'] = '30';
process.env['API_HOST'] = '0.0.0.0';
process.env['API_PORT'] = '4000';

__setTestPrismaClient(mockPrisma as never);

const { createServer } = await import('../../src/server.ts');

// ---------------------------------------------------------------------------
// POST /workspaces
// ---------------------------------------------------------------------------

describe('POST /workspaces', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'My Workspace' },
    });
    assert.equal(response.statusCode, 401);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  it('returns 201 with workspace when authenticated', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'My Workspace' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json<{ workspace: { id: string; name: string; slug: string } }>();
    assert.ok(body.workspace, 'workspace field is present');
    assert.ok(body.workspace.id, 'workspace has id');
    assert.ok(body.workspace.slug, 'workspace has slug');
  });

  it('returns 400 when name is empty', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: '' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 400 when workspace name produces too-short slug', async () => {
    setAuthSession();
    const app = createServer();
    // A name with only special chars produces an empty/short slug
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: '!!' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 400);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'INVALID_WORKSPACE_SLUG');
  });

  it('returns 409 with WORKSPACE_SLUG_TAKEN when slug already exists', async () => {
    setAuthSession();
    mockState.workspaceCreateError = makePrismaKnownError('P2002');
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Taken Workspace' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 409);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'WORKSPACE_SLUG_TAKEN');
  });

  it('returns 403 for CSRF mismatch on mutating request', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Test Workspace' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': 'wrong-csrf-token',
      },
    });
    assert.equal(response.statusCode, 403);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'CSRF_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// GET /workspaces
// ---------------------------------------------------------------------------

describe('GET /workspaces', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/workspaces',
    });
    assert.equal(response.statusCode, 401);
  });

  it('returns 200 with empty array when user has no workspaces', async () => {
    setAuthSession();
    mockState.workspaceMembersResult = [];
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/workspaces',
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ workspaces: unknown[] }>();
    assert.deepEqual(body.workspaces, []);
  });

  it('returns 200 with workspaces list when user is a member', async () => {
    setAuthSession();
    mockState.workspaceMembersResult = [
      {
        id: 'member-id',
        workspace: FIXTURES.workspace,
        role: 'WorkspaceOwner',
        createdAt: new Date('2024-01-01'),
      },
    ];
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/workspaces',
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ workspaces: Array<{ id: string; name: string; slug: string; role: string }> }>();
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0]?.id, FIXTURES.workspace.id);
    assert.equal(body.workspaces[0]?.role, 'WorkspaceOwner');
  });
});
