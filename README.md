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
