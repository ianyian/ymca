# CoMa (Configuration Manager) — Admin Feature Task List

> **Resumable checklist.** This file is the source of truth for progress so work can
> continue across sessions. When you finish a task, change `[ ]` → `[x]` and commit.
> Branch: `feat/coma-admin-configuration-manager`.

## Goal
Add an admin-only **CoMa** (Configuration Manager) area:
- Global per-user app role (extensible lookup table; today only `admin` / `user`).
- All **existing** users backfilled to `admin`; **new** users default to `user`.
- Sidebar **CoMa** button visible only to admins → opens Configuration page.
- Configuration page tabs:
  - **User Management** — list users, change app role (admin/user).
  - **Monitoring** — KPIs: total users (active/inactive), total pages, total storage,
    active users (last 6/12/24h, auto-refresh ~3s), total API calls (last 6/12/24h), + more.
- Designed for hundreds–thousands of users: lookup tables, FKs, PKs, indexes, batched
  metrics writes, cached hot-path metric reads. Landing-page & data-retrieval speed matter.

## Design decisions
- **Lookup table `AppRole`** (`id` SmallInt PK, `key` unique, `label`, `description`,
  `rank`, `isAssignable`). Seeded: `admin` id=1 rank=100, `user` id=2 rank=10.
- **`User.appRoleId`** Int FK → AppRole, DB default `2` (user). Existing rows backfilled → `1`.
- **`ActivityEvent`** append-only (BigInt PK): userId?, method, path (route pattern),
  statusCode, durationMs, createdAt. Indexed on `(createdAt)` and `(userId, createdAt)`.
  Written via an **in-memory batch buffer** flushed every few seconds (low write amplification).
- **Metrics reads** cached ~2s server-side so the 3s admin poll doesn't hammer the DB.
- Auth payload extended with `appRoleKey` + `appRoleRank`; `requireAdmin` guard; `/me` exposes role.

---

## Backend (apps/api)

- [ ] **B1. Prisma schema** — add `AppRole` model, `User.appRoleId` + relation & index,
      `ActivityEvent` model + indexes. (`prisma/schema.prisma`)
- [ ] **B2. Migration SQL** — new migration dir `.../<ts>_coma_admin_roles_activity/migration.sql`:
      create `AppRole`, seed admin(1)/user(2), add `User.appRoleId` default 2, backfill existing → 1,
      add FK + index, create `ActivityEvent` + indexes.
- [ ] **B3. Roles domain** — `src/domain/app-roles.ts` (keys, ranks, helpers).
- [ ] **B4. Auth payload + session** — include appRole in `resolveAuthFromRequest`; extend
      `AuthPayload`/`request.authUser` types (`types/fastify.d.ts`); expose in `/me`.
- [ ] **B5. requireAdmin guard** — `src/auth/require-admin.ts`.
- [ ] **B6. Activity logging** — `src/lib/activity-buffer.ts` (batched insert) + `onResponse`
      hook in `server.ts` (skip health/metrics/static; store route pattern not raw path).
- [ ] **B7. Metrics service** — `src/domain/metrics.ts`: overview + windowed activity, with 2s cache.
- [ ] **B8. Admin routes** — `src/routes/admin.ts`: 
      `GET /admin/users` (paginated+search), `PATCH /admin/users/:id/role`,
      `GET /admin/metrics/overview`, `GET /admin/metrics/activity?window=6h|12h|24h`.
      Register in `server.ts`. All behind `requireAdmin`.
- [ ] **B9. Tests** — unit for role/metrics helpers; integration for admin routes authz.

## Frontend (apps/web/src/App.tsx)

- [ ] **F1. SessionUser type** — add `appRoleKey`, `appRoleRank`; read from `/me`.
- [ ] **F2. Sidebar CoMa button** — visible only when `user.appRoleKey === 'admin'`;
      sets a new view state (`activeView: 'home' | 'coma'`).
- [ ] **F3. ConfigurationManager component** — tabs User Management + Monitoring.
- [ ] **F4. User Management** — table of users + role dropdown → `PATCH /admin/users/:id/role`.
- [ ] **F5. Monitoring** — KPI cards; window switch (6/12/24h); active users poll ~3s (cleanup on unmount).
- [ ] **F6. i18n strings** (T[lang]) for new labels.

## Verify / ship

- [ ] **V1. Typecheck** — `pnpm -r typecheck`.
- [ ] **V2. Apply migration** to Neon (direct URL) — `prisma migrate deploy`.
- [ ] **V3. Run API + web locally**, smoke test: admin sees CoMa, non-admin doesn't;
      role change works; metrics render & poll.
- [ ] **V4. Commit, push, open PR** to `main`. (Deploy hook available for Render if needed.)

## Notes / credentials (do NOT commit real secrets)
- DB + API details are in `apps/api/.env` (gitignored). Migrations need the **direct** (non-pooler) URL.
- Render deploy hook exists for redeploying the API after merge.
