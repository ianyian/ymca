# Analytics & Performance — task checklist

Resumable plan from the GUI/performance/KPI review. Execute top-down; each item is
committed on its own so progress survives an interrupted session.

## Context (important)
- **Three heatmaps in the product:**
  1. **Landing page heatmap** — personal, that user only. *(exists)*
  2. **User settings → right panel heatmap** — personal, 14-day view. *(exists)*
  3. **Admin "all users" heatmap** — aggregate across every user. **NEW — to build.**
- **Retention:** keep raw `ActivityEvent` rows for **6 months (180 days)** — experimental
  phase, we want to trace real activity. Prune anything older.
- Tracking collection + per-user summary bugs were already fixed & deployed
  (commits `d891409`, `17634f8`). Collection verified live.

## Tasks

- [x] **1. ActivityEvent retention — 180 days.** `pruneOldActivity()` +
      `startActivityRetention()` in `activity-buffer.ts` (runs at boot + every 24h,
      unref'd, errors swallowed); wired into `server.ts` start + onClose. Typecheck
      OK, ran clean at boot. 🔴 done.
- [ ] **2. Optimize login waterfall.** Startup is `login → /workspaces → /pages/tree`
      (sequential). Cut a round-trip (return first workspace + tree from login, or
      parallelize). Keep the login-timing metric accurate. 🟢
- [ ] **3. Code-split editor + admin.** `React.lazy` the TipTap editor and the admin
      (CoMa) dashboard so first paint doesn't ship them. Shrinks the ~767 KB single
      chunk. Verify lazy chunks load + Suspense fallbacks. 🟡
- [ ] **4. Admin cross-user heatmap (NEW).** Aggregate-across-all-users click heatmap
      + UX metrics. Data + indexes already support it (EXPLAIN uses
      `ActivityEvent_eventType_createdAt_idx`). Needs:
        - domain fn `getAllUsersActivityHeatmap(window)` (grid from x/y, top targets,
          active users, avg attention) — admin only;
        - admin route (e.g. `GET /admin/analytics/heatmap?window=`);
        - admin dashboard UI panel.
      🟡 larger — build after 1–3.

## Validation per task
- `pnpm --filter @ymca/api typecheck` + `pnpm --filter @ymca/web typecheck`
- For runtime-visible changes: run API+web, drive the flow, confirm in DB/UI.
- Commit + push each task; trigger Render deploy for API-side changes.

## Notes / state
- DB: Neon (pooler). Migration `add_interaction_analytics` applied. Retention needs
  no schema change (pure delete).
- ianyian@gmail.com seeded with 198 demo rows (14 days).
