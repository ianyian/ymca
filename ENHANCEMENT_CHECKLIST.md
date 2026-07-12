# ymca — Enhancement Checklist

Sequenced plan derived from the code + live-database review. Work top-to-bottom;
each phase is ordered so lower-risk, foundational changes land first.

Legend — effort: 🟢 small · 🟡 medium · 🔴 large · impact: ⭐ (1–3)

---

## Phase 1 — PostgreSQL / data layer

- [ ] **Rotate the Neon `neondb_owner` password** (it was shared in chat → treat as leaked).
      ⚠️ STILL PENDING — your action, in the Neon console. 🟢 ⭐⭐⭐
- [x] **Stop inlining base64 images in page content.** Pasted/dropped images now upload
      via `POST /pages/:id/attachments` and embed a capability URL
      (`/attachments/:id/inline`) instead of base64. New inline serving route added;
      `handlePaste` rewired + drag-drop added. 🟡 ⭐⭐⭐
- [~] **Migrate existing inline base64 images out of `content`** (e.g. "Second home" = 1 MB).
      Script delivered: `apps/api/scripts/migrate-inline-images.mjs` (dry-run by default).
      NOT auto-run — must run in the API's runtime env (writes to its `uploads/` dir).
      Run: `APPLY=1 DATABASE_URL=... API_PUBLIC_URL=... node apps/api/scripts/migrate-inline-images.mjs`. 🟡 ⭐⭐
- [x] **Add revision retention/pruning.** `pruneRevisions()` keeps the most recent 50
      snapshots per page; called after every content save + restore. `domain/versioning.ts`. 🟡 ⭐⭐
- [x] **Removed the `position` ordering.** Dropped the `position` column (migration
      `20260711010000_drop_page_position`, applied live), deleted `domain/ordering.ts`
      + its tests, and removed position handling from `tree.ts`, `move.ts`, the tree
      route, and the frontend. Siblings now order by `createdAt`. (Revisit drag-reorder later.) 🟡 ⭐⭐
- [x] **Drop 4 redundant indexes** (unique key already covers them):
      `Page_publishToken_idx`, `InviteToken_token_idx`, `PasswordResetToken_token_idx`,
      `Page_workspaceId_idx`. Removed `@@index` lines + migration `20260711000000_phase1_schema_cleanup`. 🟢 ⭐
- [x] **Fix `publishedAt` timestamp type** → `@db.Timestamptz(6)` to match all other
      timestamps. Also annotated every other DateTime field so `prisma migrate` won't
      try to revert the existing timestamptz columns. 🟢 ⭐
- [x] **Index `tags`** — added GIN index `Page_tags_idx` via `@@index([tags], type: Gin)`.
      (Longer term, consider a normalized `Tag` + join table for global rename/filter.) 🟢 ⭐
- [x] **Configure Prisma for the Neon pooler** — added `directUrl = env("DIRECT_DATABASE_URL")`
      to the datasource + documented pooled/direct URLs in `.env.example`. 🟢 ⭐⭐

> ⚠️ **Migration prepared + validated (dry-run rolled back), NOT yet applied to the live DB.**
> Apply with: `pnpm --filter api exec prisma migrate deploy` (with `DIRECT_DATABASE_URL` set to
> the non-pooler Neon endpoint). Running raw SQL directly would desync Prisma's `_prisma_migrations`.
- [ ] **Add body-text full-text search (DB side).** Extract plain text from `content`
      JSONB into a maintained/generated `tsvector` column + GIN index; search currently
      only covers `title`. 🟡 ⭐⭐

---

## Phase 2 — Priority security & correctness fixes

