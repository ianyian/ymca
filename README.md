# YMCA — a Notion-style collaborative workspace

YMCA is a self-hosted, block-based knowledge workspace: create nested pages, write
with a rich block editor, organise with tags, collaborate inside workspaces with
role-based access, publish pages to the web, and keep a full revision history.

It is built as a TypeScript monorepo — a React web app, a Fastify API, and a
PostgreSQL database — and is deployed with **GitHub Pages** (web), **Render**
(API), and **Neon** (database).

> Current version: **v0.1** (released 2026-07-11)

---

## ✨ Features

**Editor**
- Block editor built on TipTap/ProseMirror with a **slash (`/`) command menu**
- Blocks: headings, text, bullet/numbered lists, **to-do checklists**, **callouts**,
  quotes, code blocks, dividers, images, and text highlight
- Reliable **autosave** with optimistic-concurrency version conflict handling
- Paste/drag **images** and attach files (PDF, Word, Excel, PPT, images…) up to 1 GB

**Organisation & collaboration**
- Nested **page tree** with fast navigation
- **Workspaces** with roles (Owner / Admin / Member / Guest)
- **Page-level permissions** (Owner / Editor / Viewer, plus explicit deny)
- **Sharing** and workspace **invites**
- **Publish to web** — a public read-only link with selectable themes
- **Revision history** with restore (pruned to the latest 50 per page)
- **Trash** (soft delete) and restore
- **Full-text search** and colored **tags** with filtering

**Platform**
- Cookie-based sessions with **CSRF protection**, **bcrypt** password hashing,
  **rate limiting**, and enforced permission checks on every page operation
- **7 languages** (English, Chinese, Malay, Tamil, German, Hungarian, Spanish)
- **4 themes** (Light, Dark, Muji, VS Code) and adjustable font size

## 🧩 Core Components

| Component | What it does | Where it is used |
|-----------|--------------|------------------|
| `App` | Main web shell for sign-in, workspace navigation, page editing, search, publishing, revisions, trash, and profile settings. | `apps/web/src/App.tsx` |
| `editor-extensions` | Custom TipTap nodes and extensions for callouts, columns, page references, slash commands, and page lookup suggestions. | `apps/web/src/editor-extensions.ts` |
| `i18n` | Language labels and translated UI strings for the editor, auth flow, sidebar, publishing, trash, and errors. | `apps/web/src/i18n.ts` |
| `shared-types` | Shared TypeScript primitives used by the web app and API to keep data contracts aligned. | `packages/shared-types/src/index.ts` |

These components cover the main public-facing usage areas: editing content, browsing page trees, linking pages, managing workspaces, publishing pages, and switching languages or appearance.

## 📚 Libraries In Use

| Library | Purpose |
|---------|---------|
| React | UI rendering and state management in the web app. |
| TipTap / ProseMirror | Rich block editor, custom nodes, slash menu, and inline page references. |
| Fastify | API routing, auth, uploads, and workspace/page operations. |
| Prisma | Database access and migration management for PostgreSQL. |
| Zod | Runtime validation for API inputs and structured payloads. |
| Tailwind CSS | Styling and layout for the web interface. |
| Vite | Frontend development server and production bundling. |
| bcryptjs | Password hashing for local authentication flows. |

---

## 🏗️ Architecture

```
┌──────────────┐   HTTPS + cookies    ┌──────────────┐   Postgres wire   ┌──────────────┐
│   Web app    │  ───────────────▶    │     API      │  ──────────────▶  │   Database   │
│  React/Vite  │  ◀───────────────    │   Fastify    │  ◀──────────────  │  PostgreSQL  │
│ GitHub Pages │     JSON / HTML      │    Render    │      Prisma       │     Neon     │
└──────────────┘                      └──────────────┘                   └──────────────┘
```

- The web app and API run on **different origins**, so authentication uses a
  secure, `HttpOnly`, `SameSite=None` session cookie plus a CSRF token header.
- The API talks to Neon PostgreSQL through **Prisma** (pooled connection for the
  app, a direct connection for migrations).

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full topology and environment-variable
matrix.

## 🧰 Tech stack

| Layer     | Technology                                             |
|-----------|--------------------------------------------------------|
| Frontend  | React, TypeScript, Vite, Tailwind CSS, TipTap          |
| Backend   | Node.js, TypeScript, Fastify, Zod, Prisma              |
| Database  | PostgreSQL (Neon), Prisma ORM                          |
| Auth      | Cookie sessions (hashed tokens), CSRF, bcrypt          |
| Hosting   | GitHub Pages (web), Render (API), Neon (DB)            |
| Tooling   | pnpm workspaces, GitHub Actions (CI + deploy)          |

## 📁 Monorepo layout

```
apps/
  web/       React frontend (the app UI + editor)
  api/       Fastify backend (routes, auth, Prisma schema + migrations)
  desktop/   Tauri desktop wrapper (planned)
packages/
  shared-types/   shared TypeScript models
  shared-config/  shared configuration
DEPLOYMENT.md            deploy topology + env vars
ENHANCEMENT_CHECKLIST.md roadmap / improvement backlog
```

## 🗄️ Data model (overview)

`User` · `Session` · `Workspace` · `WorkspaceMember` · `Page` · `PageRevision` ·
`PagePermission` · `InviteToken` · `PasswordResetToken` · `PageAttachment`.

Pages are self-referential (a page can have a parent page → the nested tree),
content is stored as JSONB, and soft deletes (`deletedAt`) power the trash.
Full schema: [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma).

---

## 🚀 Local development

**Prerequisites:** Node.js 22+, pnpm (via `corepack enable`), and a PostgreSQL
database (local, or a Neon connection string).

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Configure the API — copy `apps/api/.env.example` → `apps/api/.env` and set
   `DATABASE_URL` (and `DIRECT_DATABASE_URL`). Keep secrets out of git.
3. Apply migrations:
   ```bash
   pnpm --filter @ymca/api exec prisma migrate deploy
   ```
4. Run the two apps (in separate terminals):
   ```bash
   pnpm --filter @ymca/api dev     # API  → http://localhost:4000
   pnpm --filter @ymca/web dev     # Web  → http://localhost:5173/ymca/
   ```
5. Open **http://localhost:5173/ymca/**.

Useful scripts: `pnpm typecheck`, `pnpm build`, `pnpm --filter @ymca/api test`.

## ☁️ Deployment

- **Web → GitHub Pages:** pushing to `main` runs the *Deploy Web* workflow, which
  builds `apps/web` (with `VITE_API_URL` from a repo variable) and publishes to the
  `gh-pages` branch. Pages serves it under `/ymca/`.
- **API → Render:** deploys from `main`; set `DATABASE_URL`, `DIRECT_DATABASE_URL`,
  `APP_URL`, and `CORS_ORIGINS` as Render environment variables.
- **Database → Neon:** managed PostgreSQL; use the pooled URL for the app and the
  direct URL for migrations.

Full instructions and the env-var table: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## 🔐 Security notes

Secrets (database URLs, passwords, SMTP) must live in environment variables /
platform secret stores — never in the repository. Uploaded files and `.env` files
are gitignored. See [DEPLOYMENT.md](DEPLOYMENT.md) for what to configure where.

## 🗺️ Roadmap

Planned and in-progress work is tracked in
**[ENHANCEMENT_CHECKLIST.md](ENHANCEMENT_CHECKLIST.md)** (editor blocks like tables
and toggles, object-storage for attachments, real-time collaboration, and more).
