/**
 * Integration tests for page routes:
 *   POST  /workspaces/:workspaceId/pages
 *   GET   /pages/:id
 *   PATCH /pages/:id/meta
 *   PUT   /pages/:id/content
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
} from './helpers/mock-prisma.ts';

process.env['DATABASE_URL'] = 'postgresql://mock:mock@localhost:5432/ymca_test';
process.env['NODE_ENV'] = 'test';
process.env['BCRYPT_ROUNDS'] = '10';
process.env['SESSION_TTL_DAYS'] = '30';
process.env['API_HOST'] = '0.0.0.0';
process.env['API_PORT'] = '4000';

__setTestPrismaClient(mockPrisma as never);

const { createServer } = await import('../../src/server.ts');

const WORKSPACE_ID = FIXTURES.workspace.id;
const PAGE_ID = FIXTURES.page.id;

// ---------------------------------------------------------------------------
// POST /workspaces/:workspaceId/pages
// ---------------------------------------------------------------------------

describe('POST /workspaces/:workspaceId/pages', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/pages`,
      payload: { title: 'New Page' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('returns 403 when user has no workspace access', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null; // override: no membership
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/pages`,
      payload: { title: 'New Page' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 403);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'FORBIDDEN');
  });

  it('returns 201 with page on success', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/pages`,
      payload: { title: 'My First Page' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json<{ page: { id: string; title: string; workspaceId: string; version: number } }>();
    assert.ok(body.page, 'page field is present');
    assert.equal(body.page.title, 'My First Page');
    assert.equal(body.page.workspaceId, WORKSPACE_ID);
    assert.equal(body.page.version, 1);
  });

  it('returns 201 with default title when none provided', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/pages`,
      payload: {},
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json<{ page: { title: string } }>();
    assert.equal(body.page.title, 'Untitled');
  });

  it('returns 400 for invalid (non-UUID) workspaceId', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/workspaces/not-a-uuid/pages',
      payload: { title: 'Page' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /pages/:id
// ---------------------------------------------------------------------------

describe('GET /pages/:id', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}`,
    });
    assert.equal(response.statusCode, 401);
  });

  it('returns 200 with page when authenticated and has access', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ page: { id: string; title: string } }>();
    assert.equal(body.page.id, PAGE_ID);
  });

  it('returns 404 when page does not exist', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });
    assert.equal(response.statusCode, 404);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'PAGE_NOT_FOUND');
  });

  it('returns 404 for soft-deleted page', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = { ...FIXTURES.page, deletedAt: new Date() };
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });
    assert.equal(response.statusCode, 404);
  });

  it('returns 403 when user has no access to the workspace', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });
    assert.equal(response.statusCode, 403);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'FORBIDDEN');
  });

  it('returns 400 for invalid (non-UUID) page id', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/pages/not-a-uuid',
      headers: { cookie: 'ymca_session=fixture-raw-token' },
    });
    assert.equal(response.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /pages/:id/meta
// ---------------------------------------------------------------------------

describe('PATCH /pages/:id/meta', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/pages/${PAGE_ID}/meta`,
      payload: { title: 'Updated Title' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('returns 200 with updated page on success', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/pages/${PAGE_ID}/meta`,
      payload: { title: 'Updated Title' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{ page: { id: string } }>();
    assert.ok(body.page, 'page field is present');
  });

  it('returns 200 when updating icon and coverImageUrl', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/pages/${PAGE_ID}/meta`,
      payload: { icon: '📄', coverImageUrl: 'https://example.com/cover.jpg' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 200);
  });

  it('returns 404 when page does not exist', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/pages/${PAGE_ID}/meta`,
      payload: { title: 'Title' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 404);
  });

  it('returns 403 when user has no workspace access', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/pages/${PAGE_ID}/meta`,
      payload: { title: 'Title' },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// PUT /pages/:id/content
// ---------------------------------------------------------------------------

describe('PUT /pages/:id/content', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 1, content: { type: 'doc', content: [] } },
    });
    assert.equal(response.statusCode, 401);
  });

  it('returns 200 with updated page and incremented version on success', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = { ...FIXTURES.page, version: 1 };
    mockState.pageTransactionResult = { ...FIXTURES.page, version: 2 };

    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 1, content: { type: 'doc', content: [] } },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ page: { id: string; version: number } }>();
    assert.ok(body.page, 'page field is present');
    assert.equal(body.page.version, 2);
  });

  it('returns 403 when a guest with no page grant edits a page they do not own', async () => {
    setAuthSession();
    // Caller is a WorkspaceGuest (default page role: none) …
    mockState.workspaceAccessResult = { id: 'member-id', role: 'WorkspaceGuest' };
    // … and is NOT the page creator, with no explicit page permission.
    mockState.pageFindUniqueResult = {
      ...FIXTURES.page,
      creatorId: '99999999-9999-9999-9999-999999999999',
      permissions: [],
    } as never;

    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 1, content: { type: 'doc', content: [] } },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 403);
  });

  it('returns 409 with VERSION_CONFLICT when expectedVersion does not match', async () => {
    setAuthSession();
    // Current DB version is 5, client sends expectedVersion: 3 → conflict
    mockState.pageFindUniqueResult = { ...FIXTURES.page, version: 5 };

    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 3, content: { type: 'doc', content: [] } },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });

    assert.equal(response.statusCode, 409);
    const body = response.json<{ code: string; latest: { version: number } }>();
    assert.equal(body.code, 'VERSION_CONFLICT');
    assert.equal(body.latest.version, 5);
  });

  it('returns 400 when expectedVersion is missing', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { content: { type: 'doc', content: [] } },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 404 when page does not exist', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 1, content: {} },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 404);
  });

  it('returns 403 when user has no workspace access', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/pages/${PAGE_ID}/content`,
      payload: { expectedVersion: 1, content: {} },
      headers: {
        cookie: 'ymca_session=fixture-raw-token',
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 403);
  });
});
