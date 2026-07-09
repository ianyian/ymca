/**
 * Integration tests for auth routes:
 *   POST /auth/register
 *   POST /auth/login
 *   POST /auth/logout
 *   GET  /me
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

// Set required env vars before server module is loaded
process.env['DATABASE_URL'] = 'postgresql://mock:mock@localhost:5432/ymca_test';
process.env['NODE_ENV'] = 'test';
process.env['BCRYPT_ROUNDS'] = '10';
process.env['SESSION_TTL_DAYS'] = '30';
process.env['API_HOST'] = '0.0.0.0';
process.env['API_PORT'] = '4000';

__setTestPrismaClient(mockPrisma as never);

const { createServer } = await import('../../src/server.ts');

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  afterEach(() => resetMockState());

  it('returns 201 with user and csrfToken on success', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@example.com', password: 'StrongPass1!' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json<{ user: { id: string; email: string }; csrfToken: string }>();
    assert.ok(body.user, 'user field is present');
    assert.ok(body.csrfToken, 'csrfToken field is present');
    assert.equal(body.user.email, 'new@example.com');
  });

  it('returns 201 with optional displayName', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'with-name@example.com', password: 'StrongPass1!', displayName: 'Alice' },
    });
    assert.equal(response.statusCode, 201);
  });

  it('returns 400 for invalid email format', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'StrongPass1!' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 400 when password is too short (< 8 chars)', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com', password: 'short' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 400 when required fields are missing', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 409 with EMAIL_TAKEN when email is already registered', async () => {
    mockState.userCreateError = makePrismaKnownError('P2002');
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'taken@example.com', password: 'StrongPass1!' },
    });

    assert.equal(response.statusCode, 409);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'EMAIL_TAKEN');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  afterEach(() => resetMockState());

  it('returns 200 with user and csrfToken for valid credentials', async () => {
    // Return a user whose passwordHash is the bcrypt hash of "StrongPass1!" at cost 4
    // We pre-compute it using bcrypt in the mock by returning a real hash
    // For test speed, we set a known bcrypt hash (rounds=4) for "StrongPass1!"
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('StrongPass1!', 10);
    mockState.userFindUniqueResult = { ...FIXTURES.user, passwordHash: hash };

    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: FIXTURES.user.email, password: 'StrongPass1!' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ user: { id: string }; csrfToken: string }>();
    assert.ok(body.user);
    assert.ok(body.csrfToken);
  });

  it('returns 401 with INVALID_CREDENTIALS when email not found', async () => {
    mockState.userFindUniqueResult = null;
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'StrongPass1!' },
    });

    assert.equal(response.statusCode, 401);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  });

  it('returns 401 with INVALID_CREDENTIALS for wrong password', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('CorrectPass1!', 10);
    mockState.userFindUniqueResult = { ...FIXTURES.user, passwordHash: hash };

    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: FIXTURES.user.email, password: 'WrongPass1!' },
    });

    assert.equal(response.statusCode, 401);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  });

  it('returns 400 for invalid email format', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'bad-email', password: 'StrongPass1!' },
    });
    assert.equal(response.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  afterEach(() => resetMockState());

  it('returns 204 when not authenticated (graceful)', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
    });
    assert.equal(response.statusCode, 204);
  });

  it('returns 204 and invalidates session when authenticated', async () => {
    setAuthSession();
    const app = createServer();
    // Include a cookie header to simulate a session cookie
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: `ymca_session=fixture-raw-token`,
        'x-csrf-token': FIXTURES.session.csrfToken,
      },
    });
    assert.equal(response.statusCode, 204);
  });
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

describe('GET /me', () => {
  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/me',
    });
    assert.equal(response.statusCode, 401);
    const body = response.json<{ code: string }>();
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  it('returns 200 with user and csrfToken when authenticated', async () => {
    setAuthSession();
    const app = createServer();
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        cookie: `ymca_session=fixture-raw-token`,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{ user: { id: string; email: string }; csrfToken: string }>();
    assert.equal(body.user.id, FIXTURES.user.id);
    assert.ok(body.csrfToken);
  });
});
