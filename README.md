# ymca Monorepo

Workspace layout:

- apps/web: React frontend
- apps/api: Fastify backend
- apps/desktop: Tauri wrapper
- packages/shared-types: shared TypeScript models
- packages/shared-config: shared configs
- infra: deployment and local infra assets

## Quick start

1. Install deps:
   pnpm install
2. Run all apps/packages with dev scripts:
   pnpm dev

## Public demo / Neon setup

If you want other team members to try the app from GitHub Codespaces or a hosted demo, keep the database connection in environment variables, not in the repo.

## GitHub Codespaces

This repository now includes a devcontainer so GitHub users can open it in Codespaces and run the app without local setup.

Steps:

1. Put your Neon values in Codespaces secrets or in `apps/api/.env` if you are running locally.
2. Open the repo in Codespaces.
3. Run `pnpm dev` from the repo root.
4. Open the forwarded web port in the browser.

Recommended variables:

- `apps/api/.env`
   - `DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5433/ymca?sslmode=disable`
   - `NEON_PROXY_HOST=your-neon-hostname`
   - `NEON_PROXY_LOCAL_PORT=5433`
- `apps/web/.env`
   - `VITE_API_URL=http://localhost:4000` for local dev
   - set it to the deployed API URL for a public demo

The Neon password, host, and full database URL should live in GitHub Secrets, Codespaces secrets, or your deployment platform's secret store. Do not commit them to git.

For a local demo with Neon, start the API first so the proxy can connect, then start the web app.

## GitHub Pages frontend

This repo is set up so the frontend can be published to GitHub Pages at `/ymca/`.

Before the Pages workflow can work, set a GitHub repository variable named `VITE_API_URL` to your Render API URL, for example `https://your-api.onrender.com`.

The deploy workflow publishes the built app to a `gh-pages` branch. In GitHub Pages settings, choose:

- Source: `Deploy from a branch`
- Branch: `gh-pages`
- Folder: `/(root)`

If the `gh-pages` branch does not appear yet, run the `Deploy Web` workflow once from the Actions tab.

Then GitHub Actions will build `apps/web` and publish the static site from `apps/web/dist`.

## Reusable API tests (Phase 1 and later phases)

- Run from repo root:
  - npm --prefix apps/api run test

This suite is intended to be rerun in Phase 2+ to guard:
- workspace slug normalization/validation
- optimistic versioning conflict rules
- session token hashing/token generation invariants

## Development progress tracking

- Progress file: `project-progress.json` (repo root)
- Key field: `overallEstimatedCompletionPercent`
- Phase-level status and notes are in the `phases` array
- Update this file whenever scope-complete work is merged
