# ymca — Notion-style Block Roadmap

Goal: evolve the editor from "rich text with a slash menu" into a true **block
system** — every piece of content is a block you can grab, move like Lego,
restyle, and eventually reference across pages and edit with multiple users —
as shown in Notion's ["Building with blocks"](https://youtu.be/tefoC3wP8n0) video.

**Feasibility verdict: ✅ no rewrite needed.** Content is already stored as
ProseMirror JSON (a tree of block nodes) — the same model Notion-style editors
use. Tiptap (already in use, v2.13) ships every primitive required: drag
handles, unique block IDs, colors, fonts, details/toggle, tables. All verified
available on npm in the 2.x line. What's missing is the block-level **UX**, not
the block **data model**.

Legend — effort: 🟢 small · 🟡 medium · 🔴 large · impact: ⭐ (1–3)

> ⚠️ Recurring constraint: published public pages are rendered server-side by
> `jsonToHtml()` in `apps/api/src/routes/public-page.ts`. **Every new node type,
> mark, or attribute added to the editor needs a matching case there**, or it
> will silently disappear from published pages. Each phase below includes this.

---

## Phase B0 — Already in place (foundation)

- [x] Block-structured content (ProseMirror JSON in `Page.content`)
- [x] Slash `/` menu to insert blocks (text, H1–H3, to-do, lists, quote, callout, code, divider)
- [x] To-do, callout, highlight extensions installed
- [x] Page hierarchy in DB (`parentPageId`) + sidebar tree
- [x] Revisions (last 50 per page) — safety net for all editor work below

## Phase B1 — Block foundation: handles, drag, and identity

*The "Lego" milestone — after this, every block is grabbable and movable.*

- [x] **Unique block IDs** — `@tiptap/extension-unique-id` configured for all
      block types (2026-07-13). IDs persist in saved docs from now on. 🟢 ⭐⭐⭐
- [x] **Hover gutter: `⋮⋮` drag handle + `+` insert button** —
      `@tiptap/extension-drag-handle-react` wired in `App.tsx` (2026-07-13).
      `+` inserts a block below and opens the slash menu. ⚠️ Gotcha discovered:
      DragHandle re-registers its plugin when `onNodeChange`/`tippyOptions`
      props change identity, which destroys ALL plugin views (incl. suggestion
      popups) — they must be `useCallback`/`useMemo`-stable. 🟡 ⭐⭐⭐
- [x] **Drag & drop reordering** — verified live: dragged a block above another,
      order persisted through save/reload. Drop cursor styled with the accent
      color. Hidden on touch (`@media (hover: none)`) for now. 🟡 ⭐⭐⭐
- [ ] **Block menu on handle click** — popup with: **Turn into** (paragraph /
      H1–H3 / lists / quote / callout / code), **Duplicate**, **Delete**,
      **Copy link to block** (uses block ID as `#anchor`). Reuse the
      self-contained popup pattern from `editor-extensions.ts`. 🟡 ⭐⭐⭐
- [ ] **Keyboard block movement** — `Alt+↑` / `Alt+↓` moves the current block
      up/down (`editor.commands` + custom keymap). Cheap, loved by power users. 🟢 ⭐⭐
- [ ] **Block selection state** — clicking the handle selects the whole block
      (`NodeSelection`) with a tinted outline, so Delete/Duplicate/drag have a
      visible target. 🟢 ⭐⭐

## Phase B2 — Text & block styling (color, font, background)

*The user-experience milestone: make content expressive.*

- [ ] **Selection bubble menu** — Tiptap `BubbleMenu`: bold / italic / strike /
      inline code / link / highlight / text color. This also finally exposes the
      already-installed `Highlight` extension (checklist Phase 3 leftover). 🟡 ⭐⭐⭐
- [ ] **Text color** — `@tiptap/extension-text-style` + `@tiptap/extension-color`,
      with a Notion-like fixed palette (10 colors, defined as CSS variables so
      they adapt to light/dark theme). Render the mark in `jsonToHtml()`. 🟢 ⭐⭐⭐
- [ ] **Text background color** — `Highlight` is already installed with
      `multicolor` support; add the palette UI in the bubble menu + block menu.
      Render in `jsonToHtml()`. 🟢 ⭐⭐⭐
- [ ] **Block background color** — global block attribute (custom extension
      adding `backgroundColor` to all block types), settable from the block
      menu ("Color" submenu like Notion). Render in `jsonToHtml()`. 🟡 ⭐⭐
