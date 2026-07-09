import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestPrismaClient } from '../../src/lib/prisma.ts';
import {
  mockPrisma,
  mockState,
  resetMockState,
  setAuthSession,
  FIXTURES,
} from './helpers/mock-prisma.ts';

__setTestPrismaClient(mockPrisma as never);
const { createServer } = await import('../../src/server.ts');

const WORKSPACE_ID = FIXTURES.workspace.id;
const CSRF = FIXTURES.session.csrfToken;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('POST /workspaces/:workspaceId/invites', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/invites`,
      payload: { role: 'WorkspaceMember' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when caller is not admin/owner', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = { id: 'member-id', role: 'WorkspaceMember' };

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/invites`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { role: 'WorkspaceMember' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'FORBIDDEN');
  });

  it('creates invite token as admin', async () => {
    setAuthSession();
    // setAuthSession sets role to WorkspaceOwner via workspaceAccessResult

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/invites`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { role: 'WorkspaceMember', email: 'new@test.com' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { invite: { id: string; token: string } };
    assert.ok(body.invite.id);
    assert.ok(body.invite.token);
  });

  it('creates invite without email', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${WORKSPACE_ID}/invites`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { role: 'WorkspaceGuest' },
    });
    assert.equal(res.statusCode, 201);
  });
});

describe('POST /invites/:token/accept', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/invites/${FIXTURES.invite.token}/accept`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when invite not found', async () => {
    setAuthSession();
    mockState.inviteFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/invites/bad-token/accept`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'INVITE_NOT_FOUND');
  });

  it('returns 410 when invite is expired', async () => {
    setAuthSession();
    mockState.inviteFindUniqueResult = {
      ...FIXTURES.invite,
      expiresAt: new Date(Date.now() - 1000),
    };
    // Not a workspace member yet
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/invites/${FIXTURES.invite.token}/accept`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 410);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'INVITE_EXPIRED');
  });

  it('returns 410 when invite is already used', async () => {
    setAuthSession();
    mockState.inviteFindUniqueResult = {
      ...FIXTURES.invite,
      usedAt: new Date(),
    };
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/invites/${FIXTURES.invite.token}/accept`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 410);
  });

  it('returns 409 when already a member', async () => {
    setAuthSession();
    // workspaceAccessResult is set by setAuthSession — user is already a member

    const res = await app.inject({
      method: 'POST',
      url: `/invites/${FIXTURES.invite.token}/accept`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'ALREADY_MEMBER');
  });

  it('accepts invite and creates membership', async () => {
    setAuthSession();
    // Not yet a member of THIS workspace
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/invites/${FIXTURES.invite.token}/accept`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { member: { id: string } };
    assert.ok(body.member.id);
  });
});
