# Deployment & configuration

How the pieces fit together, and the exact env vars to set so the app runs the
same locally and in production.

## Topology

| Component | Local dev              | Production                                   |
|-----------|------------------------|----------------------------------------------|
| Web       | Vite @ `localhost:5173/ymca/` | GitHub Pages (`gh-pages` branch, base `/ymca/`) |
| API       | Fastify @ `localhost:4000`    | Render (`https://ymca-g4by.onrender.com`)      |
| DB        | local Postgres or Neon        | Neon (Postgres)                                |

Production is **cross-origin** (GitHub Pages origin → Render API origin).

### Auth across origins — token first, cookie fallback

Because the web app (`*.github.io`) and API (`*.onrender.com`) are different
sites, the session cookie is a **third-party cookie**. Safari/iOS blocks these
outright (ITP) and Chrome increasingly restricts them — which caused spurious
"Session expired" errors right after login. So auth works two ways:

- **Primary — bearer token.** Login/register return `token`; the web app stores
  it in `localStorage` (`ymca_token`) and sends it as `Authorization: Bearer` on
  every request. Works regardless of third-party-cookie policy. Bearer requests
  skip CSRF (the token is never auto-sent by the browser).
- **Fallback — session cookie** (`SameSite=None; Secure`), still set and honored
  where third-party cookies are allowed. Cookie-based mutating requests still
  require the `x-csrf-token` header.

Both resolve to the same `Session` row server-side (`resolveAuthFromRequest`).

## Web (Vite → GitHub Pages)

- Build-time only var: **`VITE_API_URL`**.
  - Local: `http://localhost:4000` (see `apps/web/.env.example`; the code also
    falls back to `<host>:4000` if unset).
  - Production: injected by `.github/workflows/deploy-web.yml` from the repo
    **Actions variable `VITE_API_URL`** (default `https://ymca-g4by.onrender.com`).
    Set it under GitHub → Settings → Secrets and variables → Actions → Variables.

## API (Fastify → Render)

Set these as **Render environment variables**:

| Var                   | Value (production)                                            | Notes |
|-----------------------|--------------------------------------------------------------|-------|
| `NODE_ENV`            | `production`                                                 | enables secure cookie + rate limiting |
| `DATABASE_URL`        | Neon **pooled** URL (`...-pooler...?sslmode=require`)         | app runtime connection |
| `DIRECT_DATABASE_URL` | Neon **direct** URL (no `-pooler`, `?sslmode=require`)        | used only by `prisma migrate` |
| `APP_URL`             | your web origin, e.g. `https://<user>.github.io/ymca`        | password-reset + published-page links |
| `CORS_ORIGINS`        | your web origin, e.g. `https://<user>.github.io`             | comma-separated allowlist; if unset, all origins are reflected |
| `BCRYPT_ROUNDS`       | `12`                                                          | |
| `SESSION_TTL_DAYS`    | `30`                                                          | |
| `SMTP_HOST/PORT/USER/PASS/FROM` | optional                                           | password-reset emails; without SMTP the reset link is returned in dev only |

> `CORS_ORIGINS` and `APP_URL` are **optional** for the app to boot — CORS falls
> back to reflecting the request origin, and `APP_URL` defaults to
> `http://localhost:5173`. Set both in production for correct links + locked-down CORS.

### Database migrations

Migrations are **not** run automatically. Apply them with a direct connection:

```bash
cd apps/api
DATABASE_URL="$DIRECT_DATABASE_URL" DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL" \
  pnpm exec prisma migrate deploy
```

(Or add that as a Render deploy/pre-deploy command.)

## Local development

See `RUNNING.md`. Minimum: copy `apps/api/.env.example` → `apps/api/.env`, set
`DATABASE_URL` (+ `DIRECT_DATABASE_URL`), then in two terminals:

```bash
pnpm --filter @ymca/api dev     # API on :4000
pnpm --filter @ymca/web dev     # web on :5173/ymca/
```

Everything else (`APP_URL`, `CORS_ORIGINS`) can stay unset locally.