- [x] **Enforce page-level permissions (the #1 issue).** Added shared
      `resolvePageAccess()` guard (`lib/page-access.ts`) using the permission engine;
      wired into pages (view/edit), attachments, revisions, move, trash (edit),
      share + publish (Owner-only). Added `canManage()` + an integration test proving a
      guest editing a page they don't own gets 403. 🔴 ⭐⭐⭐
- [x] **Lock down attachment routes.** All of upload/list/download/delete now require
      auth + page access (download previously had **none**). Inline capability route
      unchanged by design. 🟡 ⭐⭐⭐
- [x] **Sanitize public-page link hrefs** — `sanitizeUrl()` allows only
      http/https/mailto/tel + relative/anchor, else `#`. `routes/public-page.ts`. 🟢 ⭐⭐⭐
- [x] **Add rate limiting** (`@fastify/rate-limit`): 10/min on `/auth/*`, 200/min
      elsewhere; disabled under test. `server.ts`. 🟢 ⭐⭐
- [x] **CORS allowlist (env-driven).** `CORS_ORIGINS` restricts origins when set,
      else reflects (dev). Non-breaking — set it in Render to lock down. `server.ts`. 🟢 ⭐⭐
- [x] **Session cookie `SameSite` — reviewed, kept `None`.** Your API and web run on
      **different Render origins**, so cross-site cookies REQUIRE `SameSite=None; Secure`.
      Switching to `lax` would break login. No change (correct as-is). 🟢 ⭐
- [x] **Untrack committed artifacts** — `git rm --cached` on `apps/api/uploads/*` +
      `App.tsx.corrupted`; added `apps/api/uploads/` + `*.corrupted` to `.gitignore`. 🟢 ⭐⭐
- [x] **Throttle `lastSeenAt` writes** — now only updates if stale > 60s. `auth/session.ts`. 🟢 ⭐
- [x] **Attachment hardening** — mimetype allowlist + 15 MB size cap + `nosniff` on
      download. (Relative-path storage superseded by object-storage item below.) 🟡 ⭐
- [x] **Decouple publish theme from token** — re-publishing preserves the existing
      token + publishedAt; theme updates independently. `routes/publish.ts`. 🟢 ⭐
- [x] **Fixed hardcoded `:5173` URLs** (bonus, Render correctness) — password-reset +
      published-page links now use `APP_URL` instead of guessing the dev port.

> ⚠️ **Render deployment:** the filesystem is **ephemeral** — attachment files in
> `apps/api/uploads/` (including images from the Phase 1 fix) are **wiped on every
> deploy/restart**. See the object-storage item in Phase 3 → "Bigger bets".
> These Phase 2 changes are code-only (no DB migration); **deploy to Render** to activate,
> and set `CORS_ORIGINS` + `APP_URL` env vars there.

---

## Phase 3 — Feature enhancements (Notion parity)

> 📐 The block-editor work (drag handles, colors, page references, multi-user)
> now has its own phased plan: see **[BLOCKS_ROADMAP.md](BLOCKS_ROADMAP.md)**.
> The unchecked editor items below are superseded by / folded into that roadmap.

**Editor — do the slash menu first; it makes every later block discoverable.**

- [x] **Slash (`/`) command menu** — `@tiptap/suggestion` + self-contained popup
      (`apps/web/src/editor-extensions.ts`). Filter + click/keys to insert. Tested live. 🟡 ⭐⭐⭐
- [x] **To-do / checkbox blocks** — `@tiptap/extension-task-list` + `task-item`;
      renders in editor + published pages. Tested live. 🟢 ⭐⭐⭐
- [ ] **Toggle (collapsible) blocks** — custom node. (Deferred — next editor item.) 🟡 ⭐⭐
- [x] **Callout blocks** — custom `Callout` node (💡 + colored box); renders in editor
      and in published HTML. Tested live. 🟡 ⭐⭐
- [ ] **Tables** — `@tiptap/extension-table`. 🔴 ⭐⭐
- [~] **Highlight** — `@tiptap/extension-highlight` added + rendered on public pages.
      Still needs a UI to APPLY it (bubble-menu/toolbar) — see drag-handle item. 🟢 ⭐
- [ ] **Block drag handles + `+`/`⋮⋮` + selection bubble-menu (bold/highlight/link)**
      — `@tiptap/extension-drag-handle-react` + `BubbleMenu`. 🟡 ⭐⭐
- [ ] **Body-text search (frontend)** — surface the Phase 1 tsvector results. 🟢 ⭐⭐
- [ ] **@mentions / backlinks** — link pages inline, show "linked from". 🟡 ⭐⭐

**Maintainability enabler**

- [ ] **Split `App.tsx` (3,885 lines)** into `components/`, `lib/api.ts`, `hooks/`;
      extract duplicated `tagColor`/theme CSS into `packages/shared-config`. 🟡 ⭐⭐

**Bigger bets (defer until editor is solid)**

- [ ] **Move attachments to object storage (S3 / Cloudflare R2).** ⚠️ **Important for
      Render:** the current local-filesystem storage (`apps/api/uploads/`) is **ephemeral**
      on Render — all uploaded files, including inline images, are lost on every deploy/
      restart. Store objects in S3/R2 and keep only the URL/key in `PageAttachment`. 🔴 ⭐⭐⭐
- [ ] **Databases / table-board-gantt views** — new `Database`/`Row`/`Property` schema. 🔴 ⭐⭐⭐
- [ ] **Real-time collaboration** — Yjs + `@tiptap/extension-collaboration` + Hocuspocus. 🔴 ⭐⭐
- [ ] **Comments** — threaded comments on blocks/pages. 🔴 ⭐
- [ ] **Audit log** — table for create/update/delete/share events (blueprint promises it). 🟡 ⭐

---

_Generated from the ymca code + live DB review. Update checkboxes as work lands._
