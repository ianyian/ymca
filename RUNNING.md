# Running the YMCA solution locally

This guide explains where to run each service and the minimum steps needed to bring the solution online.

## Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL running locally on port `5432`

## Quick Start (PowerShell — one-time setup)

Open **two separate PowerShell windows** and run one command in each:

**Window 1 — API:**
```powershell
cd C:\Projects\Git\ymca\apps\api
npm run dev
```

**Window 2 — Frontend:**
```powershell
cd C:\Projects\Git\ymca\apps\web
npm run dev -- --host 0.0.0.0
```

Then open: **http://localhost:5173**

> ⚠️ The `--host 0.0.0.0` flag ensures Vite binds to IPv4. Without it, the app may not be reachable via `127.0.0.1`.

## Default login for testing

```text
Email:    test@ymca.dev
Password: Test1234!
```

## Service URLs

| Service    | URL                        |
|------------|----------------------------|
| Frontend   | http://localhost:5173       |
| API        | http://localhost:4000       |
| PostgreSQL | localhost:5432 / db: ymca  |

## Features

- **Document Hub** — home view showing all pages in a table with tags and last-modified date
- **Page editor** — Notion-style block editor with auto-save every 1.8 seconds
- **Emoji icon picker** — click the icon area above the title to set/change an emoji icon
- **Tags/Categories** — add colored category tags to any page; filter by tag in Document Hub
- **Themes** — Light, Dark, Muji (warm), VS Code (dark, monospaced) — bottom-left of sidebar
- **Font size** — Small / Normal / Large — bottom-left of sidebar
- **Search** — Ctrl+K to open full-text search
- **Page history** — click "History" button in top-right to view/restore revisions
- **Publish** — click "Publish" to generate a public shareable link (with tags shown)
- **Trash** — delete pages move to trash; restore from the sidebar trash panel

## Notes

- The web app talks to the API at `http://localhost:4000`.
- The API uses cookie-based auth with CSRF protection.
- Auto-save fires 1.8 seconds after the last keystroke.
- If the API process dies, just restart with `npm run dev` in `apps/api`.

## Setup and migration (first-time only)

### Database setup

```sql
CREATE USER admin WITH PASSWORD 'admin' CREATEDB;
CREATE DATABASE ymca OWNER admin;
```

`apps/api/.env`:
```env
DATABASE_URL=postgresql://admin:admin@localhost:5432/ymca
PORT=4000
NODE_ENV=development
```

### Install dependencies

```bash
pnpm install
```

### Apply database migrations

```bash
cd apps/api
pnpm prisma:migrate
```