- [ ] **Font family** — `@tiptap/extension-font-family` for inline spans, plus
      Notion-style **per-page font presets** (Default / Serif / Mono) stored
      next to the existing per-user font-size setting. 🟢 ⭐
- [ ] **Publish-page parity pass** — verify each of the above renders correctly
      on published pages in both publish themes; add tests for `jsonToHtml()`. 🟢 ⭐⭐

## Phase B3 — More structural blocks

- [ ] **Toggle (collapsible) block** — `@tiptap/extension-details` (2.x). Was
      already on the wishlist; the drag handle must treat the whole toggle as
      one unit. 🟡 ⭐⭐
- [ ] **Table block** — `@tiptap/extension-table` + row/col controls in the
      block menu. Published-page rendering + horizontal scroll on mobile. 🔴 ⭐⭐
- [x] **Columns (side-by-side layout)** — custom `columnList`/`column` nodes
      landed early (2026-07-13): slash items "2 columns"/"3 columns", cursor
      lands in the first column, blocks can be dragged into columns, columns
      stack vertically on phones, rendered on published pages. Still open:
      drag-a-block-to-page-edge to *create* a column (Notion's gesture). 🔴 ⭐⭐

## Phase B4 — Pages as blocks (references)

*The knowledge-graph milestone the video emphasizes: pages inside pages.*

- [x] **Inline page mention (`@page`)** — landed 2026-07-13: `@` triggers a
      popup (searches via `/search` API, falls back to the loaded tree); inserts
      a `pageRef` inline node rendered as icon+title chip; click navigates
      (window event → `handleSelectPage`). Also insertable via slash menu
      ("Page reference"). Note: title/icon are snapshotted at insert time —
      renames don't propagate yet (needs render-time resolution later). 🟡 ⭐⭐⭐
- [ ] **Sub-page block** — slash-menu "Page" item: creates a child page
      (existing `parentPageId` + tree API already support this!) and inserts a
      page-link block. The sidebar tree already shows nesting. 🟡 ⭐⭐⭐
- [ ] **Backlinks ("Linked from")** — on save, extract `pageRef` node IDs from
      content into a `PageLink(fromPageId, toPageId)` table; show a "Linked
      from N pages" panel under the title. 🟡 ⭐⭐
- [x] **Page mentions on published pages** — `jsonToHtml()` renders the chip as
      inert text (icon + underlined title, no link), so private targets are
      never linked. Columns render as flex + stack on small screens. (Code in
      `public-page.ts`; activates on next API deploy.) 🟢 ⭐⭐ (security-relevant)

## Phase B5 — Blocks with multiple users

*Do this last — everything above works within the current save model.*

- [ ] **Step 1 (cheap, do soon): conflict guard** — optimistic concurrency:
      save sends the `updatedAt` it loaded; API rejects if newer exists; UI
      offers reload-vs-overwrite. Prevents silent last-write-wins damage that
      page-level sharing already makes possible **today**. 🟢 ⭐⭐⭐
- [ ] **Step 2: presence** — lightweight "who's viewing" via polling or SSE
      (avatar row like Notion), no doc sync yet. 🟡 ⭐
- [ ] **Step 3: real-time co-editing** — Yjs + `@tiptap/extension-collaboration`
      + a Hocuspocus websocket service (new deployable next to the API; Render
      supports websockets). Auth handshake reuses the session cookie; persist
      Yjs updates to Postgres; keep JSON snapshots for revisions/publish.
      This **changes the storage model** — plan a migration window. 🔴 ⭐⭐⭐
- [ ] **Step 4: collaboration cursors + per-block comments** — cursor/name
      overlays (`collaboration-cursor`), then threaded comments anchored to
      block IDs from Phase B1 (this is why IDs come first). 🔴 ⭐⭐

## Phase B6 — External-integration blocks (explicitly deferred)

- [ ] Web bookmark block (URL → title/favicon preview card)
- [ ] Embed blocks (YouTube, Figma, Google Maps, …)
- [ ] Synced blocks (same block content mirrored across pages)

---

### Suggested build order & rough sizing

| Milestone | Contents | Rough effort |
|---|---|---|
| M1 "Lego" | Phase B1 complete | ~1 week |
| M2 "Color" | Phase B2 complete | ~1 week |
| M3 "Structure" | Toggle + table (columns optional) | 1–2 weeks |
| M4 "Web of pages" | Phase B4 complete | ~1 week |
| M5 "Together" | B5 steps 1–2 quickly; step 3–4 as a dedicated project | 3–4 weeks |

_Created 2026-07-13 from the block-editor evaluation. Update checkboxes as work lands._
