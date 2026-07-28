import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditorContent,
  Node as TipTapNode,
  mergeAttributes,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import UniqueID from "@tiptap/extension-unique-id";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { EditorView } from "@tiptap/pm/view";
import { Bar, Line } from "react-chartjs-2";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import {
  Callout,
  Column,
  ColumnList,
  PAGE_REF_OPEN_EVENT,
  PageRef,
  PageRefSuggestion,
  SlashCommand,
  SLASH_ITEMS,
  setPageSearchProvider,
  type PageRefItem,
} from "./editor-extensions";
import { AT, LangContext, LANGUAGES, T, useT, type Lang } from "./i18n";

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler, Tooltip, Legend);

// ────────────────────────────────────────────────────────────
// App version — hardcoded. Bump these two values on an official release.
// ────────────────────────────────────────────────────────────
const APP_VERSION = "0.1";
const APP_RELEASE_DATE = "Jul 11, 2026";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

type Theme = "light" | "dark" | "muji" | "vscode";
type FontSize = "small" | "normal" | "large";

type SessionUser = {
  id: string;
  email: string;
  displayName: string | null;
  language?: string;
  // Global app role (CoMa/Configuration Manager access). Provided by the API.
  appRoleKey?: string;
  appRoleRank?: number;
};
type Workspace = { id: string; name: string; slug: string; role: string };
type PageNode = {
  id: string;
  title: string;
  icon: string | null;
  version: number;
  tags: string[];
  parentPageId: string | null;
  deletedAt: string | null;
  updatedAt: string;
  isStarred?: boolean;
  children: PageNode[];
};
type PageDetail = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  content: Record<string, unknown>;
  version: number;
  isPublished: boolean;
  publishedAt: string | null;
  publishToken: string | null;
  workspaceId: string;
  deletedAt: string | null;
  updatedAt: string;
};
type Revision = {
  id: string;
  version: number;
  createdBy: string | null;
  createdAt: string;
};
type VersionLogEntry = {
  id: string;
  title: string;
  summary: string;
  bullets?: string[];
  publishedAt: string;
};
type UserActivityHeatmapCell = { date: string; count: number };
type UserActivityTarget = { label: string; count: number };
type UserActivityDayHighlight = { date: string; topTargets: UserActivityTarget[] };
type UserActivityRecentEvent = {
  createdAt: string;
  eventType: string;
  target: string | null;
  pageId: string | null;
  durationMs: number | null;
};
type UserActivitySummary = {
  window: "24h" | "7d" | "14d" | "30d" | "365d" | "1825d";
  generatedAt: string;
  isSynthetic: boolean;
  totalEvents: number;
  clickEvents: number;
  dwellMs: number;
  scrollDepthMax: number;
  scrollDepthAvg: number;
  attentionScore: number;
  uniquePages: number;
  heatmap: UserActivityHeatmapCell[];
  clickHeatmap: number[][];
  clickHeatmapTotal: number;
  topTargets: UserActivityTarget[];
  dayHighlights: UserActivityDayHighlight[];
  recentEvents: UserActivityRecentEvent[];
};
type AnalyticsEventPayload = {
  eventType: string;
  target?: string | null;
  pageId?: string | null;
  x?: number | null;
  y?: number | null;
  durationMs?: number | null;
};

// ────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────

const API = (
  import.meta.env.VITE_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:4000`
).replace(/\/$/, "");

// Matches Tailwind's `md` breakpoint; evaluated at call time so rotation/resize is respected
const isMobileViewport = () => window.matchMedia("(max-width: 767px)").matches;

// Module-level lang ref so api() can return translated errors without needing React context
let _currentLang: Lang = (localStorage.getItem("ymca_lang") as Lang) ?? "en";
export function _setApiLang(l: Lang) {
  _currentLang = l;
}

// Bearer session token. The primary auth path in production: the web app
// (github.io) and API (onrender.com) are cross-site, so the session cookie is a
// third-party cookie that Safari/iOS blocks outright and Chrome increasingly
// restricts. Sending the token explicitly keeps auth working everywhere. The
// httpOnly cookie is still set and honored as a fallback where it's allowed.
const TOKEN_KEY = "ymca_token";
let _authToken: string | null = localStorage.getItem(TOKEN_KEY);
export function setAuthToken(token: string | null) {
  _authToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Called when an authenticated request comes back 401 (session/token no longer
// valid). The App registers a handler that drops to the login screen, so an
// expired session can't leave the user in a broken "looks logged-in" state where
// actions like uploads silently fail.
let _onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  _onUnauthorized = fn;
}

// ── Transaction-monitor instrumentation ─────────────────────────────────────
// `_capturedActions` counts every analytics action captured (for the live
// per-second chart); `_apiSuccessListeners` pulse the "transaction" light bulb
// whenever an API request completes successfully.
let _capturedActions = 0;
let _totalCapturedActions = 0;
function recordCapturedAction() {
  _capturedActions += 1;
  _totalCapturedActions += 1;
}
function drainCapturedActions(): { perTick: number; total: number } {
  const perTick = _capturedActions;
  _capturedActions = 0;
  return { perTick, total: _totalCapturedActions };
}
// Listeners get the request path + method so the monitor can flag specific kinds
// of traffic (e.g. page-content autosaves) with their own colour.
type ApiSuccessListener = (path: string, method: string) => void;
const _apiSuccessListeners = new Set<ApiSuccessListener>();
function onApiSuccess(fn: ApiSuccessListener): () => void {
  _apiSuccessListeners.add(fn);
  return () => _apiSuccessListeners.delete(fn);
}
function emitApiSuccess(path: string, method: string) {
  _apiSuccessListeners.forEach((fn) => fn(path, method));
}

async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
  csrf?: string,
): Promise<T> {
  const h = new Headers(init.headers);
  if (init.body && !h.has("content-type"))
    h.set("content-type", "application/json");
  if (csrf) h.set("x-csrf-token", csrf);
  if (_authToken) h.set("authorization", `Bearer ${_authToken}`);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      credentials: "include",
      headers: h,
    });
  } catch {
    throw new Error(T[_currentLang].errNetwork);
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as {
      message?: string;
      code?: string;
      retryAfter?: number;
    } | null;
    if (res.status === 429) {
      const raw = b?.retryAfter ?? Number(res.headers.get("retry-after"));
      // Server always sends retryAfter; fall back to the window length if absent.
      const retry = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 30;
      throw new Error(
        T[_currentLang].errRateLimited.replace("{s}", String(retry)),
      );
    }
    if (res.status === 413) throw new Error(T[_currentLang].err413);
    if (res.status === 401) {
      // Wrong email/password on a login attempt is a normal 401 — don't treat it
      // as an expired session. Fire-and-forget background calls (analytics) also
      // shouldn't force a logout on a transient hiccup. Any other 401 means the
      // session/token is invalid, so clear it and drop to the login screen.
      if (b?.code !== "INVALID_CREDENTIALS" && !path.startsWith("/analytics/")) {
        setAuthToken(null);
        _onUnauthorized?.();
      }
      throw new Error(
        b?.code === "INVALID_CREDENTIALS"
          ? T[_currentLang].errInvalidCredentials
          : T[_currentLang].err401,
      );
    }
    if (res.status === 403)
      throw new Error(b?.message ?? T[_currentLang].err403);
    if (res.status === 404)
      throw new Error(b?.message ?? T[_currentLang].err404);
    if (res.status >= 500) throw new Error(T[_currentLang].err500);
    throw new Error(b?.message ?? `Error ${res.status}`);
  }
  // Count every successful API call as a transaction (drives the chart) and
  // pulse the transaction-monitor light bulb.
  recordCapturedAction();
  emitApiSuccess(path, (init.method ?? "GET").toUpperCase());
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ────────────────────────────────────────────────────────────
// Tag colour system (deterministic hash → palette)
// ────────────────────────────────────────────────────────────

const TAG_PALETTE = [
  { bg: "rgba(35,131,226,0.15)", fg: "#2383e2", dark_fg: "#7ec0f5" },
  { bg: "rgba(66,166,96,0.18)", fg: "#2d8a2d", dark_fg: "#6dcf7a" },
  { bg: "rgba(200,117,51,0.18)", fg: "#b85c00", dark_fg: "#f0a050" },
  { bg: "rgba(127,63,191,0.18)", fg: "#7030a0", dark_fg: "#c07fef" },
  { bg: "rgba(208,48,48,0.15)", fg: "#c02020", dark_fg: "#f08080" },
  { bg: "rgba(19,152,127,0.18)", fg: "#0d7a63", dark_fg: "#50d4b8" },
  { bg: "rgba(183,59,126,0.15)", fg: "#a0306a", dark_fg: "#e888b8" },
  { bg: "rgba(120,120,120,0.12)", fg: "#5a5a5a", dark_fg: "#b0b0b0" },
];

function tagColor(tag: string, isDark: boolean) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = tag.charCodeAt(i) + ((h << 5) - h);
  const p = TAG_PALETTE[Math.abs(h) % TAG_PALETTE.length]!;
  return { bg: p.bg, fg: isDark ? p.dark_fg : p.fg };
}

function formatVersionLogTimestamp(iso: string) {
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

// Compact, language-neutral "last updated" for search results: now / 5m / 3h /
// 6d for recent edits, then a short absolute date. Lets the user gauge freshness
// before opening a result.
function formatSearchUpdated(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function isAnalyticsInteractiveTarget(node: Element | null): boolean {
  return !!node && !!node.closest("button, a, [role='button'], [data-analytics-zone]");
}

function clampAnalyticsLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function formatActivityDayTooltip(
  cell: UserActivityHeatmapCell,
  highlights: UserActivityTarget[] = [],
) {
  const date = new Date(`${cell.date}T00:00:00`);
  const lines = [
    date.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
    `${cell.count} actions`,
  ];
  if (highlights.length > 0) {
    lines.push("Top events:");
    for (const target of highlights.slice(0, 3)) {
      lines.push(`- ${target.label} (${target.count})`);
    }
  }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// SVG Icons
// ────────────────────────────────────────────────────────────

const Ico = {
  Search: () => (
    <svg
      width='14'
      height='14'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='11' cy='11' r='8' />
      <path d='m21 21-4.35-4.35' />
    </svg>
  ),
  Plus: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M12 5v14M5 12h14' />
    </svg>
  ),
  Calendar: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <rect x='3' y='5' width='18' height='16' rx='2' />
      <path d='M16 3v4M8 3v4M3 11h18' />
    </svg>
  ),
  // Star: filled gold when starred, otherwise an outline "frame" (no fill),
  // matching the Gmail-style star toggle.
  Star: ({ filled }: { filled?: boolean }) => (
    <svg
      width='15'
      height='15'
      viewBox='0 0 24 24'
      fill={filled ? "#f5c518" : "none"}
      stroke={filled ? "#e6a700" : "currentColor"}
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z' />
    </svg>
  ),
  ChevR: () => (
    <svg
      width='11'
      height='11'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='m9 18 6-6-6-6' />
    </svg>
  ),
  ChevD: () => (
    <svg
      width='11'
      height='11'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='m6 9 6 6 6-6' />
    </svg>
  ),
  Sort: () => (
    <svg
      width='11'
      height='11'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      viewBox='0 0 24 24'
    >
      <path d='M7 5v14' />
      <path d='m4 8 3-3 3 3' />
      <path d='m17 19 3-3 3 3' />
      <path d='M17 5v14' />
    </svg>
  ),
  Page: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
      <polyline points='14,2 14,8 20,8' />
    </svg>
  ),
  Trash: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <polyline points='3,6 5,6 21,6' />
      <path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' />
    </svg>
  ),
  Clock: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='12' cy='12' r='10' />
      <polyline points='12,6 12,12 16,14' />
    </svg>
  ),
  Globe: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='12' cy='12' r='10' />
      <line x1='2' y1='12' x2='22' y2='12' />
      <path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' />
    </svg>
  ),
  Link: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' />
      <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' />
    </svg>
  ),
  X: () => (
    <svg
      width='12'
      height='12'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M18 6L6 18M6 6l12 12' />
    </svg>
  ),
  Check: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <polyline points='20,6 9,17 4,12' />
    </svg>
  ),
  User: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' />
      <circle cx='12' cy='7' r='4' />
    </svg>
  ),
  Tag: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z' />
      <line x1='7' y1='7' x2='7.01' y2='7' />
    </svg>
  ),
  Sun: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='12' cy='12' r='5' />
      <line x1='12' y1='1' x2='12' y2='3' />
      <line x1='12' y1='21' x2='12' y2='23' />
      <line x1='4.22' y1='4.22' x2='5.64' y2='5.64' />
      <line x1='18.36' y1='18.36' x2='19.78' y2='19.78' />
      <line x1='1' y1='12' x2='3' y2='12' />
      <line x1='21' y1='12' x2='23' y2='12' />
      <line x1='4.22' y1='19.78' x2='5.64' y2='18.36' />
      <line x1='18.36' y1='5.64' x2='19.78' y2='4.22' />
    </svg>
  ),
  Moon: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' />
    </svg>
  ),
  Sidebar: () => (
    <svg
      width='15'
      height='15'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <rect x='3' y='3' width='18' height='18' rx='2' />
      <path d='M9 3v18' />
    </svg>
  ),
  Font: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <polyline points='4,7 4,4 20,4 20,7' />
      <line x1='9' y1='20' x2='15' y2='20' />
      <line x1='12' y1='4' x2='12' y2='20' />
    </svg>
  ),
  Grid: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <rect x='3' y='3' width='7' height='7' />
      <rect x='14' y='3' width='7' height='7' />
      <rect x='3' y='14' width='7' height='7' />
      <rect x='14' y='14' width='7' height='7' />
    </svg>
  ),
  Smile: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='12' cy='12' r='10' />
      <path d='M8 14s1.5 2 4 2 4-2 4-2' />
      <line x1='9' y1='9' x2='9.01' y2='9' />
      <line x1='15' y1='9' x2='15.01' y2='9' />
    </svg>
  ),
  ExternalLink: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' />
      <polyline points='15,3 21,3 21,9' />
      <line x1='10' y1='14' x2='21' y2='3' />
    </svg>
  ),
  Settings: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <circle cx='12' cy='12' r='3' />
      <path d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' />
    </svg>
  ),
  Paperclip: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' />
    </svg>
  ),
  Download: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' />
      <polyline points='7,10 12,15 17,10' />
      <line x1='12' y1='15' x2='12' y2='3' />
    </svg>
  ),
  Copy: () => (
    <svg
      width='13'
      height='13'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      viewBox='0 0 24 24'
    >
      <rect x='9' y='9' width='13' height='13' rx='2' />
      <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
    </svg>
  ),
};

// ────────────────────────────────────────────────────────────
// Image upload — store files via the attachment API and embed a URL,
// instead of inlining base64 (which bloats page content + every revision).
// ────────────────────────────────────────────────────────────

const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB (stored in the DB)

async function uploadImageFile(
  file: File,
  pageId: string,
  csrf: string,
): Promise<string> {
  if (file.size > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(T[_currentLang].errImageTooLarge);
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) =>
      resolve(((ev.target?.result as string) ?? "").split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await api<{ url: string }>(
    `/pages/${pageId}/attachments`,
    {
      method: "POST",
      body: JSON.stringify({
        filename: file.name || "pasted-image.png",
        mimetype: file.type || "image/png",
        content: base64,
      }),
    },
    csrf,
  );
  // The API returns a root-relative capability URL; make it absolute.
  return `${API}${res.url}`;
}

// ────────────────────────────────────────────────────────────
// Custom Image TipTap Extension
// ────────────────────────────────────────────────────────────

const ImageExt = TipTapNode.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["img", mergeAttributes({ class: "notion-image" }, HTMLAttributes)];
  },
  addCommands() {
    return {
      setImage:
        (options: { src: string; alt?: string }) =>
        ({
          commands,
        }: {
          commands: { insertContent: (value: unknown) => unknown };
        }) =>
          commands.insertContent({ type: "image", attrs: options }),
    };
  },
} as any);

// ────────────────────────────────────────────────────────────
// Emoji Icon Picker
// ────────────────────────────────────────────────────────────

const EMOJI_GROUPS = [
  {
    label: "Common",
    emojis: [
      "📄",
      "📝",
      "📋",
      "📊",
      "📈",
      "📌",
      "🗂️",
      "📁",
      "🗒️",
      "📒",
      "📓",
      "📔",
      "📕",
      "📗",
      "📘",
      "📙",
      "🔖",
      "🏷️",
    ],
  },
  {
    label: "People",
    emojis: [
      "😀",
      "😊",
      "🤔",
      "💡",
      "🎯",
      "🏆",
      "🌟",
      "✨",
      "🔥",
      "💪",
      "👍",
      "🙌",
      "🤝",
      "👋",
      "💬",
      "🗣️",
      "👁️",
      "🧠",
    ],
  },
  {
    label: "Nature",
    emojis: [
      "🌱",
      "🌿",
      "🍃",
      "🌸",
      "🌺",
      "🌻",
      "🌈",
      "⭐",
      "🌙",
      "☀️",
      "❄️",
      "🌊",
      "🏔️",
      "🌲",
      "🍀",
      "🦋",
      "🐉",
      "🌍",
    ],
  },
  {
    label: "Objects",
    emojis: [
      "💻",
      "📱",
      "🖥️",
      "⌨️",
      "🖱️",
      "📡",
      "🔑",
      "🔒",
      "🔓",
      "🔧",
      "🔨",
      "⚙️",
      "🗓️",
      "📅",
      "⏰",
      "🎨",
      "🎭",
      "🔮",
    ],
  },
  {
    label: "Symbols",
    emojis: [
      "✅",
      "❌",
      "⚡",
      "💥",
      "🎉",
      "🎊",
      "🚀",
      "🛡️",
      "⚔️",
      "🔔",
      "📢",
      "💎",
      "🏅",
      "🎖️",
      "🏵️",
      "🎗️",
      "🌀",
      "♾️",
    ],
  },
  {
    label: "Food",
    emojis: [
      "☕",
      "🍵",
      "🧃",
      "🍎",
      "🍊",
      "🥦",
      "🍕",
      "🎂",
      "🍰",
      "🧁",
      "🍫",
      "🥗",
      "🍜",
      "🌮",
      "🍣",
      "🍛",
      "🥘",
      "🍱",
    ],
  },
];

function EmojiPicker({
  current,
  onSelect,
  onRemove,
}: {
  current: string | null;
  onSelect: (e: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (
        ref.current &&
        e.target instanceof Node &&
        !ref.current.contains(e.target)
      )
        setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const allEmojis = EMOJI_GROUPS.flatMap((g) => g.emojis);
  const filtered = search ? allEmojis.filter((e) => e.includes(search)) : null;

  return (
    <div className='relative inline-block' ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className='group flex items-center justify-center rounded-lg transition-all'
        style={{ width: 60, height: 60 }}
        title={current ? "Change icon" : "Add icon"}
      >
        {current ? (
          <span className='text-5xl leading-none select-none'>{current}</span>
        ) : (
          <span
            className='text-[12px] opacity-0 group-hover:opacity-60 transition-opacity select-none px-2 py-1 rounded'
            style={{ color: "var(--text-muted)" }}
          >
            {t.addIcon}
          </span>
        )}
      </button>

      {open && (
        <div
          className='absolute left-0 top-full mt-1 z-50 rounded-xl shadow-2xl border overflow-hidden'
          style={{
            background: "var(--bg-primary)",
            borderColor: "var(--border-color)",
            width: 280,
          }}
        >
          <div
            className='px-3 pt-3 pb-2 border-b'
            style={{ borderColor: "var(--border-color)" }}
          >
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchEmoji}
              className='w-full text-[12px] px-2.5 py-1.5 rounded-[6px] outline-none border'
              style={{
                background: "var(--bg-hover)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div className='overflow-y-auto' style={{ maxHeight: 240 }}>
            {filtered ? (
              <div className='flex flex-wrap gap-0.5 p-2'>
                {filtered.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      onSelect(e);
                      setOpen(false);
                      setSearch("");
                    }}
                    className='text-xl p-1.5 rounded-[4px] leading-none hover:bg-[var(--bg-hover)] transition-colors'
                  >
                    {e}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p
                    className='text-xs w-full text-center py-3'
                    style={{ color: "var(--text-muted)" }}
                  >
                    No results
                  </p>
                )}
              </div>
            ) : (
              EMOJI_GROUPS.map((g) => (
                <div key={g.label} className='px-2 pt-2 pb-1'>
                  <p
                    className='text-[10px] font-semibold uppercase tracking-wider mb-1 px-1'
                    style={{ color: "var(--text-muted)" }}
                  >
                    {g.label}
                  </p>
                  <div className='flex flex-wrap gap-0.5'>
                    {g.emojis.map((e) => (
                      <button
                        key={e}
                        onClick={() => {
                          onSelect(e);
                          setOpen(false);
                        }}
                        className='text-xl p-1.5 rounded-[4px] leading-none hover:bg-[var(--bg-hover)] transition-colors'
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          {current && (
            <div
              className='border-t p-2'
              style={{ borderColor: "var(--border-color)" }}
            >
              <button
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
                className='w-full text-[12px] py-1.5 rounded-[6px] text-center transition-colors'
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                {t.removeIcon}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Tag Badge
// ────────────────────────────────────────────────────────────

function TagBadge({
  tag,
  isDark,
  onRemove,
}: {
  tag: string;
  isDark: boolean;
  onRemove?: () => void;
}) {
  const { bg, fg } = tagColor(tag, isDark);
  return (
    <span
      className='inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 leading-none whitespace-nowrap'
      style={{ background: bg, color: fg }}
    >
      {tag}
      {onRemove && (
        <button
          onClick={onRemove}
          className='opacity-60 hover:opacity-100 transition-opacity ml-0.5 -mr-0.5'
        >
          <Ico.X />
        </button>
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────
// Tag Editor (inline add/remove tags)
// ────────────────────────────────────────────────────────────

function TagEditor({
  tags,
  isDark,
  onChange,
}: {
  tags: string[];
  isDark: boolean;
  onChange: (t: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag || tags.includes(tag) || tags.length >= 20) return;
    onChange([...tags, tag]);
    setInput("");
  }

  return (
    <div className='flex flex-wrap items-center gap-1.5 min-h-[26px]'>
      {tags.map((tag) => (
        <TagBadge
          key={tag}
          tag={tag}
          isDark={isDark}
          onRemove={() => onChange(tags.filter((t) => t !== tag))}
        />
      ))}
      {editing ? (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(input);
            }
            if (e.key === "Escape") {
              setEditing(false);
              setInput("");
            }
            if (e.key === "Backspace" && !input && tags.length)
              onChange(tags.slice(0, -1));
          }}
          onBlur={() => {
            if (input) addTag(input);
            setEditing(false);
          }}
          placeholder='Add tag...'
          autoFocus
          className='text-[11px] px-2 py-0.5 rounded-full border outline-none'
          style={{
            background: "var(--bg-hover)",
            borderColor: "var(--accent-color)",
            color: "var(--text-primary)",
            minWidth: 80,
            maxWidth: 120,
          }}
        />
      ) : (
        <button
          onClick={() => {
            setEditing(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className='inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-dashed transition-colors'
          style={{
            borderColor: "var(--border-color)",
            color: "var(--text-muted)",
          }}
          title='Add category'
        >
          <Ico.Plus /> Add tag
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Page Tree Node
// ────────────────────────────────────────────────────────────

function PageTreeNode({
  node,
  depth,
  activePageId,
  isDark,
  onSelect,
  onNewChild,
  onDelete,
}: {
  node: PageNode;
  depth: number;
  activePageId: string | null;
  isDark: boolean;
  onSelect: (id: string) => void;
  onNewChild: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const [hovered, setHovered] = useState(false);
  const active = node.id === activePageId;
  const hasKids = node.children.length > 0;

  return (
    <div>
      <div
        className='relative group'
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          onClick={() => onSelect(node.id)}
          className='w-full flex items-center gap-0.5 rounded-[4px] py-[3px] pr-2 text-left text-sm transition-colors'
          style={{
            paddingLeft: `${6 + depth * 14}px`,
            background: active
              ? "var(--bg-active)"
              : hovered
                ? "var(--bg-hover)"
                : "transparent",
            color: "var(--text-primary)",
            fontWeight: active ? 500 : 400,
          }}
        >
          <span
            className='w-5 h-5 flex items-center justify-center shrink-0 rounded-[3px] transition-colors'
            style={{ color: hovered ? "var(--text-muted)" : "transparent" }}
            onClick={(e) => {
              e.stopPropagation();
              if (hasKids) setOpen((v) => !v);
            }}
          >
            {hasKids ? open ? <Ico.ChevD /> : <Ico.ChevR /> : null}
          </span>
          <span
            className='w-5 h-5 flex items-center justify-center shrink-0'
            style={{ color: "var(--text-muted)" }}
          >
            {node.icon ? (
              <span className='text-sm leading-none'>{node.icon}</span>
            ) : (
              <Ico.Page />
            )}
          </span>
          <span className='flex-1 truncate ml-0.5 leading-none py-px text-[13px]'>
            {node.title || "Untitled"}
          </span>
        </button>

        {hovered && (
          <div className='absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 z-10'>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.id);
              }}
              className='w-5 h-5 flex items-center justify-center rounded-[3px] transition-colors'
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-active)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Ico.X />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNewChild(node.id);
                setOpen(true);
              }}
              className='w-5 h-5 flex items-center justify-center rounded-[3px] transition-colors'
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-active)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Ico.Plus />
            </button>
          </div>
        )}
      </div>
      {open &&
        node.children.map((c) => (
          <PageTreeNode
            key={c.id}
            node={c}
            depth={depth + 1}
            activePageId={activePageId}
            isDark={isDark}
            onSelect={onSelect}
            onNewChild={onNewChild}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Profile Dropdown (sidebar top)
// ────────────────────────────────────────────────────────────

function ProfileDropdown({
  user,
  workspace,
  theme,
  fontSize,
  isDark,
  csrf,
  lang,
  txMonitor,
  onThemeChange,
  onFontChange,
  onLangChange,
  onTxMonitorChange,
  onOpenFunSettings,
  onLogout,
}: {
  user: { id: string; email: string; displayName: string | null };
  workspace: { name: string } | null;
  theme: Theme;
  fontSize: FontSize;
  isDark: boolean;
  csrf: string;
  lang: Lang;
  txMonitor: boolean;
  onThemeChange: (t: Theme) => void;
  onFontChange: (f: FontSize) => void;
  onLangChange: (l: Lang) => void;
  onTxMonitorChange: (v: boolean) => void;
  onOpenFunSettings: () => void;
  onLogout: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [showActivityInsights, setShowActivityInsights] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (
        ref.current &&
        e.target instanceof Node &&
        !ref.current.contains(e.target)
      )
        setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Auto-close shortly after the mouse leaves the button+panel — the short
  // delay (rather than closing instantly) tolerates the cursor briefly
  // crossing the gap between the button and the panel below it. Cancelled on
  // re-entry, and cleared on unmount so it can't fire against a stale panel.
  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 350);
  }
  function cancelScheduledClose() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }
  useEffect(() => () => cancelScheduledClose(), []);

  const initials = (user.displayName ?? user.email).slice(0, 2).toUpperCase();
  const displayName = user.displayName ?? user.email.split("@")[0];

  return (
    <div
      className='relative px-2 pt-2 pb-1'
      ref={ref}
      data-analytics-zone='profile-menu'
      onMouseLeave={() => open && scheduleClose()}
      onMouseEnter={cancelScheduledClose}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className='w-full flex items-center gap-2 px-2 py-2 rounded-[6px] transition-colors text-left'
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {/* Avatar */}
        <div
          className='w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-bold text-white'
          style={{ background: isDark ? "#5b6af5" : "#2383e2" }}
        >
          {initials}
        </div>
        <div className='flex-1 min-w-0'>
          <p
            className='text-[13px] font-semibold truncate leading-tight'
            style={{ color: "var(--text-primary)" }}
          >
            {displayName}
          </p>
          <p
            className='text-[11px] truncate leading-tight'
            style={{ color: "var(--text-muted)" }}
          >
            {workspace?.name ?? "No workspace"}
          </p>
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          <svg
            width='11'
            height='11'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            strokeLinecap='round'
            viewBox='0 0 24 24'
          >
            <path d='m6 9 6 6 6-6' />
          </svg>
        </span>
      </button>

      {open && (
        <div
          className='absolute left-2 right-2 top-full mt-0.5 rounded-xl shadow-2xl border z-50 overflow-hidden'
          style={{
            background: "var(--bg-primary)",
            borderColor: "var(--border-color)",
          }}
        >
          {/* User info header */}
          <div
            className='px-3 py-2.5 border-b'
            style={{ borderColor: "var(--border-color)" }}
          >
            <p
              className='text-[12px] font-semibold'
              style={{ color: "var(--text-primary)" }}
            >
              {displayName}
            </p>
            <p
              className='text-[11px] truncate'
              style={{ color: "var(--text-muted)" }}
            >
              {user.email}
            </p>
          </div>

          {/* Theme */}
          <div className='px-3 pt-2 pb-1'>
            <p
              className='text-[11px] font-semibold mb-1.5'
              style={{ color: "var(--text-muted)" }}
            >
              <span className='flex items-center gap-1'>
                <Ico.Settings /> {t.appearance}
              </span>
            </p>
            <div className='grid grid-cols-2 gap-1 mb-2'>
              {THEMES.map((th) => (
                <button
                  key={th.id}
                  onClick={() => onThemeChange(th.id)}
                  className='flex items-center gap-2 px-2 py-1.5 rounded-[6px] text-[12px] text-left transition-colors'
                  style={{
                    background:
                      theme === th.id ? "var(--bg-active)" : "transparent",
                    color:
                      theme === th.id
                        ? "var(--accent-color)"
                        : "var(--text-primary)",
                    border:
                      theme === th.id
                        ? "1px solid var(--accent-color)"
                        : "1px solid transparent",
                  }}
                >
                  <span
                    className='w-3.5 h-3.5 rounded-full border shrink-0'
                    style={{
                      background: th.dot,
                      borderColor: "var(--border-color)",
                    }}
                  />
                  {th.label}
                  {theme === th.id && (
                    <span className='ml-auto'>
                      <Ico.Check />
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className='space-y-2 mb-1'>
              <label className='flex items-center justify-between gap-2'>
                <span
                  className='text-[11px] font-semibold shrink-0'
                  style={{ color: "var(--text-muted)" }}
                >
                  {t.fontSize}
                </span>
                <select
                  value={fontSize}
                  onChange={(e) => onFontChange(e.target.value as FontSize)}
                  className='min-w-0 flex-1 max-w-[150px] rounded-[6px] border px-2 py-1.5 text-[11px] outline-none'
                  style={{
                    background: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  {FONT_SIZES.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className='flex items-center justify-between gap-2'>
                <span
                  className='text-[11px] font-semibold shrink-0'
                  style={{ color: "var(--text-muted)" }}
                >
                  {t.language}
                </span>
                <select
                  value={lang}
                  onChange={(e) => onLangChange(e.target.value as Lang)}
                  className='min-w-0 flex-1 max-w-[150px] rounded-[6px] border px-2 py-1.5 text-[11px] outline-none'
                  style={{
                    background: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.native}
                    </option>
                  ))}
                </select>
              </label>

              <label className='flex items-center justify-between gap-2 cursor-pointer'>
                <span
                  className='text-[11px] font-semibold shrink-0'
                  style={{ color: "var(--text-muted)" }}
                >
                  {t.transactionMonitor}
                </span>
                <button
                  type='button'
                  role='switch'
                  aria-checked={txMonitor}
                  onClick={() => onTxMonitorChange(!txMonitor)}
                  className='relative w-9 h-5 rounded-full transition-colors shrink-0'
                  style={{ background: txMonitor ? "var(--accent-color)" : "var(--bg-active)" }}
                >
                  <span
                    className='absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all'
                    style={{ left: txMonitor ? "18px" : "2px" }}
                  />
                </button>
              </label>

              {/* Fun & animation opens its own roomy settings panel. */}
              <button
                type='button'
                onClick={onOpenFunSettings}
                className='flex items-center justify-between gap-2 w-full rounded-[6px] px-2 py-1.5 -mx-1 transition-colors hover:bg-[var(--bg-hover)]'
              >
                <span className='flex items-center gap-2 text-[12px] font-medium' style={{ color: "var(--text-primary)" }}>
                  <span className='flex scale-[0.62] -my-1 -ml-1'>
                    <AnimalSprite type='fish' px={CRITTER_BASE} />
                  </span>
                  {t.funTitle}
                </span>
                <span className='text-[13px]' style={{ color: "var(--text-muted)" }}>
                  ›
                </span>
              </button>
            </div>
          </div>

          {/* Actions */}
          <div
            className='border-t px-2 py-1.5'
            style={{ borderColor: "var(--border-color)" }}
          >
            <button
              onClick={() => {
                setOpen(false);
                setShowActivityInsights(true);
              }}
              className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[6px] text-[13px] transition-colors'
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Ico.Clock />
              <span>{t.myActivity}</span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setShowChangePw(true);
              }}
              className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[6px] text-[13px] transition-colors'
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Ico.Settings />
              <span>{t.changePassword}</span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[6px] text-[13px] transition-colors'
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Ico.X />
              <span>{t.signOut}</span>
            </button>
          </div>
        </div>
      )}
      {showChangePw && (
        <ChangePasswordModal
          csrf={csrf}
          onClose={() => setShowChangePw(false)}
        />
      )}
      {showActivityInsights && (
        <ProfileActivityDrawer
          onClose={() => setShowActivityInsights(false)}
          endpoint='/me/activity'
          title={t.activityHeatmapTitle}
          subtitle={t.activityHeatmapSubtitle}
          isDark={isDark}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Attachment Section
// ────────────────────────────────────────────────────────────

type Attachment = {
  id: string;
  originalName: string;
  mimetype: string;
  size: number;
  createdAt: string;
};

const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function AttachmentSection({ pageId, csrf }: { pageId: string; csrf: string }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAttachments = useCallback(async () => {
    try {
      const r = await api<{ attachments: Attachment[] }>(
        `/pages/${pageId}/attachments`,
        {},
        csrf,
      );
      setAttachments(r.attachments);
    } catch {
      setAttachments([]);
    }
  }, [pageId, csrf]);

  useEffect(() => {
    void loadAttachments();
  }, [loadAttachments]);

  // Shared by the click-to-pick input and drag-and-drop.
  async function uploadFile(file: File) {
    setUploadError(null);
    if (file.size > 25 * 1024 * 1024) {
      setUploadError(`"${file.name}" is ${formatBytes(file.size)} — the limit is 25 MB.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const result = ev.target?.result as string;
          resolve(result.split(",")[1] ?? "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api(
        `/pages/${pageId}/attachments`,
        {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            mimetype: file.type || "application/octet-stream",
            content: base64,
          }),
        },
        csrf,
      );
      await loadAttachments();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  }

  async function handleDelete(attachId: string) {
    try {
      await api(
        `/pages/${pageId}/attachments/${attachId}`,
        { method: "DELETE" },
        csrf,
      );
      setAttachments((prev) => prev.filter((a) => a.id !== attachId));
    } catch {}
  }

  return (
    <div
      className='mt-12 pt-8 border-t'
      style={{ borderColor: "var(--border-color)" }}
    >
      <h3
        className='text-[14px] font-semibold flex items-center gap-1.5 mb-1'
        style={{ color: "var(--text-primary)" }}
      >
        <Ico.Paperclip /> Attachments
        {attachments.length > 0 && (
          <span
            className='text-[12px] font-normal'
            style={{ color: "var(--text-muted)" }}
          >
            ({attachments.length})
          </span>
        )}
      </h3>
      <p className='text-[12px] mb-3' style={{ color: "var(--text-muted)" }}>
        Attach files to this page — PDF, Word, PowerPoint, Excel, images, text or
        markdown, up to 25&nbsp;MB each.
      </p>

      {/* Prominent upload drop-zone so it's easy to notice. Click opens the file
          picker; drag-and-drop also works (a fallback when the picker misbehaves). */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void uploadFile(file);
        }}
        className='w-full flex flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed py-6 transition-colors'
        style={{
          borderColor: dragging ? "var(--accent-color)" : "var(--border-color)",
          background: dragging ? "rgba(35,131,226,0.06)" : "transparent",
          color: "var(--text-muted)",
        }}
        onMouseEnter={(e) =>
          !dragging && (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) =>
          !dragging && (e.currentTarget.style.background = "transparent")
        }
      >
        <Ico.Plus />
        <span className='text-[13px] font-medium'>
          {uploading ? "Uploading…" : "Click to upload a file"}
        </span>
        <span className='text-[11px]'>
          PDF · Word · PPT · Excel · images — up to 25&nbsp;MB
        </span>
      </button>
      {uploadError && (
        <p
          className='text-[12px] mt-2 rounded-[6px] px-3 py-2'
          style={{ background: "rgba(200,48,48,0.08)", color: "#c03030" }}
        >
          {uploadError}
        </p>
      )}
      <input
        ref={fileInputRef}
        type='file'
        className='hidden'
        accept={ALLOWED_TYPES.join(",")}
        onChange={handleFileSelect}
      />

      <div className='space-y-1.5 mt-3'>
        {attachments.map((att) => (
          <div
            key={att.id}
            className='flex items-center gap-3 px-3 py-2 rounded-[8px] border group transition-colors'
            style={{
              borderColor: "var(--border-color)",
              background: "var(--bg-secondary)",
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>
              <Ico.Paperclip />
            </span>
            <span
              className='flex-1 text-[13px] truncate'
              style={{ color: "var(--text-primary)" }}
            >
              {att.originalName}
            </span>
            <span
              className='text-[11px] shrink-0'
              style={{ color: "var(--text-muted)" }}
            >
              {formatBytes(att.size)}
            </span>
            <a
              href={`${API}/pages/${pageId}/attachments/${att.id}/download`}
              download={att.originalName}
              className='p-1 rounded-[4px] opacity-0 group-hover:opacity-100 transition-opacity'
              style={{ color: "var(--text-muted)" }}
              title='Download'
            >
              <Ico.Download />
            </a>
            <button
              onClick={() => void handleDelete(att.id)}
              className='p-1 rounded-[4px] opacity-0 group-hover:opacity-100 transition-opacity'
              style={{ color: "var(--text-muted)" }}
              title='Remove'
            >
              <Ico.X />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Document Hub (home view — table of all pages with tags)
// ────────────────────────────────────────────────────────────

function flattenTree(nodes: PageNode[]): PageNode[] {
  const result: PageNode[] = [];
  function walk(ns: PageNode[]) {
    for (const n of ns) {
      if (!n.deletedAt) {
        result.push(n);
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return result;
}

// Compact "getting started" card shown BELOW the Document Hub table.
function activityHeatmapIntensity(count: number) {
  if (count <= 0) return "rgba(35,131,226,0.04)";
  if (count <= 1) return "rgba(35,131,226,0.12)";
  if (count <= 3) return "rgba(35,131,226,0.22)";
  if (count <= 6) return "rgba(35,131,226,0.34)";
  return "rgba(35,131,226,0.48)";
}

function activityHeatmapCellStyle(count: number) {
  // Empty days get a barely-there, theme-aware tint (no border/inset ring) so an
  // inactive grid reads as a subtle heatmap rather than a block of grey boxes.
  // Days with activity keep the blue ramp plus a crisp edge for definition.
  if (count <= 0) {
    return {
      background: "var(--heatmap-empty)",
      borderColor: "transparent",
      boxShadow: "none",
    } as const;
  }
  return {
    background: activityHeatmapIntensity(count),
    borderColor: "var(--border-color)",
    boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.16)",
  } as const;
}

const HEATMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
// UTC "YYYY-MM-DD" — matches the date keys the API emits (server runs in UTC), so
// grid lookups line up regardless of the viewer's timezone. (The old builder mixed
// local-parsed dates with toISOString() keys, which dropped days in UTC+ zones.)
const utcDayKey = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

// Build a GitHub-style week grid (columns = weeks, rows = Sun..Sat) covering the
// inclusive UTC day range [rangeStart, rangeEnd]. Days outside the range (grid
// padding) are null; days inside get their count from `byDate` (0 when absent).
function buildHeatmapWeeks(
  byDate: Map<string, number>,
  rangeStart: Date,
  rangeEnd: Date,
): { weeks: Array<Array<UserActivityHeatmapCell | null>>; monthLabels: string[]; total: number } {
  const gridStart = new Date(rangeStart);
  gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
  const gridEnd = new Date(rangeEnd);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - gridEnd.getUTCDay()));

  const weeks: Array<Array<UserActivityHeatmapCell | null>> = [];
  const monthLabels: string[] = [];
  let week: Array<UserActivityHeatmapCell | null> = [];
  let prevMonth = "";
  let total = 0;
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    if (cursor >= rangeStart && cursor <= rangeEnd) {
      const key = utcDayKey(cursor);
      const count = byDate.get(key) ?? 0;
      total += count;
      week.push({ date: key, count });
    } else {
      week.push(null);
    }
    if (week.length === 7) {
      const firstCell = week.find((cell) => cell != null) ?? null;
      let label = "";
      if (firstCell) {
        const month = HEATMAP_MONTHS[Number(firstCell.date.slice(5, 7)) - 1] ?? "";
        if (month !== prevMonth) {
          label = month;
          prevMonth = month;
        }
      }
      monthLabels.push(label);
      weeks.push(week);
      week = [];
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { weeks, monthLabels, total };
}

function ActivityContributionHeatmap({
  summary,
  mobile = false,
}: {
  summary: UserActivitySummary;
  mobile?: boolean;
}) {
  // Rolling 12-month window. offset 0 = the last 12 months ending today (e.g. Jul
  // 2025 → Jul 2026); each "back" step shifts the whole window one year earlier
  // (Jul 2024 → Jul 2025, …). Data is fetched for 5 years, so we page back up to 4.
  const MAX_BACK = 4;
  const [yearOffset, setYearOffset] = useState(0);
  // Mobile shows the same 12-month view but without paging controls.
  const offset = mobile ? 0 : yearOffset;

  const byDate = useMemo(
    () => new Map(summary.heatmap.map((cell) => [cell.date, cell.count])),
    [summary.heatmap],
  );
  const dayHighlights = useMemo(
    () => new Map((summary.dayHighlights ?? []).map((item) => [item.date, item.topTargets])),
    [summary.dayHighlights],
  );

  const { weeks, monthLabels, rangeStart, rangeEnd } = useMemo(() => {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    end.setUTCFullYear(end.getUTCFullYear() - offset);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    start.setUTCDate(start.getUTCDate() + 1);
    const built = buildHeatmapWeeks(byDate, start, end);
    return { ...built, rangeStart: start, rangeEnd: end };
  }, [byDate, offset]);

  const rangeActions = useMemo(
    () =>
      weeks.reduce(
        (sum, week) => sum + week.reduce((s, cell) => s + (cell?.count ?? 0), 0),
        0,
      ),
    [weeks],
  );

  const rangeLabel = `${HEATMAP_MONTHS[rangeStart.getUTCMonth()]} ${rangeStart.getUTCFullYear()} – ${HEATMAP_MONTHS[rangeEnd.getUTCMonth()]} ${rangeEnd.getUTCFullYear()}`;
  const numWeeks = weeks.length;
  const backDisabled = offset >= MAX_BACK;
  const forwardDisabled = offset <= 0;

  return (
    <div className='rounded-xl border p-3 sm:p-4' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
      <div className='flex items-center justify-between gap-2 mb-3 text-[11px]' style={{ color: "var(--text-muted)" }}>
        <span className='truncate tabular-nums'>{rangeLabel}</span>
        <div className='flex items-center gap-2 shrink-0'>
          <span className='tabular-nums whitespace-nowrap'>{rangeActions} actions</span>
          {!mobile && (
            <div className='flex items-center gap-1'>
              <button
                type='button'
                onClick={() => setYearOffset((o) => Math.min(MAX_BACK, o + 1))}
                disabled={backDisabled}
                className='w-6 h-6 rounded-full border flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-[var(--bg-hover)]'
                style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
                aria-label='Previous 12 months'
                title='Previous 12 months'
              >
                <svg width='11' height='11' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' viewBox='0 0 24 24'>
                  <path d='m15 18-6-6 6-6' />
                </svg>
              </button>
              <button
                type='button'
                onClick={() => setYearOffset((o) => Math.max(0, o - 1))}
                disabled={forwardDisabled}
                className='w-6 h-6 rounded-full border flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-[var(--bg-hover)]'
                style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
                aria-label='Next 12 months'
                title='Next 12 months'
              >
                <svg width='11' height='11' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' viewBox='0 0 24 24'>
                  <path d='m9 18 6-6-6-6' />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Month labels align to the grid columns below (same responsive tracks). */}
      <div
        className='mb-1 text-[9px] sm:text-[10px]'
        style={{ display: "grid", gridTemplateColumns: `repeat(${numWeeks}, minmax(0, 1fr))`, gap: "2px", color: "var(--text-muted)" }}
      >
        {monthLabels.map((label, index) => (
          <span key={`${label}-${index}`} className='whitespace-nowrap leading-none'>
            {label}
          </span>
        ))}
      </div>

      {/* Responsive grid: columns are minmax(0,1fr) and the box keeps a weeks:7
          aspect ratio, so a full year fits the container width — no horizontal
          scroll on desktop or mobile. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${numWeeks}, minmax(0, 1fr))`,
          gridTemplateRows: "repeat(7, 1fr)",
          gridAutoFlow: "column",
          aspectRatio: `${numWeeks} / 7`,
          gap: "2px",
          width: "100%",
        }}
      >
        {weeks.flatMap((week, weekIndex) =>
          week.map((cell, dayIndex) => {
            if (!cell) return <div key={`blank-${weekIndex}-${dayIndex}`} />;
            const highlights = dayHighlights.get(cell.date) ?? [];
            return (
              <div
                key={cell.date}
                title={formatActivityDayTooltip(cell, highlights)}
                className='rounded-[2px] border'
                style={activityHeatmapCellStyle(cell.count)}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

function WelcomeCard({
  onNewPage,
  latestUpdateAt,
  onOpenVersionLog,
  activitySummary,
  activityLoading,
  activityError,
}: {
  onNewPage: () => void;
  latestUpdateAt: string | null;
  onOpenVersionLog: () => void;
  activitySummary: UserActivitySummary | null;
  activityLoading: boolean;
  activityError: string | null;
}) {
  const t = useT();
  const [tab, setTab] = useState<"page" | "guide">("page");

  return (
    <div className='rounded-xl border p-4 mt-8' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }} data-analytics-zone='information-center'>
      <div className='flex flex-wrap items-center gap-2 mb-3'>
        <div className='flex items-center gap-1 rounded-full border p-1' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
          {([ ["page", t.tabPage], ["guide", t.tabGuide] ] as const).map(([key, label]) => (
            <button
              key={key}
              type='button'
              onClick={() => setTab(key)}
              className='px-3 py-1.5 text-[12px] rounded-full border transition-colors'
              style={{ borderColor: tab === key ? "var(--accent-color)" : "transparent", color: tab === key ? "var(--accent-color)" : "var(--text-muted)", background: tab === key ? "rgba(35,131,226,0.08)" : "transparent" }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type='button'
          onClick={onOpenVersionLog}
          className='ml-auto flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-full whitespace-nowrap border transition-colors'
          style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)", color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-primary)")}
          title={latestUpdateAt ? `Recent changes — last update ${formatVersionLogTimestamp(latestUpdateAt)}` : "Recent changes"}
        >
          <Ico.Clock /> {t.log}
        </button>
      </div>

      {tab === "page" ? (
        <div className='rounded-xl border p-3 sm:p-4' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
          <h3 className='text-[14px] font-semibold mb-3' style={{ color: "var(--text-primary)" }}>{t.contributionChart}</h3>
          {activityLoading ? (
            <div className='space-y-2' aria-label='Loading contribution chart'>
              <div className='grid gap-1.5' style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
                {Array.from({ length: 28 }).map((_, index) => (
                  <div key={index} className='h-3.5 rounded animate-pulse' style={{ background: "var(--bg-hover)" }} />
                ))}
              </div>
              <div className='h-3 w-28 rounded animate-pulse' style={{ background: "var(--bg-hover)" }} />
            </div>
          ) : activitySummary ? (
            <ActivityContributionHeatmap summary={activitySummary} />
          ) : (
            <div className='rounded-lg border px-3 py-2 text-[12px]' style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
              {activityError ?? "No contribution data available yet."}
            </div>
          )}
        </div>
      ) : (
        <div className='space-y-3'>
          <div className='grid gap-1.5' style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {SLASH_ITEMS.map((item) => (
              <div key={item.title} className='flex items-center gap-2 px-2 py-1.5 rounded-[6px]' style={{ background: "var(--bg-primary)", border: "1px solid var(--border-color)" }} title={item.subtitle}>
                <span className='flex items-center justify-center w-6 h-6 rounded-[5px] text-[12px] shrink-0' style={{ background: "var(--bg-hover)", color: "var(--text-primary)" }}>{item.icon}</span>
                <div className='min-w-0'>
                  <div className='text-[12px] font-medium leading-none truncate' style={{ color: "var(--text-primary)" }}>{item.title}</div>
                  <div className='text-[10px] mt-1 leading-tight truncate' style={{ color: "var(--text-muted)" }}>{item.subtitle}</div>
                </div>
              </div>
            ))}
          </div>
          <div className='flex flex-wrap gap-2 items-center justify-between rounded-xl border px-3 py-2' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
            <p className='text-[12px]' style={{ color: "var(--text-muted)" }}>Open a page and type <kbd className='px-1 py-0.5 rounded border text-[11px] font-mono' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)", color: "var(--text-primary)" }}>/</kbd> to insert blocks, or start typing to write.</p>
            <button type='button' onClick={onNewPage} className='flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-sm font-medium text-white transition-colors' style={{ background: "var(--accent-color)" }} onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")} onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent-color)")}>
              <Ico.Plus /> New page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Todo — one personal quick-scratchpad per user (checkbox + strikethrough)
// ────────────────────────────────────────────────────────────

type TodoItemT = {
  id: string;
  text: string;
  done: boolean;
  createdAt?: string;
  // Optional calendar date (YYYY-MM-DD, local) the task is scheduled for.
  dueDate?: string | null;
};

// A textarea that wraps long tasks and grows to fit its content (the previous
// single-line <input> clipped anything longer than the row).
function AutoGrowText({
  value,
  onChange,
  onKeyDown,
  placeholder,
  className,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={`resize-none overflow-hidden ${className ?? ""}`}
      style={style}
    />
  );
}

function formatTodoTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The list itself lives in App (so the sidebar calendar can highlight the days
// with scheduled tasks); this view renders and edits it.
function TodoView({
  items,
  loading,
  update,
}: {
  items: TodoItemT[];
  loading: boolean;
  update: (next: TodoItemT[]) => void;
}) {
  const [input, setInput] = useState("");

  const addItem = () => {
    const text = input.trim();
    if (!text) return;
    update([
      ...items,
      {
        id: crypto.randomUUID(),
        text,
        done: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    setInput("");
  };

  const remaining = items.filter((i) => !i.done).length;

  return (
    <div
      className='flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10 max-w-[720px] mx-auto w-full'
      data-scroll-host='main'
      data-analytics-zone='todo'
    >
      <div className='flex items-center justify-between mb-4'>
        <h1 className='text-2xl font-bold' style={{ color: "var(--text-primary)" }}>
          To-do
        </h1>
        {items.length > 0 && (
          <span className='text-[12px]' style={{ color: "var(--text-muted)" }}>
            {remaining} left
          </span>
        )}
      </div>

      <div className='flex gap-2 mb-4'>
        <AutoGrowText
          value={input}
          onChange={setInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder='Add a task and press Enter…'
          className='flex-1 text-sm px-3 py-2 rounded-[8px] border outline-none min-w-0'
          style={{
            borderColor: "var(--border-color)",
            background: "var(--bg-secondary)",
            color: "var(--text-primary)",
          }}
        />
        <button
          onClick={addItem}
          className='px-3 py-2 rounded-[8px] text-sm font-medium text-white shrink-0'
          style={{ background: "var(--accent-color)" }}
        >
          Add
        </button>
      </div>

      {loading ? (
        <p className='text-sm' style={{ color: "var(--text-muted)" }}>
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p
          className='text-sm text-center py-10'
          style={{ color: "var(--text-muted)" }}
        >
          Nothing yet — add your first task above.
        </p>
      ) : (
        <div className='space-y-1'>
          {items.map((it) => (
            <div
              key={it.id}
              className='group flex items-start gap-3 px-3 py-2 rounded-[8px]'
              style={{
                border: "1px solid var(--border-color)",
                background: "var(--bg-secondary)",
              }}
            >
              <button
                onClick={() =>
                  update(
                    items.map((x) =>
                      x.id === it.id ? { ...x, done: !x.done } : x,
                    ),
                  )
                }
                className='shrink-0 w-5 h-5 rounded-[5px] flex items-center justify-center border transition-colors'
                style={{
                  borderColor: it.done
                    ? "var(--accent-color)"
                    : "var(--border-color)",
                  background: it.done ? "var(--accent-color)" : "transparent",
                  color: "#fff",
                }}
                title={it.done ? "Mark not done" : "Mark done"}
              >
                {it.done && <Ico.Check />}
              </button>
              <div className='flex-1 min-w-0'>
                <AutoGrowText
                  value={it.text}
                  onChange={(v) =>
                    update(
                      items.map((x) =>
                        x.id === it.id ? { ...x, text: v } : x,
                      ),
                    )
                  }
                  className='w-full bg-transparent outline-none text-sm border-0 p-0'
                  style={{
                    color: it.done ? "var(--text-muted)" : "var(--text-primary)",
                    textDecoration: it.done ? "line-through" : "none",
                  }}
                />
                {it.dueDate && (
                  <span
                    className='inline-flex items-center gap-1 mt-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium'
                    style={{ background: "rgba(245,197,24,0.22)", color: "#8a6d00" }}
                    title='Scheduled'
                  >
                    <Ico.Calendar />
                    {it.dueDate}
                    <button
                      onClick={() =>
                        update(
                          items.map((x) =>
                            x.id === it.id ? { ...x, dueDate: null } : x,
                          ),
                        )
                      }
                      className='ml-0.5 leading-none'
                      title='Remove from calendar'
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              {it.createdAt && (
                <span
                  className='shrink-0 text-[11px] text-right hidden sm:block'
                  style={{ color: "var(--text-muted)", opacity: 0.75 }}
                  title='Created'
                >
                  {formatTodoTimestamp(it.createdAt)}
                </span>
              )}
              {/* Calendar button: an invisible native date input sits on top of
                  the icon so clicking it opens the browser's date picker. */}
              <div
                className='relative shrink-0 p-1 rounded'
                style={{ color: it.dueDate ? "#e0a800" : "var(--text-muted)" }}
                title={it.dueDate ? `Scheduled for ${it.dueDate}` : "Add to calendar"}
              >
                <Ico.Calendar />
                <input
                  type='date'
                  value={it.dueDate ?? ""}
                  onChange={(e) =>
                    update(
                      items.map((x) =>
                        x.id === it.id
                          ? { ...x, dueDate: e.target.value || null }
                          : x,
                      ),
                    )
                  }
                  className='absolute inset-0 w-full h-full opacity-0 cursor-pointer'
                  aria-label='Schedule this task on a date'
                />
              </div>
              <button
                onClick={() => update(items.filter((x) => x.id !== it.id))}
                className='shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity'
                style={{ color: "var(--text-muted)" }}
                title='Delete'
              >
                <Ico.Trash />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Todo calendar — a compact month view for the sidebar. Days that have a
// scheduled to-do get a yellow round highlight; hovering one shows a tooltip
// listing the tasks booked for that day.
// ────────────────────────────────────────────────────────────

const TODO_CAL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function TodoCalendar({ items }: { items: TodoItemT[] }) {
  const [offset, setOffset] = useState(0); // months relative to the current one
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const today = new Date();
  const view = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const year = view.getFullYear();
  const month = view.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay(); // 0 = Sunday

  // Group scheduled tasks by their YYYY-MM-DD due date.
  const byDate = useMemo(() => {
    const m = new Map<string, TodoItemT[]>();
    for (const it of items) {
      if (!it.dueDate) continue;
      const list = m.get(it.dueDate) ?? [];
      list.push(it);
      m.set(it.dueDate, list);
    }
    return m;
  }, [items]);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const keyFor = (day: number) => `${year}-${pad2(month + 1)}-${pad2(day)}`;
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className='px-3 py-2'>
      <div className='flex items-center justify-between mb-1.5'>
        <span
          className='text-[11px] font-semibold uppercase tracking-wide'
          style={{ color: "var(--text-muted)" }}
        >
          {TODO_CAL_MONTHS[month]} {year}
        </span>
        <span className='flex items-center gap-0.5'>
          <button
            onClick={() => setOffset((o) => o - 1)}
            className='w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--bg-hover)]'
            style={{ color: "var(--text-muted)" }}
            aria-label='Previous month'
          >
            ‹
          </button>
          <button
            onClick={() => setOffset((o) => o + 1)}
            className='w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--bg-hover)]'
            style={{ color: "var(--text-muted)" }}
            aria-label='Next month'
          >
            ›
          </button>
        </span>
      </div>
      <div className='grid grid-cols-7 gap-y-0.5 text-center'>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} className='text-[9px] font-medium' style={{ color: "var(--text-muted)", opacity: 0.7 }}>
            {d}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <span key={`pad-${i}`} />;
          const key = keyFor(day);
          const booked = byDate.get(key);
          const isToday = key === todayKey;
          return (
            <span key={key} className='relative flex justify-center'>
              <span
                onMouseEnter={() => booked && setHoverKey(key)}
                onMouseLeave={() => setHoverKey(null)}
                className='w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] tabular-nums'
                style={
                  booked
                    ? { background: "#f5c518", color: "#3a2f00", fontWeight: 700, cursor: "default" }
                    : isToday
                      ? { border: "1px solid var(--accent-color)", color: "var(--accent-color)", fontWeight: 600 }
                      : { color: "var(--text-primary)" }
                }
              >
                {day}
              </span>
              {booked && hoverKey === key && (
                <div
                  className='absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-[170px] rounded-[8px] border shadow-xl px-2.5 py-2 z-50 pointer-events-none text-left'
                  style={{ background: "var(--bg-primary)", borderColor: "var(--border-color)" }}
                >
                  <div className='text-[10px] font-semibold mb-1' style={{ color: "var(--text-muted)" }}>
                    {key}
                  </div>
                  {booked.map((it) => (
                    <div
                      key={it.id}
                      className='text-[11px] leading-snug truncate flex items-center gap-1'
                      style={{
                        color: it.done ? "var(--text-muted)" : "var(--text-primary)",
                        textDecoration: it.done ? "line-through" : "none",
                      }}
                    >
                      <span
                        className='inline-block w-1 h-1 rounded-full shrink-0'
                        style={{ background: "#f5c518" }}
                      />
                      {it.text}
                    </div>
                  ))}
                </div>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DocumentHub({
  tree,
  isDark,
  isLoading,
  onSelectPage,
  onNewPage,
  onDeletePage,
  onToggleStar,
  latestUpdateAt,
  onOpenVersionLog,
  activitySummary,
  activityLoading,
  activityError,
}: {
  tree: PageNode[];
  isDark: boolean;
  isLoading: boolean;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
  onDeletePage: (id: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  latestUpdateAt: string | null;
  onOpenVersionLog: () => void;
  activitySummary: UserActivitySummary | null;
  activityLoading: boolean;
  activityError: string | null;
}) {
  const t = useT();
  const PER_PAGE = 5;
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pageNum, setPageNum] = useState(0);
  const allPages = flattenTree(tree);
  const allTags = Array.from(new Set(allPages.flatMap((p) => p.tags))).sort();
  const q = query.trim().toLowerCase();
  const filtered = allPages
    .filter(
      (p) =>
        (!filterTag || p.tags.includes(filterTag)) &&
        (!q || (p.title || "Untitled").toLowerCase().includes(q)),
    )
    // Most recently modified first — matches the "Modified" column.
    .sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(pageNum, totalPages - 1);
  const pageItems = filtered.slice(
    safePage * PER_PAGE,
    safePage * PER_PAGE + PER_PAGE,
  );

  // Reset to the first page whenever the tag filter or search changes.
  useEffect(() => setPageNum(0), [filterTag, query]);

  return (
    <div className='flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10 max-w-[900px] mx-auto w-full' data-analytics-zone='home-dashboard'>
      {/* Header */}
      <div className='flex items-center justify-between mb-6'>
        <h1
          className='text-2xl sm:text-3xl font-bold'
          style={{ color: "var(--text-primary)" }}
        >
          {t.documentHub}
        </h1>
        <button
          onClick={onNewPage}
          className='flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-sm font-medium text-white transition-colors'
          style={{ background: "var(--accent-color)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--accent-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "var(--accent-color)")
          }
        >
          <Ico.Plus /> {t.newPage}
        </button>
      </div>

      {/* Tag filter pills */}
      {allTags.length > 0 && (
        <div className='flex flex-wrap gap-2 mb-5'>
          <button
            onClick={() => setFilterTag(null)}
            className='text-[12px] px-3 py-1 rounded-full border transition-colors font-medium'
            style={{
              background: !filterTag ? "var(--accent-color)" : "transparent",
              color: !filterTag ? "#fff" : "var(--text-muted)",
              borderColor: !filterTag
                ? "var(--accent-color)"
                : "var(--border-color)",
            }}
          >
            {t.allDocs}
          </button>
          {allTags.map((tag) => {
            const { bg, fg } = tagColor(tag, isDark);
            const active = filterTag === tag;
            return (
              <button
                key={tag}
                onClick={() => setFilterTag(active ? null : tag)}
                className='text-[12px] px-3 py-1 rounded-full border transition-all font-medium'
                style={{
                  background: active ? fg : bg,
                  color: active ? "#fff" : fg,
                  borderColor: fg + "44",
                  transform: active ? "scale(1.03)" : "scale(1)",
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Toolbar: search (left) + pagination (right, fixed here so it doesn't
          shift the layout as row counts change) */}
      <div className='flex flex-wrap items-center justify-between gap-3 mb-3'>
        <div className='relative w-full max-w-[300px]'>
          <span
            className='absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none'
            style={{ color: "var(--text-muted)" }}
          >
            <Ico.Search />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchDocs}
            className='w-full text-base sm:text-sm pl-8 pr-3 py-1.5 rounded-[8px] border outline-none'
            style={{
              borderColor: "var(--border-color)",
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
            }}
          />
        </div>
        {totalPages > 1 && (
          <div className='flex items-center gap-1.5 shrink-0'>
            <button
              onClick={() => setPageNum((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className='px-2.5 py-1 rounded-[6px] border text-[12px] transition-colors disabled:opacity-40 disabled:cursor-default'
              style={{
                borderColor: "var(--border-color)",
                color: "var(--text-muted)",
              }}
            >
              ‹ {t.prev}
            </button>
            <span
              className='text-[12px] px-1 whitespace-nowrap'
              style={{ color: "var(--text-muted)" }}
            >
              {t.pageIndicator
                .replace("{n}", String(safePage + 1))
                .replace("{total}", String(totalPages))}
            </span>
            <button
              onClick={() =>
                setPageNum((p) => Math.min(totalPages - 1, p + 1))
              }
              disabled={safePage >= totalPages - 1}
              className='px-2.5 py-1 rounded-[6px] border text-[12px] transition-colors disabled:opacity-40 disabled:cursor-default'
              style={{
                borderColor: "var(--border-color)",
                color: "var(--text-muted)",
              }}
            >
              {t.next} ›
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div
        className='rounded-xl border overflow-hidden'
        style={{ borderColor: "var(--border-color)" }}
      >
        {/* Table header — title, tags, and actions on desktop; title only on mobile */}
        <div
          className='grid text-[11px] font-semibold uppercase tracking-wider px-4 py-2.5 border-b grid-cols-[1fr] sm:grid-cols-[1fr_180px_110px]'
          style={{
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            borderColor: "var(--border-color)",
          }}
        >
          <span>{t.colTitle}</span>
          <span className='hidden sm:block'>{t.colTag}</span>
          <span className='hidden sm:block'></span>
        </div>

        {isLoading && filtered.length === 0 && (
          <div className='px-4 py-2.5' aria-label='Loading pages'>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className='grid items-center py-2.5 grid-cols-[1fr] sm:grid-cols-[1fr_180px_110px]'
              >
                <div
                  className='h-4 rounded animate-pulse'
                  style={{
                    background: "var(--bg-hover)",
                    width: `${60 - i * 12}%`,
                  }}
                />
                <div
                  className='hidden sm:block h-4 rounded animate-pulse'
                  style={{ background: "var(--bg-hover)", width: "40%" }}
                />
                <div className='hidden sm:block' />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div
            className='px-4 py-12 text-center text-sm'
            style={{ color: "var(--text-muted)" }}
          >
            {q
              ? `No documents matching "${query.trim()}"`
              : filterTag
                ? `No pages tagged "${filterTag}"`
                : "No pages yet — click New page to start."}
          </div>
        )}

        {pageItems.map((page, i) => {
          const date = new Date(page.updatedAt);
          const dateStr = date.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div
              key={page.id}
              className='grid items-center px-4 py-2.5 cursor-pointer transition-colors border-b last:border-0 group grid-cols-[1fr] sm:grid-cols-[1fr_180px_110px]'
              style={{
                borderColor: "var(--border-color)",
                background: "transparent",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              onClick={() => onSelectPage(page.id)}
            >
              <div className='flex flex-col min-w-0'>
                <div className='flex items-center gap-2 min-w-0'>
                  <span style={{ color: "var(--text-muted)" }}>
                    {page.icon ? (
                      <span className='text-base'>{page.icon}</span>
                    ) : (
                      <Ico.Page />
                    )}
                  </span>
                  <span
                    className='text-sm truncate font-medium'
                    style={{ color: "var(--text-primary)" }}
                  >
                    {page.title || t.untitled}
                  </span>
                </div>
                <div
                  className='text-[11px] mt-0.5 sm:mt-0'
                  style={{ color: "var(--text-muted)" }}
                >
                  {dateStr}
                </div>
              </div>

              <div className='flex flex-wrap gap-1.5 overflow-hidden mt-1.5 sm:mt-0'>
                {page.tags.slice(0, 3).map((tag) => (
                  <TagBadge key={tag} tag={tag} isDark={isDark} />
                ))}
                {page.tags.length > 3 && (
                  <span
                    className='text-[11px]'
                    style={{ color: "var(--text-muted)" }}
                  >
                    +{page.tags.length - 3}
                  </span>
                )}
              </div>

              {/* Row actions - visible on hover */}
              <div className='hidden sm:flex justify-end items-center gap-1.5'>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStar(page.id, !page.isStarred);
                  }}
                  className={`p-1 rounded-[4px] transition-all ${
                    page.isStarred ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  style={{ color: "var(--text-muted)" }}
                  title={page.isStarred ? t.unstar : t.star}
                  aria-pressed={!!page.isStarred}
                >
                  <Ico.Star filled={!!page.isStarred} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeletePage(page.id);
                  }}
                  className='opacity-0 group-hover:opacity-100 p-1 rounded-[4px] transition-all'
                  style={{ color: "var(--text-muted)" }}
                  title='Move to trash'
                >
                  <Ico.Trash />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectPage(page.id);
                  }}
                  className='opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-[4px] border transition-all'
                  style={{
                    borderColor: "var(--border-color)",
                    color: "var(--text-muted)",
                  }}
                  title='Open page'
                >
                  Open <Ico.ExternalLink />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length > 0 && (
        <p className='text-[11px] mt-3' style={{ color: "var(--text-muted)" }}>
          {filterTag
            ? `${filtered.length} · ${filterTag}`
            : q
              ? `${filtered.length} · "${query.trim()}"`
              : t.pagesTotal.replace("{n}", String(filtered.length))}
        </p>
      )}

      {/* Getting-started card — hidden on mobile to save space + render cost.
          On mobile we still surface a compact last-30-days contribution chart so
          the heatmap fits the screen without the full guide/log card. */}
      {!isMobileViewport() ? (
        <WelcomeCard
          onNewPage={onNewPage}
          latestUpdateAt={latestUpdateAt}
          onOpenVersionLog={onOpenVersionLog}
          activitySummary={activitySummary}
          activityLoading={activityLoading}
          activityError={activityError}
        />
      ) : activitySummary && !activityLoading ? (
        <div
          className='rounded-xl border p-3 mt-8'
          style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}
          data-analytics-zone='information-center'
        >
          <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>
            {t.contributionChart}
          </h3>
          <ActivityContributionHeatmap summary={activitySummary} mobile />
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Search Modal
// ────────────────────────────────────────────────────────────

// Renders `text` with any of the query's whitespace-separated tokens highlighted
// in yellow (case-insensitive). Used for both the title and the body snippet in
// search results. Dark text on the yellow mark keeps it readable in every theme.
function Highlighted({ text, query }: { text: string; query: string }) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !text) return <>{text}</>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const splitRe = new RegExp(`(${tokens.map(esc).join("|")})`, "gi");
  const testRe = new RegExp(`^(${tokens.map(esc).join("|")})$`, "i");
  return (
    <>
      {text.split(splitRe).map((part, i) =>
        part && testRe.test(part) ? (
          <mark key={i} style={{ background: "#ffe680", color: "#3a2f00", borderRadius: 2, padding: "0 1px" }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function SearchModal({
  workspaceId,
  csrf,
  isDark,
  onSelect,
  onClose,
}: {
  workspaceId: string;
  csrf: string;
  isDark: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<
    { id: string; title: string; tags?: string[]; snippet?: string | null; updatedAt?: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<{
          results: { id: string; title: string; tags?: string[]; snippet?: string | null; updatedAt?: string }[];
        }>(
          // content=1 → also search page body text and return snippets
          `/search?q=${encodeURIComponent(q)}&workspaceId=${workspaceId}&content=1`,
          {},
          csrf,
        );
        setResults(r.results);
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q, workspaceId, csrf]);

  return (
    <div
      className='fixed inset-0 z-50 flex items-start justify-center pt-[13vh]'
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className='w-full max-w-[580px] mx-4 rounded-xl shadow-2xl overflow-hidden'
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className='flex items-center gap-3 px-4 py-3 border-b'
          style={{ borderColor: "var(--border-color)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>
            <Ico.Search />
          </span>
          <input
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            // 16px on mobile — anything smaller makes iOS Safari zoom the page
            // in when the field is focused, leaving the layout messy on close.
            className='flex-1 text-base sm:text-sm bg-transparent outline-none min-w-0'
            style={{ color: "var(--text-primary)" }}
            placeholder='Search titles & content...'
          />
          <kbd
            className='text-[10px] px-1.5 py-0.5 rounded'
            style={{
              background: "var(--bg-hover)",
              color: "var(--text-muted)",
            }}
          >
            ESC
          </kbd>
        </div>
        <div className='max-h-[360px] overflow-y-auto py-1'>
          {busy && (
            <p
              className='px-4 py-5 text-center text-xs'
              style={{ color: "var(--text-muted)" }}
            >
              Searching...
            </p>
          )}
          {!busy && !q && (
            <p
              className='px-4 py-5 text-center text-xs'
              style={{ color: "var(--text-muted)" }}
            >
              Type to search...
            </p>
          )}
          {!busy && q && results.length === 0 && (
            <p
              className='px-4 py-5 text-center text-xs'
              style={{ color: "var(--text-muted)" }}
            >
              No results for &ldquo;{q}&rdquo;
            </p>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onSelect(r.id);
                onClose();
              }}
              className='w-full flex flex-col gap-1 px-4 py-2.5 text-left transition-colors'
              style={{ color: "var(--text-primary)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <div className='flex items-center gap-3 w-full'>
                <span style={{ color: "var(--text-muted)" }}>
                  <Ico.Page />
                </span>
                <span className='flex-1 truncate text-sm'>
                  <Highlighted text={r.title || "Untitled"} query={q} />
                </span>
                <div className='flex gap-1.5 items-center shrink-0'>
                  {r.tags?.slice(0, 2).map((tag) => (
                    <TagBadge key={tag} tag={tag} isDark={isDark} />
                  ))}
                  {r.updatedAt && (
                    <span
                      className='text-[11px] tabular-nums whitespace-nowrap'
                      style={{ color: "var(--accent-color)", opacity: 0.75 }}
                      title={`Last updated ${formatVersionLogTimestamp(r.updatedAt)}`}
                    >
                      {formatSearchUpdated(r.updatedAt)}
                    </span>
                  )}
                  <span style={{ color: "var(--text-muted)" }} title='Open page'>
                    <Ico.ExternalLink />
                  </span>
                </div>
              </div>
              {r.snippet && (
                <p
                  className='text-[12px] leading-snug pl-[27px] line-clamp-2'
                  style={{ color: "var(--text-muted)" }}
                >
                  <Highlighted text={r.snippet} query={q} />
                </p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Revision Drawer
// ────────────────────────────────────────────────────────────

function RevisionDrawer({
  pageId,
  csrf,
  onRestore,
  onClose,
}: {
  pageId: string;
  csrf: string;
  onRestore: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api<{ revisions: Revision[] }>(`/pages/${pageId}/revisions`, {}, csrf)
      .then((r) => setRevisions(r.revisions))
      .finally(() => setLoading(false));
  }, [pageId, csrf]);

  async function restore(id: string) {
    setRestoring(id);
    try {
      await api(
        `/pages/${pageId}/revisions/${id}/restore`,
        { method: "POST" },
        csrf,
      );
      onRestore();
      onClose();
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div
      className='w-[268px] shrink-0 flex flex-col border-l max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-2xl'
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-color)",
      }}
    >
      <div
        className='flex items-center justify-between px-4 py-3 border-b text-sm font-medium'
        style={{
          borderColor: "var(--border-color)",
          color: "var(--text-primary)",
        }}
      >
        <div className='flex items-center gap-2'>
          <Ico.Clock />
          <span>{t.pageHistory}</span>
        </div>
        <button
          onClick={onClose}
          className='transition-colors'
          style={{ color: "var(--text-muted)" }}
        >
          <Ico.X />
        </button>
      </div>
      <div className='flex-1 overflow-y-auto py-1'>
        {loading && (
          <p
            className='px-4 py-6 text-xs text-center'
            style={{ color: "var(--text-muted)" }}
          >
            {t.loading}
          </p>
        )}
        {!loading && revisions.length === 0 && (
          <p
            className='px-4 py-6 text-xs text-center'
            style={{ color: "var(--text-muted)" }}
          >
            {t.noRevisions}
          </p>
        )}
        {revisions.map((rev) => (
          <div
            key={rev.id}
            className='px-4 py-2.5 border-b last:border-0'
            style={{ borderColor: "var(--border-color)" }}
          >
            <div className='flex items-start justify-between gap-2'>
              <div>
                <p
                  className='text-xs font-medium'
                  style={{ color: "var(--text-primary)" }}
                >
                  v{rev.version}
                </p>
                <p
                  className='text-[11px] mt-0.5'
                  style={{ color: "var(--text-muted)" }}
                >
                  {new Date(rev.createdAt).toLocaleDateString()}{" "}
                  {new Date(rev.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <button
                onClick={() => void restore(rev.id)}
                disabled={!!restoring}
                className='text-[11px] font-medium shrink-0 transition-colors disabled:opacity-40'
                style={{ color: "var(--accent-color)" }}
              >
                {restoring === rev.id ? "..." : t.restore}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VersionLogDrawer({
  entries,
  loading,
  onClose,
}: {
  entries: VersionLogEntry[];
  loading: boolean;
  onClose: () => void;
}) {
  const latest = entries[0] ?? null;

  return (
    <div
      className='fixed inset-y-0 right-0 z-40 w-[320px] max-w-[calc(100vw-1rem)] flex flex-col border-l max-md:shadow-2xl'
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-color)",
      }}
    >
      <div
        className='flex items-center justify-between px-4 py-3 border-b text-sm font-medium'
        style={{
          borderColor: "var(--border-color)",
          color: "var(--text-primary)",
        }}
      >
        <div className='flex items-center gap-2'>
          <Ico.Clock />
          <span>Version log</span>
        </div>
        <button
          onClick={onClose}
          className='transition-colors'
          style={{ color: "var(--text-muted)" }}
        >
          <Ico.X />
        </button>
      </div>
      <div className='px-4 py-3 border-b' style={{ borderColor: "var(--border-color)" }}>
        <p
          className='text-[11px] uppercase tracking-wider'
          style={{ color: "var(--text-muted)" }}
        >
          Latest update
        </p>
        <p className='mt-1 text-sm font-medium' style={{ color: "var(--text-primary)" }}>
          {latest ? formatVersionLogTimestamp(latest.publishedAt) : APP_RELEASE_DATE}
        </p>
      </div>
      <div className='flex-1 overflow-y-auto py-1'>
        {loading && (
          <p
            className='px-4 py-6 text-xs text-center'
            style={{ color: "var(--text-muted)" }}
          >
            Loading...
          </p>
        )}
        {!loading && entries.length === 0 && (
          <p
            className='px-4 py-6 text-xs text-center'
            style={{ color: "var(--text-muted)" }}
          >
            No version log entries yet.
          </p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className='px-4 py-3 border-b last:border-0'
            style={{ borderColor: "var(--border-color)" }}
          >
            <p className='text-xs font-medium' style={{ color: "var(--text-primary)" }}>
              {entry.title}
            </p>
            <p className='text-[11px] mt-0.5' style={{ color: "var(--text-muted)" }}>
              {formatVersionLogTimestamp(entry.publishedAt)}
            </p>
            <p className='mt-2 text-[12px] leading-5' style={{ color: "var(--text-primary)" }}>
              {entry.summary}
            </p>
            {entry.bullets?.length ? (
              <ul className='mt-2 space-y-1 text-[12px]' style={{ color: "var(--text-muted)" }}>
                {entry.bullets.map((bullet) => (
                  <li key={bullet} className='flex gap-2'>
                    <span
                      className='mt-[7px] h-1.5 w-1.5 rounded-full shrink-0'
                      style={{ background: "var(--accent-color)" }}
                    />
                    <span className='leading-5'>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileActivityDrawer({
  onClose,
  endpoint,
  title,
  subtitle,
  isDark,
}: {
  onClose: () => void;
  endpoint: string;
  title: string;
  subtitle: string;
  isDark: boolean;
}) {
  const t = useT();
  const windows = ["14d"] as const;
  const tabs = ["graphical", "list"] as const;
  type AnalyticsTab = (typeof tabs)[number];
  const [windowIndex] = useState(0);
  const [tab, setTab] = useState<AnalyticsTab>("graphical");
  const [pinned, setPinned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<UserActivitySummary | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const windowKey = windows[windowIndex];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<UserActivitySummary>(`${endpoint}?window=${windowKey}`)
      .then((data) => {
        if (!alive) return;
        setSummary(data);
        setErr(null);
      })
      .catch((error) => {
        if (!alive) return;
        setErr(error instanceof Error ? error.message : "Failed to load activity");
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [endpoint, windowKey]);

  useEffect(() => {
    if (pinned) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (drawerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose, pinned]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dayHighlights = useMemo(
    () => new Map((summary?.dayHighlights ?? []).map((item) => [item.date, item.topTargets])),
    [summary?.dayHighlights],
  );

  const barData = useMemo(
    () => ({
      labels: (summary?.topTargets ?? []).slice(0, 5).map((item) => item.label),
      datasets: [
        {
          label: "Clicks",
          data: (summary?.topTargets ?? []).slice(0, 5).map((item) => item.count),
          backgroundColor: isDark ? "rgba(126, 192, 245, 0.96)" : "rgba(35, 131, 226, 0.75)",
          borderRadius: 6,
          borderSkipped: false as const,
        },
      ],
    }),
    [isDark, summary?.topTargets],
  );

  const chartTextColor = isDark ? "#f5f0e8" : "#1f1f1f";
  const chartMutedColor = isDark ? "rgba(245,240,232,0.74)" : "rgba(80,80,80,0.8)";
  const chartGridColor = isDark ? "rgba(255,255,255,0.10)" : "rgba(127,127,127,0.12)";

  const barOptions = useMemo(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          bodyColor: chartTextColor,
          titleColor: chartTextColor,
          backgroundColor: isDark ? "rgba(20,20,20,0.96)" : "rgba(255,255,255,0.96)",
          borderColor: chartGridColor,
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          grid: { color: chartGridColor },
          ticks: { color: chartMutedColor, precision: 0 },
        },
        y: {
          grid: { display: false },
          ticks: { color: chartTextColor },
        },
      },
    }),
    [chartGridColor, chartMutedColor, chartTextColor],
  );

  const heatmapDays = summary?.heatmap?.length
    ? summary.heatmap.slice(-14)
    : Array.from({ length: 14 }, (_, index) => ({ date: `empty-${index}`, count: 0 }) as UserActivityHeatmapCell);

  const recentEvents = summary?.recentEvents ?? [];

  return (
    <div
      ref={drawerRef}
      className='fixed inset-y-0 right-0 z-50 w-[380px] max-w-[calc(100vw-1rem)] border-l shadow-2xl flex flex-col min-h-0'
      style={{ background: "var(--bg-primary)", borderColor: "var(--border-color)" }}
      data-analytics-zone='profile-activity'
    >
      <div
        className='flex items-center justify-between px-4 py-3 border-b'
        style={{ borderColor: "var(--border-color)" }}
      >
        <div>
          <p className='text-[11px] uppercase tracking-wider' style={{ color: "var(--text-muted)" }}>
            {t.profileAnalytics}
          </p>
          <h3 className='text-sm font-semibold' style={{ color: "var(--text-primary)" }}>
            {title}
          </h3>
          <p className='text-[11px] mt-0.5' style={{ color: "var(--text-muted)" }}>
            {subtitle}
          </p>
        </div>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={() => setPinned((v) => !v)}
            className='px-2 py-1 rounded-[6px] border text-[11px] transition-colors'
            style={{
              borderColor: pinned ? "var(--accent-color)" : "var(--border-color)",
              color: pinned ? "var(--accent-color)" : "var(--text-muted)",
              background: pinned ? "rgba(35,131,226,0.08)" : "transparent",
            }}
            title={pinned ? "Pinned" : "Auto-hide enabled"}
          >
            {pinned ? "Pinned" : "Pin"}
          </button>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <Ico.X />
          </button>
        </div>
      </div>

      <div className='px-4 pt-2 pb-1 border-b' style={{ borderColor: "var(--border-color)" }}>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={() => setTab("graphical")}
            className='px-3 py-1.5 text-[12px] rounded-[6px] border transition-colors'
            style={{
              borderColor:
                tab === "graphical" ? "var(--accent-color)" : "var(--border-color)",
              color: tab === "graphical" ? "var(--accent-color)" : "var(--text-muted)",
              background:
                tab === "graphical" ? "rgba(35,131,226,0.08)" : "transparent",
            }}
          >
            {t.graphical}
          </button>
          <button
            type='button'
            onClick={() => setTab("list")}
            className='px-3 py-1.5 text-[12px] rounded-[6px] border transition-colors'
            style={{
              borderColor:
                tab === "list" ? "var(--accent-color)" : "var(--border-color)",
              color: tab === "list" ? "var(--accent-color)" : "var(--text-muted)",
              background:
                tab === "list" ? "rgba(35,131,226,0.08)" : "transparent",
            }}
          >
            {t.listView}
          </button>
        </div>
      </div>

      <div className='px-4 py-3 border-b space-y-2' style={{ borderColor: "var(--border-color)" }}>
        <div>
          <div className='flex items-center justify-between text-[10px] mb-1' style={{ color: "var(--text-muted)" }}>
            <span>{t.timeRange}</span>
            <span>{windowKey}</span>
          </div>
          <div className='mt-1 flex justify-between text-[9px]' style={{ color: "var(--text-muted)" }}>
            <span>{t.daysView}</span>
            <span>{t.todayIncluded}</span>
          </div>
        </div>

        <div className='grid grid-cols-3 gap-1'>
          <KpiCard compact label='Actions' value={summary?.totalEvents ?? "—"} />
          <KpiCard compact label='Clicks' value={summary?.clickEvents ?? "—"} accent />
          <KpiCard compact label='Time spent' value={summary ? formatDuration(summary.dwellMs) : "—"} />
          <KpiCard compact label='Pages' value={summary?.uniquePages ?? "—"} />
          <KpiCard compact label='Scroll max' value={summary ? `${summary.scrollDepthMax}%` : "—"} />
          <KpiCard compact label='Scroll avg' value={summary ? `${summary.scrollDepthAvg}%` : "—"} />
          <KpiCard compact label='Attention' value={summary?.attentionScore ?? "—"} accent />
        </div>
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto px-4 py-2.5 space-y-3.5'>
        {err && (
          <div className='rounded-lg border px-3 py-2 text-[12px]' style={{ borderColor: "rgba(200,48,48,0.3)", color: "#c03030", background: "rgba(200,48,48,0.06)" }}>
            {err}
          </div>
        )}

        {tab === "graphical" ? (
          <>
            <section>
              <h4 className='text-[12px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>
                {t.activityByDay}
              </h4>
              {loading && !summary ? (
                <div className='grid grid-cols-7 gap-1'>
                  {Array.from({ length: 35 }).map((_, index) => (
                    <div key={index} className='h-3 rounded animate-pulse' style={{ background: "var(--bg-hover)" }} />
                  ))}
                </div>
              ) : (
                <div className='rounded-xl border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
                  <div className='mb-2 flex items-center justify-between text-[10px]' style={{ color: "var(--text-muted)" }}>
                    <span>{t.daysLabel14}</span>
                    <span>{t.today}</span>
                  </div>
                  <div
                    className='grid gap-1.5'
                    style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
                  >
                    {heatmapDays.map((cell) => {
                      const highlights = dayHighlights.get(cell.date) ?? [];
                      return (
                        <div key={cell.date} className='space-y-1'>
                          <div className='text-center text-[10px]' style={{ color: "var(--text-muted)" }}>
                            {cell.date.startsWith("empty-")
                              ? "—"
                              : new Date(`${cell.date}T00:00:00`).toLocaleDateString([], { weekday: "short" }).slice(0, 1)}
                          </div>
                          <div
                            title={formatActivityDayTooltip(cell, highlights)}
                            className='h-3.5 rounded-[3px] border'
                            style={activityHeatmapCellStyle(cell.count)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            <section>
              <h4 className='text-[12px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>
                {t.topInteractions}
              </h4>
              <div className='h-[160px] rounded-xl border p-2' style={{ borderColor: "var(--border-color)" }}>
                <Bar data={barData} options={barOptions} />
              </div>
            </section>
          </>
        ) : (
          <section>
            <h4 className='text-[12px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>
              {t.recentActivities}
            </h4>
            <div className='space-y-2'>
              {loading && !summary ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className='h-12 rounded-xl border animate-pulse' style={{ borderColor: "var(--border-color)", background: "var(--bg-hover)" }} />
                ))
              ) : recentEvents.length > 0 ? (
                recentEvents.slice(0, 10).map((event) => (
                  <div key={`${event.createdAt}-${event.eventType}-${event.target ?? event.pageId ?? "event"}`} className='rounded-xl border px-3 py-2.5' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <div className='text-[12px] font-medium truncate' style={{ color: "var(--text-primary)" }}>
                          {event.target ?? event.pageId ?? event.eventType}
                        </div>
                        <div className='mt-1 text-[10px] uppercase tracking-wider' style={{ color: "var(--text-muted)" }}>
                          {event.eventType.replace(/_/g, " ")}
                        </div>
                      </div>
                      <div className='shrink-0 text-right text-[10px]' style={{ color: "var(--text-muted)" }}>
                        <div>{new Date(event.createdAt).toLocaleDateString()}</div>
                        <div>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className='text-[12px]' style={{ color: "var(--text-muted)" }}>
                  No recent activity yet.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Theme Picker
// ────────────────────────────────────────────────────────────

const THEMES: { id: Theme; label: string; dot: string }[] = [
  { id: "dark", label: "Dark", dot: "#191919" },
  { id: "muji", label: "Muji", dot: "#f5f0e8" },
];

function ThemePicker({
  current,
  onChange,
}: {
  current: Theme;
  onChange: (t: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className='relative'>
      <button
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-2 w-full px-2.5 py-1.5 rounded-[4px] text-[12px] transition-colors'
        style={{ color: "var(--text-muted)" }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {current === "dark" || current === "vscode" ? (
          <Ico.Moon />
        ) : (
          <Ico.Sun />
        )}
        <span className='flex-1 text-left capitalize'>
          {THEMES.find((t) => t.id === current)?.label}
        </span>
      </button>
      {open && (
        <div
          className='absolute bottom-full left-0 mb-1 w-[160px] rounded-xl shadow-xl border py-1 z-50'
          style={{
            background: "var(--bg-primary)",
            borderColor: "var(--border-color)",
          }}
        >
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
              className='w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors'
              style={{
                color:
                  current === t.id
                    ? "var(--accent-color)"
                    : "var(--text-primary)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <span
                className='w-4 h-4 rounded-full border flex-shrink-0'
                style={{
                  background: t.dot,
                  borderColor: "var(--border-color)",
                }}
              />
              {t.label}
              {current === t.id && (
                <span className='ml-auto'>
                  <Ico.Check />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Font Size Picker
// ────────────────────────────────────────────────────────────

const FONT_SIZES: { id: FontSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "normal", label: "Normal" },
  { id: "large", label: "Large" },
];

function FontPicker({
  current,
  onChange,
}: {
  current: FontSize;
  onChange: (f: FontSize) => void;
}) {
  return (
    <div className='flex items-center gap-1.5 px-2.5 py-1.5'>
      <span className='mr-1' style={{ color: "var(--text-muted)" }}>
        <Ico.Font />
      </span>
      {FONT_SIZES.map((f) => (
        <button
          key={f.id}
          onClick={() => onChange(f.id)}
          className='text-[11px] px-2 py-0.5 rounded-[4px] font-medium transition-colors'
          style={{
            background:
              current === f.id ? "var(--accent-color)" : "var(--bg-hover)",
            color: current === f.id ? "#fff" : "var(--text-muted)",
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Toast
// ────────────────────────────────────────────────────────────

function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4500);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      className='fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-2xl'
      style={{ background: "var(--text-primary)" }}
    >
      <span className='flex-1'>{msg}</span>
      <button onClick={onDismiss} className='opacity-60 hover:opacity-100'>
        <Ico.X />
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Change Password Modal
// ────────────────────────────────────────────────────────────

function ChangePasswordModal({
  csrf,
  onClose,
}: {
  csrf: string;
  onClose: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr("");
    if (next.length < 8) {
      setErr(t.passwordMinLength);
      return;
    }
    if (next !== confirm) {
      setErr(t.passwordsNoMatch);
      return;
    }
    setBusy(true);
    try {
      await api(
        "/auth/change-password",
        {
          method: "PATCH",
          body: JSON.stringify({ currentPassword: current, newPassword: next }),
        },
        csrf,
      );
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className='fixed inset-0 z-[200] flex items-center justify-center'
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className='w-full max-w-[360px] mx-4 rounded-xl shadow-2xl border p-6'
        style={{
          background: "var(--bg-primary)",
          borderColor: "var(--border-color)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center justify-between mb-4'>
          <h2
            className='text-[15px] font-semibold'
            style={{ color: "var(--text-primary)" }}
          >
            {t.changePassword}
          </h2>
          <button onClick={onClose} style={{ color: "var(--text-muted)" }}>
            <Ico.X />
          </button>
        </div>

        {ok ? (
          <div className='text-center py-4 space-y-3'>
            <div className='text-3xl'>✅</div>
            <p
              className='text-sm font-medium'
              style={{ color: "var(--text-primary)" }}
            >
              {t.passwordUpdated}
            </p>
            <button
              onClick={onClose}
              className='w-full py-2 rounded-[6px] text-sm font-medium text-white mt-2'
              style={{ background: "var(--accent-color)" }}
            >
              {t.close}
            </button>
          </div>
        ) : (
          <div className='space-y-3'>
            {[
              { label: t.currentPassword, value: current, set: setCurrent },
              { label: t.newPassword, value: next, set: setNext },
              { label: t.confirmNewPassword, value: confirm, set: setConfirm },
            ].map(({ label, value, set }) => (
              <div key={label}>
                <label
                  className='block text-[12px] font-medium mb-1'
                  style={{ color: "var(--text-muted)" }}
                >
                  {label}
                </label>
                <input
                  type='password'
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                  className='w-full rounded-[6px] border px-3 py-2 text-sm outline-none'
                  style={{
                    background: "var(--input-bg)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
            ))}
            {err && (
              <p
                className='text-[12px] px-3 py-2 rounded-[6px]'
                style={{ background: "rgba(200,48,48,0.08)", color: "#c83030" }}
              >
                {err}
              </p>
            )}
            <button
              onClick={() => void submit()}
              disabled={busy}
              className='w-full py-2.5 rounded-[6px] text-sm font-medium text-white mt-1 disabled:opacity-60'
              style={{ background: "var(--accent-color)" }}
            >
              {busy ? t.saving : t.updatePassword}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Reset Password Page (standalone — shown when ?token= in URL)
// ────────────────────────────────────────────────────────────

function ResetPasswordPage({ token }: { token: string }) {
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr("");
    if (newPw.length < 8) {
      setErr("Password must be at least 8 characters");
      return;
    }
    if (newPw !== confirm) {
      setErr("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: newPw }),
      });
      setDone(true);
      setTimeout(() => {
        window.location.href = window.location.pathname;
      }, 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className='min-h-screen flex items-center justify-center p-6'
      style={{ background: "var(--bg-secondary)" }}
    >
      <div className='w-full max-w-[380px]'>
        <div className='text-center mb-7'>
          <div
            className='inline-flex items-center justify-center w-12 h-12 rounded-xl text-white text-xl font-bold mb-4'
            style={{ background: "var(--text-primary)" }}
          >
            Y
          </div>
          <h1
            className='text-2xl font-bold'
            style={{ color: "var(--text-primary)" }}
          >
            Set new password
          </h1>
          <p className='text-sm mt-1' style={{ color: "var(--text-muted)" }}>
            Choose a strong password for your account
          </p>
        </div>

        <div
          className='rounded-xl border p-6 space-y-3'
          style={{
            background: "var(--bg-primary)",
            borderColor: "var(--border-color)",
          }}
        >
          {done ? (
            <div className='text-center py-3 space-y-3'>
              <div className='text-3xl'>🎉</div>
              <p
                className='text-sm font-medium'
                style={{ color: "var(--text-primary)" }}
              >
                Password updated!
              </p>
              <p className='text-[13px]' style={{ color: "var(--text-muted)" }}>
                Redirecting you to sign in…
              </p>
            </div>
          ) : (
            <>
              {[
                { label: "New password", value: newPw, set: setNewPw },
                { label: "Confirm password", value: confirm, set: setConfirm },
              ].map(({ label, value, set }) => (
                <div key={label}>
                  <label
                    className='block text-xs font-medium mb-1.5'
                    style={{ color: "var(--text-primary)" }}
                  >
                    {label}
                  </label>
                  <input
                    type='password'
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void submit()}
                    className='w-full rounded-[6px] border px-3 py-2 text-sm outline-none'
                    style={{
                      background: "var(--input-bg)",
                      borderColor: "var(--border-color)",
                      color: "var(--text-primary)",
                    }}
                    placeholder='Min 8 characters'
                  />
                </div>
              ))}
              {err && (
                <div
                  className='rounded-[6px] border px-3 py-2 text-xs'
                  style={{
                    background: "rgba(200,48,48,0.08)",
                    borderColor: "rgba(200,48,48,0.3)",
                    color: "#c83030",
                  }}
                >
                  {err}
                </div>
              )}
              <button
                onClick={() => void submit()}
                disabled={busy}
                className='w-full rounded-[6px] py-2.5 text-sm font-medium text-white disabled:opacity-60'
                style={{ background: "var(--accent-color)" }}
              >
                {busy ? "Saving..." : "Set new password"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// CoMa — Configuration Manager (admin only)
// ────────────────────────────────────────────────────────────
type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  roleKey: string;
  roleLabel: string;
  pageCount: number;
  lastSeenAt: string | null;
};
type AdminRole = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  rank: number;
};
type OverviewMetrics = {
  totalUsers: number;
  adminUsers: number;
  normalUsers: number;
  activeUsers24h: number;
  inactiveUsers: number;
  totalWorkspaces: number;
  totalPages: number;
  totalStorageBytes: number;
};
type ActivityMetrics = {
  window: string;
  activeUsers: number;
  apiCalls: number;
  newUsers: number;
};
type MetricWindow = "6h" | "12h" | "24h";
type UsageWindow = "7d" | "30d" | "90d";
type UsageAnalytics = {
  window: UsageWindow;
  totalEvents: number;
  activeUsers: number;
  avgEventsPerUser: number;
  days: string[];
  daily: { date: string; events: number; users: number }[];
  topUsers: { userId: string; label: string; total: number; daily: number[] }[];
  hourly: number[];
  weekday: number[];
  topTargets: { label: string; count: number }[];
};
type RecentErrors = {
  window: UsageWindow;
  total: number;
  byStatus: { status: number; count: number }[];
  items: { at: string; statusCode: number; method: string; path: string; user: string | null }[];
};

function relativeTime(iso: string | null, at: (typeof AT)[Lang]): string {
  if (!iso) return at.never;
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return at.justNow;
  const m = Math.floor(s / 60);
  // Compact, language-neutral durations (avoids "ago" word-order pitfalls).
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  compact,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-[10px] border flex flex-col gap-1 ${compact ? "p-2.5" : "p-4"}`}
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-color)",
      }}
    >
      <span
        className='text-[10px] font-medium uppercase tracking-wider'
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <span
        className={`font-semibold leading-tight ${compact ? "text-[18px]" : "text-[26px]"}`}
        style={{
          color: accent ? "var(--accent-color)" : "var(--text-primary)",
        }}
      >
        {value}
      </span>
      {sub && (
        <span className='text-[10px]' style={{ color: "var(--text-muted)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function MonitoringPanel({ lang }: { lang: Lang }) {
  const t = AT[lang];
  const [overview, setOverview] = useState<OverviewMetrics | null>(null);
  const [activity, setActivity] = useState<ActivityMetrics | null>(null);
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [err, setErr] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number>(Date.now());

  // Overview refreshes on a slow cadence; it's aggregate & changes slowly.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<OverviewMetrics>("/admin/metrics/overview")
        .then((r) => alive && setOverview(r))
        .catch((e) => alive && setErr(e instanceof Error ? e.message : "Error"));
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Active-users / API-call metrics poll every 3s per the window selection.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<ActivityMetrics>(`/admin/metrics/activity?window=${window}`)
        .then((r) => {
          if (!alive) return;
          setActivity(r);
          setLastTick(Date.now());
        })
        .catch((e) => alive && setErr(e instanceof Error ? e.message : "Error"));
    void load();
    const id = setInterval(load, 3_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [window]);

  return (
    <div className='space-y-6'>
      {err && (
        <div
          className='text-[12px] px-3 py-2 rounded-[6px]'
          style={{ background: "var(--bg-hover)", color: "#c03030" }}
        >
          {err}
        </div>
      )}

      {/* System totals */}
      <div>
        <h3
          className='text-[13px] font-semibold mb-2'
          style={{ color: "var(--text-primary)" }}
        >
          {t.systemOverview}
        </h3>
        <div className='grid gap-3 grid-cols-2 md:grid-cols-4'>
          <KpiCard label={t.totalUsers} value={overview?.totalUsers ?? "—"} />
          <KpiCard
            label={t.active24h}
            value={overview?.activeUsers24h ?? "—"}
            sub={
              overview ? `${overview.inactiveUsers} ${t.inactive}` : undefined
            }
            accent
          />
          <KpiCard
            label={t.admins}
            value={overview?.adminUsers ?? "—"}
            sub={overview ? `${overview.normalUsers} ${t.normal}` : undefined}
          />
          <KpiCard label={t.workspaces} value={overview?.totalWorkspaces ?? "—"} />
          <KpiCard label={t.totalPages} value={overview?.totalPages ?? "—"} />
          <KpiCard
            label={t.storageUsed}
            value={
              overview ? formatBytes(overview.totalStorageBytes) : "—"
            }
          />
        </div>
      </div>

      {/* Windowed activity */}
      <div>
        <div className='flex items-center justify-between mb-2'>
          <h3
            className='text-[13px] font-semibold'
            style={{ color: "var(--text-primary)" }}
          >
            {t.recentActivity}
          </h3>
          <div className='flex items-center gap-2'>
            <span
              className='flex items-center gap-1 text-[11px]'
              style={{ color: "var(--text-muted)" }}
            >
              <span
                className='inline-block w-1.5 h-1.5 rounded-full'
                style={{
                  background: "#2d8a2d",
                  boxShadow: "0 0 0 3px rgba(45,138,45,0.15)",
                }}
              />
              {t.live} · {Math.max(0, Math.round((Date.now() - lastTick) / 1000))}s
            </span>
            <div
              className='flex rounded-[6px] overflow-hidden border'
              style={{ borderColor: "var(--border-color)" }}
            >
              {(["6h", "12h", "24h"] as MetricWindow[]).map((w) => (
                <button
                  key={w}
                  onClick={() => setWindow(w)}
                  className='px-2.5 py-1 text-[12px] transition-colors'
                  style={{
                    background:
                      window === w ? "var(--accent-color)" : "transparent",
                    color:
                      window === w ? "#fff" : "var(--text-muted)",
                  }}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className='grid gap-3 grid-cols-2 md:grid-cols-3'>
          <KpiCard
            label={`${t.activeUsers} · ${window}`}
            value={activity?.activeUsers ?? "—"}
            accent
          />
          <KpiCard
            label={`${t.apiCalls} · ${window}`}
            value={
              activity ? activity.apiCalls.toLocaleString() : "—"
            }
          />
          <KpiCard
            label={`${t.newUsers} · ${window}`}
            value={activity?.newUsers ?? "—"}
          />
        </div>
      </div>
    </div>
  );
}

function UserManagementPanel({ csrf, lang, isDark }: { csrf: string; lang: Lang; isDark: boolean }) {
  const t = AT[lang];
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [activityUser, setActivityUser] = useState<AdminUser | null>(null);

  useEffect(() => {
    api<{ roles: AdminRole[] }>("/admin/roles")
      .then((r) => setRoles(r.roles))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "10",
    });
    if (search.trim()) params.set("search", search.trim());
    api<{
      users: AdminUser[];
      total: number;
      totalPages: number;
    }>(`/admin/users?${params.toString()}`)
      .then((r) => {
        setUsers(r.users);
        setTotal(r.total);
        setTotalPages(r.totalPages);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  }, [page, search]);

  // Debounce search; reset to page 1 when the query changes.
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const changeRole = async (u: AdminUser, roleKey: string) => {
    if (roleKey === u.roleKey) return;
    setSavingId(u.id);
    setErr(null);
    try {
      const r = await api<{ user: { roleKey: string; roleLabel: string } }>(
        `/admin/users/${u.id}/role`,
        { method: "PATCH", body: JSON.stringify({ appRoleKey: roleKey }) },
        csrf,
      );
      setUsers((prev) =>
        prev.map((x) =>
          x.id === u.id
            ? { ...x, roleKey: r.user.roleKey, roleLabel: r.user.roleLabel }
            : x,
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3 flex-wrap'>
        <input
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          placeholder={t.searchUsers}
          className='flex-1 max-w-[320px] px-3 py-1.5 rounded-[6px] text-[13px] outline-none border'
          style={{
            background: "var(--bg-primary)",
            borderColor: "var(--border-color)",
            color: "var(--text-primary)",
          }}
        />
        {/* Count + pager sit at the top so admins never have to scroll to page. */}
        <div className='flex items-center gap-3'>
          <span className='text-[12px]' style={{ color: "var(--text-muted)" }}>
            {total} {t.users}
          </span>
          {totalPages > 1 && (
            <div className='flex items-center gap-2 text-[12px]'>
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className='px-2.5 py-1 rounded-[6px] border disabled:opacity-40'
                style={{
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                }}
              >
                {t.prev}
              </button>
              <span style={{ color: "var(--text-muted)" }}>
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className='px-2.5 py-1 rounded-[6px] border disabled:opacity-40'
                style={{
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                }}
              >
                {t.next}
              </button>
            </div>
          )}
        </div>
      </div>

      {err && (
        <div
          className='text-[12px] px-3 py-2 rounded-[6px]'
          style={{ background: "var(--bg-hover)", color: "#c03030" }}
        >
          {err}
        </div>
      )}

      <div
        className='rounded-[10px] border overflow-hidden'
        style={{ borderColor: "var(--border-color)" }}
      >
        <table className='w-full text-[13px]'>
          <thead>
            <tr
              style={{
                background: "var(--bg-secondary)",
                color: "var(--text-muted)",
              }}
            >
              <th className='text-left font-medium px-3 py-2'>{t.colUser}</th>
              <th className='text-left font-medium px-3 py-2 hidden sm:table-cell'>
                {t.colPages}
              </th>
              <th className='text-left font-medium px-3 py-2 hidden md:table-cell'>
                {t.colLastSeen}
              </th>
              <th className='text-left font-medium px-3 py-2'>{t.colRole}</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className='px-3 py-6 text-center'
                  style={{ color: "var(--text-muted)" }}
                >
                  {t.loading}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className='px-3 py-6 text-center'
                  style={{ color: "var(--text-muted)" }}
                >
                  {t.noUsers}
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr
                  key={u.id}
                  className='border-t'
                  style={{ borderColor: "var(--border-color)" }}
                >
                  <td className='px-3 py-2'>
                    <div
                      className='font-medium'
                      style={{ color: "var(--text-primary)" }}
                    >
                      {u.displayName || u.email.split("@")[0]}
                    </div>
                    <div
                      className='text-[11px]'
                      style={{ color: "var(--text-muted)" }}
                    >
                      {u.email}
                    </div>
                  </td>
                  <td
                    className='px-3 py-2 hidden sm:table-cell'
                    style={{ color: "var(--text-muted)" }}
                  >
                    {u.pageCount}
                  </td>
                  <td
                    className='px-3 py-2 hidden md:table-cell'
                    style={{ color: "var(--text-muted)" }}
                  >
                    {relativeTime(u.lastSeenAt, t)}
                  </td>
                  <td className='px-3 py-2'>
                    <div className='flex items-center gap-2 flex-wrap'>
                      <select
                        value={u.roleKey}
                        disabled={savingId === u.id}
                        onChange={(e) => void changeRole(u, e.target.value)}
                        className='px-2 py-1 rounded-[6px] text-[12px] outline-none border'
                        style={{
                          background: "var(--bg-primary)",
                          borderColor: "var(--border-color)",
                          color: "var(--text-primary)",
                        }}
                      >
                        {roles.map((r) => (
                          <option key={r.key} value={r.key}>
                            {t.roles[r.key] ?? r.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type='button'
                        onClick={() => setActivityUser(u)}
                        className='px-2 py-1 rounded-[6px] border text-[12px] transition-colors'
                        style={{
                          borderColor: "var(--border-color)",
                          color: "var(--text-muted)",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = "var(--bg-hover)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = "transparent")
                        }
                      >
                        View activity
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {activityUser && (
        <ProfileActivityDrawer
          onClose={() => setActivityUser(null)}
          endpoint={`/admin/users/${activityUser.id}/activity`}
          title={`${activityUser.displayName || activityUser.email.split("@")[0]}'s activity`}
          subtitle={activityUser.email}
          isDark={isDark}
        />
      )}
    </div>
  );
}

// Distinct series colors for the top-5-users composite chart.
const ANALYSIS_SERIES = ["#2383e2", "#e0a13b", "#3bb273", "#c85c5c", "#8b6fc4"];

// Red for 5xx (server errors), amber for 4xx (client/permission errors).
function analysisStatusColor(status: number): string {
  return status >= 500 ? "#c0504d" : "#d98a2b";
}

function AnalysisPanel({ lang, isDark }: { lang: Lang; isDark: boolean }) {
  const t = AT[lang];
  const [window, setWindow] = useState<UsageWindow>("7d");
  const [data, setData] = useState<UsageAnalytics | null>(null);
  const [errorsLog, setErrorsLog] = useState<RecentErrors | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Auto-refresh so the dashboard shows the latest data; adjustable in the UI.
  const [refreshSec, setRefreshSec] = useState(5);
  // Flash the blue bulb once per auto-refresh so it's visible data is being pulled.
  const [refreshFlash, setRefreshFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const [usage, errors] = await Promise.all([
          api<UsageAnalytics>(`/admin/analytics/usage?window=${window}`),
          api<RecentErrors>(`/admin/errors?window=${window}`).catch(() => null),
        ]);
        setData(usage);
        setErrorsLog(errors);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Error");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [window],
  );

  // Load on mount / window change (with the spinner), then silently on interval.
  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => {
      setRefreshFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setRefreshFlash(false), 450);
      void load(true);
    }, refreshSec * 1000);
    return () => {
      clearInterval(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [load, refreshSec]);

  const chartText = isDark ? "#e6e6e5" : "#37352f";
  const chartMuted = isDark ? "rgba(230,230,229,0.6)" : "rgba(80,80,80,0.72)";
  const chartGrid = isDark ? "rgba(255,255,255,0.08)" : "rgba(127,127,127,0.12)";

  const dayLabels = useMemo(
    () =>
      (data?.days ?? []).map((d) => {
        const dt = new Date(`${d}T00:00:00Z`);
        return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
      }),
    [data?.days],
  );

  const baseOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index" as const, intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: chartMuted, boxWidth: 10, font: { size: 10 } },
        },
        tooltip: {
          backgroundColor: isDark ? "rgba(20,20,20,0.96)" : "rgba(255,255,255,0.96)",
          titleColor: chartText,
          bodyColor: chartText,
          borderColor: chartGrid,
          borderWidth: 1,
        },
      },
      scales: {
        x: { grid: { color: chartGrid }, ticks: { color: chartMuted, font: { size: 9 }, maxRotation: 0, autoSkip: true } },
        y: { grid: { color: chartGrid }, ticks: { color: chartMuted, font: { size: 9 }, precision: 0 }, beginAtZero: true },
      },
    }),
    [chartText, chartMuted, chartGrid, isDark],
  );

  // Daily usage: events area + active-users line on a secondary axis.
  const trendData = useMemo(
    () => ({
      labels: dayLabels,
      datasets: [
        {
          label: t.totalEvents,
          data: (data?.daily ?? []).map((d) => d.events),
          borderColor: "#2383e2",
          backgroundColor: "rgba(35,131,226,0.18)",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "y",
        },
        {
          label: t.activeUsers,
          data: (data?.daily ?? []).map((d) => d.users),
          borderColor: "#3bb273",
          backgroundColor: "#3bb273",
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "y1",
        },
      ],
    }),
    [dayLabels, data?.daily, t.totalEvents, t.activeUsers],
  );
  const trendOptions = useMemo(
    () => ({
      ...baseOptions,
      scales: {
        ...baseOptions.scales,
        y1: {
          position: "right" as const,
          grid: { drawOnChartArea: false },
          ticks: { color: chartMuted, font: { size: 9 }, precision: 0 },
          beginAtZero: true,
        },
      },
    }),
    [baseOptions, chartMuted],
  );

  // Top 5 users — stacked area (composite of each user's daily usage).
  const topUsersData = useMemo(
    () => ({
      labels: dayLabels,
      datasets: (data?.topUsers ?? []).map((u, i) => {
        const color = ANALYSIS_SERIES[i % ANALYSIS_SERIES.length]!;
        return {
          label: u.label,
          data: u.daily,
          borderColor: color,
          backgroundColor: `${color}44`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
        };
      }),
    }),
    [dayLabels, data?.topUsers],
  );
  const stackedOptions = useMemo(
    () => ({
      ...baseOptions,
      scales: {
        x: { ...baseOptions.scales.x, stacked: true },
        y: { ...baseOptions.scales.y, stacked: true },
      },
    }),
    [baseOptions],
  );

  const hourData = useMemo(
    () => ({
      labels: Array.from({ length: 24 }, (_, h) => `${h}`),
      datasets: [
        {
          label: t.totalEvents,
          data: data?.hourly ?? [],
          backgroundColor: "rgba(35,131,226,0.7)",
          borderRadius: 3,
        },
      ],
    }),
    [data?.hourly, t.totalEvents],
  );

  // Postgres DOW is 0=Sun..6=Sat; present Mon-first.
  const weekdayData = useMemo(() => {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return {
      labels,
      datasets: [
        {
          label: t.totalEvents,
          data: order.map((i) => data?.weekday?.[i] ?? 0),
          backgroundColor: "rgba(59,178,115,0.7)",
          borderRadius: 3,
        },
      ],
    };
  }, [data?.weekday, t.totalEvents]);

  const targetData = useMemo(
    () => ({
      labels: (data?.topTargets ?? []).map((x) => x.label),
      datasets: [
        {
          label: t.totalEvents,
          data: (data?.topTargets ?? []).map((x) => x.count),
          backgroundColor: "rgba(224,161,59,0.75)",
          borderRadius: 3,
        },
      ],
    }),
    [data?.topTargets, t.totalEvents],
  );
  const horizontalOptions = useMemo(
    () => ({
      ...baseOptions,
      indexAxis: "y" as const,
      plugins: { ...baseOptions.plugins, legend: { display: false } },
    }),
    [baseOptions],
  );
  const barOptions = useMemo(
    () => ({ ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: false } } }),
    [baseOptions],
  );

  return (
    <div className='space-y-6'>
      {err && (
        <div className='text-[12px] px-3 py-2 rounded-[6px]' style={{ background: "var(--bg-hover)", color: "#c03030" }}>
          {err}
        </div>
      )}

      {/* Window selector + auto-refresh */}
      <div className='flex items-center gap-1 flex-wrap'>
        {(["7d", "30d", "90d"] as const).map((w) => (
          <button
            key={w}
            onClick={() => setWindow(w)}
            className='px-3 py-1.5 text-[12px] rounded-[6px] border transition-colors'
            style={{
              borderColor: window === w ? "var(--accent-color)" : "var(--border-color)",
              color: window === w ? "var(--accent-color)" : "var(--text-muted)",
              background: window === w ? "rgba(35,131,226,0.08)" : "transparent",
            }}
          >
            {w}
          </button>
        ))}
        {loading && (
          <span className='text-[11px] ml-2' style={{ color: "var(--text-muted)" }}>
            {t.loading}
          </span>
        )}
        <div className='ml-auto flex items-center gap-1.5'>
          <span
            className='inline-block w-1.5 h-1.5 rounded-full transition-all duration-150'
            title={t.autoRefresh}
            style={{
              background: "var(--accent-color)",
              opacity: refreshFlash ? 1 : 0.55,
              boxShadow: refreshFlash ? "0 0 8px 3px rgba(35,131,226,0.85)" : "none",
              transform: refreshFlash ? "scale(1.6)" : "scale(1)",
            }}
          />
          <span className='text-[11px]' style={{ color: "var(--text-muted)" }}>
            {t.autoRefresh}
          </span>
          <select
            value={refreshSec}
            onChange={(e) => setRefreshSec(Number(e.target.value))}
            className='rounded-[6px] border px-2 py-1 text-[11px] outline-none'
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              borderColor: "var(--border-color)",
            }}
          >
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
          </select>
        </div>
      </div>

      {/* KPIs */}
      <div className='grid gap-3 grid-cols-3'>
        <KpiCard label={t.totalEvents} value={data?.totalEvents ?? "—"} accent />
        <KpiCard label={t.activeUsers} value={data?.activeUsers ?? "—"} />
        <KpiCard label={t.avgPerUser} value={data?.avgEventsPerUser ?? "—"} />
      </div>

      {/* Daily usage trend */}
      <section>
        <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>{t.usageTrend}</h3>
        <div className='h-[220px] rounded-[10px] border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }}>
          <Line data={trendData} options={trendOptions} />
        </div>
      </section>

      {/* Top 5 users (composite) */}
      <section>
        <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>{t.topUsersUsage}</h3>
        <div className='h-[240px] rounded-[10px] border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }}>
          <Line data={topUsersData} options={stackedOptions} />
        </div>
      </section>

      {/* When: hour-of-day + weekday */}
      <div className='grid gap-4 md:grid-cols-2'>
        <section>
          <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>{t.peakHours}</h3>
          <div className='h-[200px] rounded-[10px] border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }}>
            <Bar data={hourData} options={barOptions} />
          </div>
        </section>
        <section>
          <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>{t.byWeekday}</h3>
          <div className='h-[200px] rounded-[10px] border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }}>
            <Bar data={weekdayData} options={barOptions} />
          </div>
        </section>
      </div>

      {/* Focus areas */}
      <section>
        <h3 className='text-[13px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>{t.focusAreas}</h3>
        <div className='h-[260px] rounded-[10px] border p-3' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }}>
          <Bar data={targetData} options={horizontalOptions} />
        </div>
      </section>

      {/* Recent errors (troubleshooting log) */}
      <section>
        <div className='flex items-center gap-2 mb-2'>
          <h3 className='text-[13px] font-semibold' style={{ color: "var(--text-primary)" }}>{t.recentErrors}</h3>
          {errorsLog && errorsLog.byStatus.length > 0 && (
            <div className='flex gap-1'>
              {errorsLog.byStatus.slice(0, 5).map((s) => (
                <span
                  key={s.status}
                  className='text-[10px] font-medium px-1.5 py-0.5 rounded tabular-nums'
                  style={{ background: analysisStatusColor(s.status), color: "#fff" }}
                >
                  {s.status}·{s.count}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className='rounded-[10px] border overflow-hidden' style={{ borderColor: "var(--border-color)" }}>
          {!errorsLog || errorsLog.items.length === 0 ? (
            <p className='text-[12px] px-3 py-6 text-center' style={{ color: "var(--text-muted)" }}>
              {loading ? t.loading : "—"}
            </p>
          ) : (
            <div className='max-h-[320px] overflow-y-auto'>
              {errorsLog.items.map((e, i) => (
                <div
                  key={i}
                  className='grid items-center gap-2 px-3 py-1.5 text-[12px] border-b last:border-0'
                  style={{ borderColor: "var(--border-color)", gridTemplateColumns: "48px 52px 1fr auto" }}
                >
                  <span className='font-semibold tabular-nums' style={{ color: analysisStatusColor(e.statusCode) }}>
                    {e.statusCode}
                  </span>
                  <span className='font-mono text-[11px]' style={{ color: "var(--text-muted)" }}>{e.method}</span>
                  <span className='truncate font-mono text-[11px]' style={{ color: "var(--text-primary)" }} title={e.path}>
                    {e.path}
                  </span>
                  <span className='text-[10px] whitespace-nowrap text-right' style={{ color: "var(--text-muted)" }} title={e.user ?? ""}>
                    {e.user ? e.user.split("@")[0] : "—"} · {formatSearchUpdated(e.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ConfigurationManager({ csrf, lang, isDark }: { csrf: string; lang: Lang; isDark: boolean }) {
  const t = AT[lang];
  const [tab, setTab] = useState<"monitoring" | "analysis" | "users">("monitoring");
  return (
    <div className='max-w-[1040px] mx-auto px-5 py-6 sm:px-8 sm:py-10 w-full' data-analytics-zone='admin-dashboard'>
      <div className='mb-1 flex items-center gap-2'>
        <span style={{ color: "var(--accent-color)" }}>
          <Ico.Settings />
        </span>
        <h1
          className='text-[22px] font-semibold'
          style={{ color: "var(--text-primary)" }}
        >
          {t.configManager}
        </h1>
      </div>
      <p className='text-[13px] mb-5' style={{ color: "var(--text-muted)" }}>
        {t.configSubtitle}
      </p>

      <div
        className='flex gap-1 mb-5 border-b'
        style={{ borderColor: "var(--border-color)" }}
      >
        {(
          [
            ["monitoring", t.monitoring],
            ["analysis", t.analysis],
            ["users", t.userManagement],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className='px-3 py-2 text-[13px] font-medium -mb-px border-b-2 transition-colors'
            style={{
              borderColor: tab === key ? "var(--accent-color)" : "transparent",
              color: tab === key ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "monitoring" ? (
        <MonitoringPanel lang={lang} />
      ) : tab === "analysis" ? (
        <AnalysisPanel lang={lang} isDark={isDark} />
      ) : (
        <UserManagementPanel csrf={csrf} lang={lang} isDark={isDark} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────

// Live "transaction monitor" — a Task-Manager-style rolling chart of how many
// actions were captured (for stats upload) in each of the last 15 seconds, plus
// a light bulb that pulses green on every successful API transaction.
// ── Fun: orange "lego"-style critters that waddle across the top bar ─────────
// The critters that can swim across the top of the app. Each sprite faces
// RIGHT by default; the engine flips it with scaleX(-1) when swimming left.
const ANIMAL_KEYS = ["fish", "crab", "squid"] as const;
type AnimalKey = (typeof ANIMAL_KEYS)[number];
type Quantity = "single" | "few" | "many";

// A blue swordfish, an orange crab, a pink squid — all drawn at `px` wide.
function AnimalSprite({ type, px }: { type: AnimalKey; px: number }) {
  if (type === "fish") {
    // Blue swordfish — the earlier, nicer silhouette (bill to the right,
    // tail to the left), recoloured in ocean blues.
    return (
      <svg viewBox='0 0 26 16' width={px} height={(px * 16) / 26}>
        <path d='M18 6.5 L26 8 L18 9.5 z' fill='#7cc0f5' />
        <path d='M4 8 L0 3.5 L1.6 8 L0 12.5 z' fill='#1f6fb0' />
        <ellipse cx='11' cy='8' rx='8' ry='4.2' fill='#2b8fe0' />
        <ellipse cx='11' cy='9.4' rx='5.5' ry='2' fill='#bfe0ff' />
        <path d='M9 4 L12 1.2 L14.5 4 z' fill='#1f6fb0' />
        <path d='M11 11 L9 15 L13.5 11.5 z' fill='#1a5f98' />
        <circle cx='15' cy='7' r='1.4' fill='#fff' />
        <circle cx='15.2' cy='7' r='0.85' fill='#08283f' />
      </svg>
    );
  }
  if (type === "squid") {
    return (
      <svg viewBox='0 0 26 18' width={px} height={(px * 18) / 26}>
        <path
          d='M9 9 q-5 0 -8 3 M9 10.5 q-5 2 -8 3 M9 7.5 q-5 -1 -8 -2 M9 11.5 q-4 3 -6 5 M9 6.5 q-4 -2 -6 -5'
          stroke='#c23b7a'
          strokeWidth='1.5'
          fill='none'
          strokeLinecap='round'
        />
        <path d='M8 9 Q13 2.4 22 6 Q26 9 22 12 Q13 15.6 8 9 Z' fill='#ec5a9e' />
        <ellipse cx='16' cy='7.6' rx='5' ry='1.9' fill='#ff9ecb' />
        <circle cx='12' cy='8.6' r='1.9' fill='#fff' />
        <circle cx='12.5' cy='8.6' r='1' fill='#3a1030' />
      </svg>
    );
  }
  return (
    <svg viewBox='0 0 24 18' width={px} height={(px * 18) / 24}>
      <path d='M6 11 l-4 3 M8 13 l-3 4 M16 13 l3 4 M18 11 l4 3' stroke='#c25c14' strokeWidth='1.8' strokeLinecap='round' fill='none' />
      <circle cx='4' cy='7' r='3.2' fill='#e0721c' />
      <circle cx='20' cy='7' r='3.2' fill='#e0721c' />
      <rect x='6' y='6' width='12' height='8' rx='4' fill='#ec7a24' />
      <rect x='9' y='2.5' width='1.6' height='4' fill='#c25c14' />
      <rect x='13' y='2.5' width='1.6' height='4' fill='#c25c14' />
      <circle cx='9.8' cy='2.5' r='1.4' fill='#3a1c06' />
      <circle cx='13.8' cy='2.5' r='1.4' fill='#3a1c06' />
    </svg>
  );
}

// ── Critter roster: how many units, of what size, for each quantity mode ─────
// single = 1 big one; few = 5 (one 3×, four 2×); many = a 14-strong shoal
// (two 3×, two 2×, ten 1×). Types are round-robined across the enabled ones.
function buildRoster(types: AnimalKey[], quantity: Quantity): { type: AnimalKey; size: number }[] {
  const enabled = types.length ? types : (["fish"] as AnimalKey[]);
  const sizes =
    quantity === "single"
      ? [3]
      : quantity === "few"
        ? [3, 2, 2, 2, 2]
        : [3, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  return sizes.map((size, i) => ({ type: enabled[i % enabled.length]!, size }));
}

// Base sprite width (px) for a 1× unit; multiplied by the size (1/2/3).
const CRITTER_BASE = 22;
// Overall pace: level 1 is a calm drift, level 3 zippy. Default is 1.
const SPEED_FACTOR: Record<1 | 2 | 3, number> = { 1: 0.55, 2: 1, 3: 1.7 };

interface Critter {
  type: AnimalKey;
  size: number;
  w: number;
  h: number;
  mountW: number; // sprite px at mount (for runtime scaling when a crab grows)
  mountH: number; // sprite px height at mount
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number; // 1 = right, -1 = left
  speed: number; // per-animal base px/s
  rest: number; // crab rest countdown (ms)
  burst: number; // squid jet velocity remaining
  nextAct: number; // timestamp of next random special action
  anchorY: number; // preferred vertical band (keeps a school tight)
  dead: boolean; // squid eaten by a crab
  inkUntil: number; // squid ink-defence active until (ms)
  inkCd: number; // squid can ink again after (ms)
  flipUntil: number; // crab tumbled upside-down until (ms)
}

function critterDims(type: AnimalKey, size: number): { w: number; h: number } {
  const w = size * (type === "crab" ? CRITTER_BASE * 0.95 : CRITTER_BASE * 1.1);
  const ratio = type === "crab" ? 18 / 24 : type === "squid" ? 18 / 26 : 16 / 26;
  return { w, h: w * ratio };
}

// A short-lived ink cloud puffed out behind a squid's special action.
function spawnInk(field: HTMLDivElement, c: Critter) {
  const ink = document.createElement("div");
  ink.className = "squid-ink";
  ink.style.left = `${(c.face === 1 ? c.x : c.x + c.w) - 4}px`;
  ink.style.top = `${c.y + c.h / 2 - 4}px`;
  field.appendChild(ink);
  window.setTimeout(() => ink.remove(), 1200);
}

// The animation field: a JS/rAF engine so each critter can have its own speed,
// vertical drift, resting, jetting and random flourishes. It overlays the top
// bar and spills a little below it, giving the animals "double" the room.
function CritterField({ types, quantity, speed }: { types: AnimalKey[]; quantity: Quantity; speed: 1 | 2 | 3 }) {
  // On mobile viewports the animation is capped at a single animal regardless of
  // the crowd setting — the rAF engine is too heavy for small devices otherwise.
  const [mobile, setMobile] = useState(isMobileViewport);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effQuantity: Quantity = mobile ? "single" : quantity;
  const roster = useMemo(() => buildRoster(types, effQuantity), [types, effQuantity]);
  const fieldRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<(HTMLDivElement | null)[]>([]);
  // "many" = tight, same-type schools that swim as one. Other modes let every
  // animal roam the whole width independently.
  const schooling = effQuantity === "many";

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let W = field.clientWidth || 400;
    let H = field.clientHeight || 88;
    const spdF = SPEED_FACTOR[speed];
    const now0 = performance.now();
    // A node may still be hidden from an eaten squid in a previous run; revive it.
    for (const n of nodesRef.current) if (n) n.style.display = "";

    // One school per enabled type (only used in "many" mode): a shared heading,
    // a shared cruising speed and a home column/row the members cluster around.
    type School = { dir: number; speed: number; anchorX: number; anchorY: number };
    const schools = new Map<AnimalKey, School>();
    if (schooling) {
      for (const r of roster) {
        if (schools.has(r.type)) continue;
        schools.set(r.type, {
          dir: Math.random() < 0.5 ? 1 : -1,
          speed: 34 + Math.random() * 30,
          anchorX: W * (0.2 + Math.random() * 0.6),
          anchorY: r.type === "crab" ? H : H * (0.15 + Math.random() * 0.5),
        });
      }
    }

    const crs: Critter[] = roster.map((r) => {
      const { w, h } = critterDims(r.type, r.size);
      const school = schools.get(r.type);
      const face = school ? school.dir : Math.random() < 0.5 ? 1 : -1;
      // Fish come in fast/normal/slow; crabs vary; squid drift slowly and jet.
      const base =
        r.type === "fish"
          ? 46 + Math.random() * 78
          : r.type === "crab"
            ? 28 + Math.random() * 40
            : 26 + Math.random() * 26;
      const anchorY =
        r.type === "crab"
          ? H - h - 2
          : school
            ? Math.max(0, Math.min(H - h, school.anchorY + (Math.random() - 0.5) * 22))
            : Math.random() * Math.max(1, H - h);
      const x = school
        ? Math.max(0, Math.min(W - w, school.anchorX + (Math.random() - 0.5) * 46))
        : Math.random() * Math.max(1, W - w);
      return {
        type: r.type,
        size: r.size,
        w,
        h,
        mountW: w,
        mountH: h,
        x,
        y: anchorY,
        vx: face * base,
        vy: 0,
        face,
        speed: school ? school.speed : base,
        rest: 0,
        burst: 0,
        nextAct: now0 + 1800 + Math.random() * 4500,
        anchorY,
        dead: false,
        inkUntil: 0,
        inkCd: 0,
        flipUntil: 0,
      };
    });

    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      W = field.clientWidth || W;
      H = field.clientHeight || H;

      // ── each school turns as one when its leading edge reaches a wall ──
      if (schooling) {
        for (const [type, s] of schools) {
          let minX = Infinity;
          let maxRight = -Infinity;
          for (const c of crs) {
            if (c.dead || c.type !== type) continue;
            if (c.x < minX) minX = c.x;
            if (c.x + c.w > maxRight) maxRight = c.x + c.w;
          }
          if (maxRight === -Infinity) continue;
          if (s.dir === 1 && maxRight >= W - 1) s.dir = -1;
          else if (s.dir === -1 && minX <= 1) s.dir = 1;
        }
      }

      for (let i = 0; i < crs.length; i++) {
        const c = crs[i]!;
        if (c.dead) continue;
        const school = schooling ? schools.get(c.type) : undefined;
        const maxX = Math.max(1, W - c.w);
        const maxY = Math.max(1, H - c.h);

        // ── random special flourishes ──
        if (now >= c.nextAct) {
          c.nextAct = now + 2600 + Math.random() * 5200;
          if (c.type === "fish") {
            c.burst = 40 + Math.random() * 60; // a quick dart forward
          } else if (c.type === "crab") {
            if (c.flipUntil <= now) c.rest = 700 + Math.random() * 1800;
          } else if (now >= c.inkCd) {
            c.burst = 80 + Math.random() * 70;
            spawnInk(field, c);
            c.inkUntil = now + 1100;
            c.inkCd = now + 2600;
          }
        }

        // ── per-type movement ──
        if (c.type === "fish") {
          const dir = school ? school.dir : c.face;
          c.vx = dir * (c.speed + c.burst) * spdF;
          c.burst *= 0.9;
          if (c.burst < 2) c.burst = 0;
          if (school) {
            // hug the school's row so same-type fish stay clustered
            c.vy = (c.anchorY - c.y) * 3;
          } else {
            if (Math.random() < 0.02) c.vy = (Math.random() - 0.5) * 40 * spdF;
            c.vy *= 0.98;
          }
        } else if (c.type === "crab") {
          if (c.flipUntil > now) {
            c.vx = 0; // tumbled upside-down, playing dead
          } else if (c.rest > 0) {
            c.rest -= dt * 1000;
            c.vx = 0;
          } else {
            const dir = school ? school.dir : c.face;
            c.vx = dir * c.speed * spdF;
          }
          c.vy = 0;
          // keep the (centre-scaled) sprite's feet on the floor as it grows
          c.y = H - 2 - c.mountH / 2 - c.h / 2;
        } else {
          // squid: jet in pulses, then coast — never a constant speed
          if (c.burst > 0) {
            const dir = school ? school.dir : c.face;
            c.vx = dir * (c.speed + c.burst) * spdF;
            c.vy += (Math.random() - 0.5) * 26;
            c.burst *= 0.92;
            if (c.burst < 3) c.burst = 0;
          } else {
            c.vx *= 0.95;
            c.vy *= 0.95;
          }
          if (school) c.vy += (c.anchorY - c.y) * 1.4 * dt;
          c.vy = Math.max(-70, Math.min(70, c.vy));
        }

        // ── integrate + bounce off the field edges ──
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        if (c.type !== "crab") {
          if (c.y < 0) {
            c.y = 0;
            c.vy = Math.abs(c.vy);
          } else if (c.y > maxY) {
            c.y = maxY;
            c.vy = -Math.abs(c.vy);
          }
        }
        if (c.x < 0) {
          c.x = 0;
          if (!school) c.face = 1;
          c.vx = Math.abs(c.vx);
        } else if (c.x > maxX) {
          c.x = maxX;
          if (!school) c.face = -1;
          c.vx = -Math.abs(c.vx);
        }
      }

      // ── crab ⇄ squid encounters ──
      for (const crab of crs) {
        if (crab.dead || crab.type !== "crab") continue;
        // the crab scales around its centre, so derive its live box from that
        const crabCx = crab.x + crab.mountW / 2;
        const crabCy = crab.y + crab.mountH / 2;
        const crabL = crabCx - crab.w / 2;
        const crabR = crabCx + crab.w / 2;
        const crabT = crabCy - crab.h / 2;
        const crabB = crabCy + crab.h / 2;
        for (const squid of crs) {
          if (squid.dead || squid.type !== "squid") continue;
          const overlap =
            crabL < squid.x + squid.w &&
            crabR > squid.x &&
            crabT < squid.y + squid.h &&
            crabB > squid.y;
          if (!overlap) continue;
          if (squid.inkUntil > now) {
            // ink defence: the crab tumbles upside-down for 2s, the squid flees
            if (crab.flipUntil <= now) {
              crab.flipUntil = now + 2000;
              crab.rest = 0;
            }
            squid.burst = Math.max(squid.burst, 120);
            squid.face = squid.x < crab.x ? -1 : 1;
          } else {
            // no ink ready → the crab eats the squid and grows one level
            squid.dead = true;
            const node = nodesRef.current[crs.indexOf(squid)];
            if (node) node.style.display = "none";
            crab.size = Math.min(4, crab.size + 1);
            const dims = critterDims("crab", crab.size);
            crab.w = dims.w;
            crab.h = dims.h;
          }
        }
      }

      // ── write transforms ──
      for (let i = 0; i < crs.length; i++) {
        const c = crs[i]!;
        const node = nodesRef.current[i];
        if (!node || c.dead) continue;
        const dir = schooling ? schools.get(c.type)?.dir ?? c.face : c.face;
        const scale = c.w / c.mountW;
        const flip = c.type === "crab" && c.flipUntil > now ? " rotate(180deg)" : "";
        node.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) scaleX(${dir}) scale(${scale.toFixed(3)})${flip}`;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [roster, speed, schooling]);

  if (roster.length === 0) return null;
  return (
    <div ref={fieldRef} className='critter-field' aria-hidden='true'>
      {roster.map((r, i) => (
        <div
          key={i}
          ref={(el) => {
            nodesRef.current[i] = el;
          }}
          className='critter-unit'
        >
          <AnimalSprite type={r.type} px={critterDims(r.type, r.size).w} />
        </div>
      ))}
    </div>
  );
}


// ── Fun & animation settings: a roomy panel for the critters + typing FX ─────
function FunToggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <label className='flex items-center justify-between gap-3 cursor-pointer py-1.5'>
      <span className='text-[13px]' style={{ color: "var(--text-primary)" }}>
        {label}
      </span>
      <button
        type='button'
        role='switch'
        aria-checked={on}
        onClick={onClick}
        className='relative w-10 h-5.5 rounded-full transition-colors shrink-0'
        style={{ width: 40, height: 22, background: on ? "var(--accent-color)" : "var(--bg-active)" }}
      >
        <span
          className='absolute top-0.5 w-[18px] h-[18px] rounded-full bg-white transition-all'
          style={{ left: on ? "20px" : "2px" }}
        />
      </button>
    </label>
  );
}

function FunSettingsModal({
  open,
  onClose,
  animals,
  quantity,
  speed,
  sparkle,
  combo,
  onAnimals,
  onQuantity,
  onSpeed,
  onSparkle,
  onCombo,
}: {
  open: boolean;
  onClose: () => void;
  animals: AnimalKey[];
  quantity: Quantity;
  speed: 1 | 2 | 3;
  sparkle: boolean;
  combo: boolean;
  onAnimals: (v: AnimalKey[]) => void;
  onQuantity: (v: Quantity) => void;
  onSpeed: (v: 1 | 2 | 3) => void;
  onSparkle: (v: boolean) => void;
  onCombo: (v: boolean) => void;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  const typeMeta: { key: AnimalKey; label: string }[] = [
    { key: "fish", label: t.funFish },
    { key: "crab", label: t.funCrab },
    { key: "squid", label: t.funSquid },
  ];
  const qtyMeta: { key: Quantity; label: string; count: string; hint: string }[] = [
    { key: "single", label: t.funSingle, count: "1", hint: t.funSingleHint },
    { key: "few", label: t.funFew, count: "5", hint: t.funFewHint },
    { key: "many", label: t.funMany, count: "14", hint: t.funManyHint },
  ];
  const cardStyle = (on: boolean): React.CSSProperties => ({
    borderColor: on ? "var(--accent-color)" : "var(--border-color)",
    background: on ? "rgba(35,131,226,0.08)" : "transparent",
  });

  return (
    <div
      className='fixed inset-0 z-[80] flex items-center justify-center p-4'
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className='w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden'
        style={{ background: "var(--bg-primary)", borderColor: "var(--border-color)" }}
      >
        {/* Header */}
        <div
          className='flex items-center justify-between px-5 py-3.5 border-b'
          style={{ borderColor: "var(--border-color)" }}
        >
          <h2 className='text-[15px] font-semibold' style={{ color: "var(--text-primary)" }}>
            {t.funTitle}
          </h2>
          <button
            type='button'
            onClick={onClose}
            className='w-7 h-7 rounded-[6px] flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]'
            style={{ color: "var(--text-muted)" }}
            aria-label='Close'
          >
            ✕
          </button>
        </div>

        <div className='px-5 py-4 space-y-5 max-h-[75vh] overflow-y-auto'>
          {/* Which critters */}
          <div>
            <div className='text-[11px] font-semibold uppercase tracking-wide mb-2' style={{ color: "var(--text-muted)" }}>
              {t.funAnimals}
            </div>
            <div className='grid grid-cols-3 gap-2'>
              {typeMeta.map(({ key, label }) => {
                const on = animals.includes(key);
                return (
                  <button
                    key={key}
                    type='button'
                    aria-pressed={on}
                    onClick={() => onAnimals(on ? animals.filter((x) => x !== key) : [...animals, key])}
                    className='flex flex-col items-center gap-1.5 rounded-[10px] border py-3 transition-all'
                    style={{ ...cardStyle(on), opacity: on ? 1 : 0.5 }}
                  >
                    <span className='flex h-8 items-center'>
                      <AnimalSprite type={key} px={CRITTER_BASE * 1.5} />
                    </span>
                    <span className='text-[12px] font-medium' style={{ color: on ? "var(--accent-color)" : "var(--text-muted)" }}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* How many */}
          <div>
            <div className='text-[11px] font-semibold uppercase tracking-wide mb-2' style={{ color: "var(--text-muted)" }}>
              {t.funCrowd}
            </div>
            <div className='grid grid-cols-3 gap-2'>
              {qtyMeta.map(({ key, label, count, hint }) => {
                const on = quantity === key;
                return (
                  <button
                    key={key}
                    type='button'
                    aria-pressed={on}
                    onClick={() => onQuantity(key)}
                    className='flex flex-col items-center gap-0.5 rounded-[10px] border py-2.5 px-1 transition-all'
                    style={cardStyle(on)}
                  >
                    <span className='text-[18px] font-bold leading-none' style={{ color: on ? "var(--accent-color)" : "var(--text-primary)" }}>
                      {count}
                    </span>
                    <span className='text-[12px] font-medium' style={{ color: on ? "var(--accent-color)" : "var(--text-muted)" }}>
                      {label}
                    </span>
                    <span className='text-[10px] text-center leading-tight mt-0.5' style={{ color: "var(--text-muted)" }}>
                      {hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Speed */}
          <div>
            <div className='text-[11px] font-semibold uppercase tracking-wide mb-2' style={{ color: "var(--text-muted)" }}>
              {t.funSpeed}
            </div>
            <div className='grid grid-cols-3 gap-2'>
              {([1, 2, 3] as const).map((lv) => {
                const on = speed === lv;
                const label = lv === 1 ? t.funSlow : lv === 3 ? t.funFast : t.funMedium;
                return (
                  <button
                    key={lv}
                    type='button'
                    aria-pressed={on}
                    onClick={() => onSpeed(lv)}
                    className='rounded-[10px] border py-2 text-[12px] font-medium transition-all'
                    style={{ ...cardStyle(on), color: on ? "var(--accent-color)" : "var(--text-muted)" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Typing effects */}
          <div className='pt-1 border-t' style={{ borderColor: "var(--border-color)" }}>
            <div className='text-[11px] font-semibold uppercase tracking-wide mt-3 mb-1' style={{ color: "var(--text-muted)" }}>
              {t.funTypingEffects}
            </div>
            <FunToggle on={sparkle} onClick={() => onSparkle(!sparkle)} label={t.funSparkles} />
            <FunToggle on={combo} onClick={() => onCombo(!combo)} label={t.funCombo} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Fun: typing sparkles + combo counter (no screen shake) ──────────────────
function getCaretPoint(): { x: number; y: number } | null {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (r && (r.width || r.height || r.x || r.y)) return { x: r.right, y: r.top + r.height / 2 };
  }
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width - 10, 60), y: r.top + r.height / 2 };
  }
  return null;
}

function TypingFx({ sparkle, combo }: { sparkle: boolean; combo: boolean }) {
  const [particles, setParticles] = useState<
    { id: number; x: number; y: number; dx: number; dy: number; color: string }[]
  >([]);
  const [comboCount, setComboCount] = useState(0);
  const [comboVisible, setComboVisible] = useState(false);
  const comboRef = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);
  const lastSpawn = useRef(0);

  useEffect(() => {
    if (!sparkle && !combo) return;
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const editable =
        !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (!editable) return;
      const isChar = e.key.length === 1 || e.key === "Backspace" || e.key === "Enter";
      if (!isChar || e.ctrlKey || e.metaKey) return;

      if (sparkle) {
        const now = Date.now();
        if (now - lastSpawn.current > 35) {
          lastSpawn.current = now;
          const pt = getCaretPoint();
          if (pt) {
            const colors = ["#f5721e", "#ff9e3d", "#ffb066", "#ffd08a"];
            const news = Array.from({ length: 4 }, () => {
              const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
              const dist = 14 + Math.random() * 22;
              return {
                id: idRef.current++,
                x: pt.x,
                y: pt.y,
                dx: Math.cos(ang) * dist,
                dy: Math.sin(ang) * dist,
                color: colors[Math.floor(Math.random() * colors.length)]!,
              };
            });
            setParticles((p) => [...p.slice(-36), ...news]);
            const ids = new Set(news.map((n) => n.id));
            setTimeout(() => setParticles((p) => p.filter((q) => !ids.has(q.id))), 620);
          }
        }
      }

      if (combo) {
        comboRef.current += 1;
        setComboCount(comboRef.current);
        if (comboRef.current >= 10) setComboVisible(true);
        // Every 100 hits: a brief celebratory screen shake.
        if (comboRef.current % 100 === 0) {
          document.body.classList.remove("screen-shake");
          void document.body.offsetWidth; // reflow so the animation restarts
          document.body.classList.add("screen-shake");
          setTimeout(() => document.body.classList.remove("screen-shake"), 520);
        }
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => {
          comboRef.current = 0;
          setComboVisible(false);
        }, 1200);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sparkle, combo]);

  return (
    <>
      {particles.map((p) => (
        <span
          key={p.id}
          className='sparkle'
          style={{
            left: p.x,
            top: p.y,
            background: p.color,
            boxShadow: `0 0 6px 1px ${p.color}`,
            ["--dx" as string]: `${p.dx}px`,
            ["--dy" as string]: `${p.dy}px`,
          } as React.CSSProperties}
        />
      ))}
      {comboVisible &&
        (() => {
          // Grows bigger and darkens every 100 hits, maxing out at 2000.
          const level = Math.min(20, Math.floor(comboCount / 100)); // 0..20
          const lerp = level / 20;
          const comboSize = 40 + level * 2.8; // 40px → 96px
          const cr = Math.round(245 + (122 - 245) * lerp);
          const cg = Math.round(114 + (46 - 114) * lerp);
          const cb = Math.round(30 + (0 - 30) * lerp);
          const comboColor = `rgb(${cr}, ${cg}, ${cb})`;
          return (
            <div
              key={comboCount}
              className='fixed bottom-5 right-6 z-[70] pointer-events-none select-none text-right'
              style={{ animation: "combo-pop 0.14s ease-out" }}
            >
              <div style={{ color: comboColor, fontWeight: 800, fontSize: "13px", letterSpacing: "0.14em", textShadow: "0 1px 6px rgba(245,114,30,0.35)" }}>
                COMBO
              </div>
              <div style={{ color: comboColor, fontWeight: 900, fontSize: `${comboSize}px`, lineHeight: 1, textShadow: "0 2px 14px rgba(245,114,30,0.45)" }}>
                ×{comboCount}
              </div>
            </div>
          );
        })()}
    </>
  );
}

function TransactionMonitor() {
  const t = useT();
  const POINTS = 15;
  const [values, setValues] = useState<number[]>(() => Array(POINTS).fill(0));
  const [total, setTotal] = useState(0);
  const [bulbOn, setBulbOn] = useState(false);
  const [saveBulbOn, setSaveBulbOn] = useState(false);
  const bulbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBulbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One block per second: sample the captured-action counter, then reset it.
  useEffect(() => {
    const id = setInterval(() => {
      const { perTick, total } = drainCapturedActions();
      setValues((prev) => [...prev.slice(1), perTick]);
      setTotal(total);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Pulse the green bulb on every API call; the orange bulb specifically flags a
  // page-content autosave (PUT …/content) so it's clear that "another API" ran.
  useEffect(
    () =>
      onApiSuccess((path, method) => {
        setBulbOn(true);
        if (bulbTimer.current) clearTimeout(bulbTimer.current);
        bulbTimer.current = setTimeout(() => setBulbOn(false), 220);
        if (method === "PUT" && /\/pages\/[^/]+\/content$/.test(path)) {
          setSaveBulbOn(true);
          if (saveBulbTimer.current) clearTimeout(saveBulbTimer.current);
          saveBulbTimer.current = setTimeout(() => setSaveBulbOn(false), 320);
        }
      }),
    [],
  );

  const W = 168;
  const H = 46;
  const max = Math.max(4, ...values);
  const stepX = W / (POINTS - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = H - 2 - (v / max) * (H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
  const areaPath = `${linePath} L${W},${H} L0,${H} Z`;

  return (
    <div className='px-2 pt-1.5'>
      <div className='flex items-center justify-between mb-1 px-1'>
        <span
          className='text-[10px] font-medium uppercase tracking-wider flex items-center gap-1.5'
          style={{ color: "var(--text-muted)" }}
        >
          {t.transactionMonitor}
          <span
            className='inline-block w-2 h-2 rounded-full transition-all duration-150'
            title='API transaction'
            style={{
              background: bulbOn ? "var(--tx-line)" : "var(--tx-grid)",
              boxShadow: bulbOn ? "0 0 6px 1px var(--tx-line)" : "none",
            }}
          />
          <span
            className='inline-block w-2 h-2 rounded-full transition-all duration-150'
            title='Page save'
            style={{
              background: saveBulbOn ? "#f5721e" : "rgba(245,114,30,0.28)",
              boxShadow: saveBulbOn ? "0 0 6px 1px #f5721e" : "none",
            }}
          />
        </span>
        <span className='text-[10px] tabular-nums' style={{ color: "var(--text-muted)" }}>
          {total.toLocaleString()}
        </span>
      </div>
      <div
        className='rounded-[6px] overflow-hidden'
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-color)" }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width='100%'
          height={H}
          preserveAspectRatio='none'
          style={{ display: "block" }}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={`h${f}`} x1='0' x2={W} y1={H * f} y2={H * f} style={{ stroke: "var(--tx-grid)" }} strokeWidth='0.5' />
          ))}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={`v${f}`} y1='0' y2={H} x1={W * f} x2={W * f} style={{ stroke: "var(--tx-grid)" }} strokeWidth='0.5' />
          ))}
          <path d={areaPath} style={{ fill: "var(--tx-fill)" }} />
          <path d={linePath} fill='none' style={{ stroke: "var(--tx-line)" }} strokeWidth='1.5' strokeLinejoin='round' strokeLinecap='round' />
        </svg>
      </div>
      <div className='flex justify-between px-1 mt-0.5'>
        <span className='text-[9px]' style={{ color: "var(--text-muted)" }}>15s</span>
        <span className='text-[9px] tabular-nums' style={{ color: "var(--text-muted)" }}>
          {values[POINTS - 1]}/s
        </span>
      </div>
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("ymca_theme") as Theme) ?? "muji",
  );
  const [fontSize, setFontSize] = useState<FontSize>(
    () => (localStorage.getItem("ymca_fs") as FontSize) ?? "normal",
  );
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem("ymca_lang") as Lang) ?? "en",
  );
  // Live transaction monitor in the sidebar — on by default, toggled in settings.
  const [txMonitor, setTxMonitor] = useState(
    () => localStorage.getItem("ymca_txmonitor") !== "off",
  );
  // Fun: animated top-bar critters (squid by default) + typing effects.
  const [animals, setAnimals] = useState<AnimalKey[]>(() => {
    const raw = localStorage.getItem("ymca_animals");
    // Default: a squid (with the "few" crowd of 5 below).
    if (raw == null) return ["squid"];
    // Migrate the old keys onto the current fish/crab/squid trio.
    const remap: Record<string, string> = { penguin: "fish", swordfish: "fish", elephant: "squid" };
    return raw
      .split(",")
      .map((a) => remap[a] ?? a)
      .filter((a): a is AnimalKey => (ANIMAL_KEYS as readonly string[]).includes(a));
  });
  // How big a crowd: single · few (default) · many.
  const [quantity, setQuantity] = useState<Quantity>(() => {
    const q = localStorage.getItem("ymca_quantity");
    return q === "single" || q === "many" ? q : "few";
  });
  const [funOpen, setFunOpen] = useState(false);
  const [typingSparkle, setTypingSparkle] = useState(
    () => localStorage.getItem("ymca_sparkle") !== "off",
  );
  const [typingCombo, setTypingCombo] = useState(
    () => localStorage.getItem("ymca_combo") !== "off",
  );
  // Critter walk speed: 1 (slow, default) · 2 · 3 (fast).
  const [animalSpeed, setAnimalSpeed] = useState<1 | 2 | 3>(() => {
    const v = Number(localStorage.getItem("ymca_animalspeed"));
    return v === 2 || v === 3 ? v : 1;
  });
  const isDark = theme === "dark";

  // Check for reset-password token in URL — show reset page before any other render
  const resetToken = new URLSearchParams(window.location.search).get("token");

  useEffect(() => {
    _setApiLang(lang);
    localStorage.setItem("ymca_lang", lang);
  }, [lang]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ymca_theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("ymca_txmonitor", txMonitor ? "on" : "off");
  }, [txMonitor]);

  useEffect(() => {
    localStorage.setItem("ymca_animals", animals.join(","));
  }, [animals]);
  useEffect(() => {
    localStorage.setItem("ymca_quantity", quantity);
  }, [quantity]);
  useEffect(() => {
    localStorage.setItem("ymca_sparkle", typingSparkle ? "on" : "off");
  }, [typingSparkle]);
  useEffect(() => {
    localStorage.setItem("ymca_combo", typingCombo ? "on" : "off");
  }, [typingCombo]);
  useEffect(() => {
    localStorage.setItem("ymca_animalspeed", String(animalSpeed));
  }, [animalSpeed]);

  useEffect(() => {
    document.documentElement.setAttribute("data-fontsize", fontSize);
    localStorage.setItem("ymca_fs", fontSize);
  }, [fontSize]);

  // Auth
  const [user, setUser] = useState<SessionUser | null>(null);
  const [csrf, setCsrf] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPw, setAuthPw] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "forgot">(
    "login",
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotDevLink, setForgotDevLink] = useState("");

  // Workspaces
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWs, setActiveWs] = useState<Workspace | null>(null);
  // True until the very first workspace+tree fetch after login settles —
  // drives the Hub's loading skeleton so it doesn't look empty/broken while
  // those (sequential) requests are in flight. Never reset to true again.
  const [initialLoad, setInitialLoad] = useState(true);
  // Login → fully-loaded timing, shown in the top bar as a diagnostic while
  // we track down perceived slowness. Set at the moment the login/register
  // form is submitted; cleared (and turned into loginLoadMs) the first time
  // initialLoad flips to false afterward. Not set on a silently-resumed
  // session (the /me bootstrap), only on an interactive submit.
  const loginStartRef = useRef<number | null>(null);
  const [loginLoadMs, setLoginLoadMs] = useState<number | null>(null);

  // Pages
  const [tree, setTree] = useState<PageNode[]>([]);
  const [trash, setTrash] = useState<{ id: string; title: string }[]>([]);
  const [activePage, setActivePage] = useState<PageDetail | null>(null);
  const [pageTitle, setPageTitle] = useState("");
  const activePageRef = useRef<PageDetail | null>(null);
  const csrfRef = useRef<string>("");

  // UI
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [showTrash, setShowTrash] = useState(false);
  const [showTodo, setShowTodo] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  // CoMa (Configuration Manager) view — admin only. When true, the main content
  // area shows the admin panel instead of the document hub / editor.
  const [showComa, setShowComa] = useState(false);
  const isAdmin = user?.appRoleKey === "admin";
  const [showRevisions, setShowRevisions] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showVersionLog, setShowVersionLog] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [publicLink, setPublicLink] = useState("");
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState(false);
  const [versionLogEntries, setVersionLogEntries] = useState<VersionLogEntry[]>([]);
  const [versionLogLoading, setVersionLogLoading] = useState(false);
  const [homeActivitySummary, setHomeActivitySummary] = useState<UserActivitySummary | null>(null);
  const [homeActivityLoading, setHomeActivityLoading] = useState(false);
  const [homeActivityError, setHomeActivityError] = useState<string | null>(null);
  // Mirror of the summary so the refresh effect can decide "first load vs
  // silent refresh" without depending on the summary itself (would loop).
  const homeActivitySummaryRef = useRef<UserActivitySummary | null>(null);
  useEffect(() => {
    homeActivitySummaryRef.current = homeActivitySummary;
  }, [homeActivitySummary]);
  // To-do list — lifted here (rather than living inside TodoView) so the
  // sidebar calendar can highlight the days that have scheduled tasks.
  const [todoItems, setTodoItems] = useState<TodoItemT[]>([]);
  const [todoLoading, setTodoLoading] = useState(true);
  const todoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleAreaRef = useRef<HTMLTextAreaElement>(null);
  const activeSurface = showComa
    ? "admin"
    : activePage
      ? `page:${activePage.id}`
      : "home";
  const activePageId = activePage?.id ?? null;
  const activityStateRef = useRef({
    surface: activeSurface,
    pageId: activePageId,
    enteredAt: Date.now(),
  });
  const scrollDepthRef = useRef(0);
  const scrollDepthLastSentRef = useRef(0);
  const analyticsQueueRef = useRef<AnalyticsEventPayload[]>([]);
  const analyticsFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyticsFlushingRef = useRef(false);

  const flushAnalyticsQueue = useCallback(async () => {
    if (!user || analyticsFlushingRef.current) return;
    const batch = analyticsQueueRef.current;
    if (batch.length === 0) return;
    analyticsFlushingRef.current = true;
    analyticsQueueRef.current = [];
    if (analyticsFlushTimerRef.current) {
      clearTimeout(analyticsFlushTimerRef.current);
      analyticsFlushTimerRef.current = null;
    }
    try {
      await api(
        "/analytics/events/batch",
        {
          method: "POST",
          body: JSON.stringify({ events: batch }),
        },
        csrfRef.current || undefined,
      );
    } catch {
      // best effort only; drop the batch if network is unavailable
    } finally {
      analyticsFlushingRef.current = false;
    }
  }, [user]);

  const scheduleAnalyticsFlush = useCallback(() => {
    if (!user) return;
    if (analyticsFlushTimerRef.current) return;
    analyticsFlushTimerRef.current = setTimeout(() => {
      analyticsFlushTimerRef.current = null;
      void flushAnalyticsQueue();
    }, 1200);
  }, [flushAnalyticsQueue, user]);

  const sendAnalyticsEvent = useCallback(
    (payload: AnalyticsEventPayload) => {
      if (!user) return;
      analyticsQueueRef.current.push(payload);
      if (analyticsQueueRef.current.length >= 10) {
        void flushAnalyticsQueue();
        return;
      }
      scheduleAnalyticsFlush();
    },
    [flushAnalyticsQueue, scheduleAnalyticsFlush, user],
  );

  useEffect(() => {
    if (!user) return;
    const previous = activityStateRef.current;
    const next = { surface: activeSurface, pageId: activePageId };
    if (previous.surface !== next.surface || previous.pageId !== next.pageId) {
      const durationMs = Math.max(0, Date.now() - previous.enteredAt);
      if (durationMs > 250) {
        void sendAnalyticsEvent({
          eventType: "surface_dwell",
          target: previous.surface,
          pageId: previous.pageId,
          durationMs,
        });
      }
      activityStateRef.current = { ...next, enteredAt: Date.now() };
      void sendAnalyticsEvent({
        eventType: "surface_view",
        target: next.surface,
        pageId: next.pageId,
      });
    }
  }, [activePageId, activeSurface, sendAnalyticsEvent, user]);

  useEffect(() => {
    if (!user) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        activityStateRef.current.enteredAt = Date.now();
        return;
      }
      const previous = activityStateRef.current;
      const durationMs = Math.max(0, Date.now() - previous.enteredAt);
      if (durationMs > 250) {
        sendAnalyticsEvent({
          eventType: "surface_dwell",
          target: previous.surface,
          pageId: previous.pageId,
          durationMs,
        });
      }
      void flushAnalyticsQueue();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const previous = activityStateRef.current;
      const durationMs = Math.max(0, Date.now() - previous.enteredAt);
      if (durationMs > 250) {
        sendAnalyticsEvent({
          eventType: "surface_dwell",
          target: previous.surface,
          pageId: previous.pageId,
          durationMs,
        });
      }
      void flushAnalyticsQueue();
    };
  }, [sendAnalyticsEvent, user]);

  useEffect(() => {
    if (!user) return;
    const scrollHost = document.querySelector("[data-scroll-host='main']") as HTMLElement | null;
    if (!scrollHost) return;

    const emitScrollDepth = () => {
      const maxScroll = Math.max(scrollHost.scrollHeight - scrollHost.clientHeight, 0);
      if (maxScroll <= 0) return;
      const currentDepth = Math.round((scrollHost.scrollTop / maxScroll) * 100);
      if (currentDepth <= scrollDepthRef.current) return;
      scrollDepthRef.current = currentDepth;
      const now = Date.now();
      if (currentDepth - scrollDepthLastSentRef.current < 10 && now - activityStateRef.current.enteredAt < 2000) {
        return;
      }
      scrollDepthLastSentRef.current = currentDepth;
      void sendAnalyticsEvent({
        eventType: "surface_scroll",
        target: activeSurface,
        pageId: activePageId,
        y: currentDepth,
      });
    };

    const onScroll = () => {
      window.requestAnimationFrame(emitScrollDepth);
    };

    scrollHost.addEventListener("scroll", onScroll, { passive: true });
    emitScrollDepth();
    return () => scrollHost.removeEventListener("scroll", onScroll);
  }, [activePageId, activeSurface, sendAnalyticsEvent, user]);

  const handleAnalyticsClick = useCallback(
    (event: { target: EventTarget | null; clientX: number; clientY: number }) => {
      if (!user) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!isAnalyticsInteractiveTarget(target)) return;
      const interactive = target?.closest(
        "button, a, [role='button'], [data-analytics-zone]",
      ) as HTMLElement | null;
      if (!interactive) return;
      if (interactive.closest("input, textarea, select, [contenteditable='true']")) return;

      const zone = interactive.closest("[data-analytics-zone]") as HTMLElement | null;
      const label = clampAnalyticsLabel(
        interactive.getAttribute("data-analytics-target") ??
          interactive.getAttribute("aria-label") ??
          interactive.textContent ??
          interactive.tagName.toLowerCase(),
      );

      void sendAnalyticsEvent({
        eventType: "ui_click",
        target: zone?.dataset.analyticsZone
          ? `${zone.dataset.analyticsZone}:${label}`
          : label,
        pageId: activePageId,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [activePageId, sendAnalyticsEvent, user],
  );

  useEffect(() => {
    activePageRef.current = activePage;
  }, [activePage]);
  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  // ── Block editor: page references (@) + drag handle plumbing ──

  const treeRef = useRef<PageNode[]>([]);
  treeRef.current = tree;
  const selectPageFnRef = useRef<(id: string) => void>(() => {});

  // Clicking a page-reference chip in the editor opens that page.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const pageId = (e as CustomEvent<{ pageId: string }>).detail?.pageId;
      if (pageId) selectPageFnRef.current(pageId);
    };
    window.addEventListener(PAGE_REF_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PAGE_REF_OPEN_EVENT, onOpen);
  }, []);

  // The @-menu searches workspace pages (API search, tree as fallback).
  useEffect(() => {
    const flatten = (nodes: PageNode[], out: PageRefItem[] = []): PageRefItem[] => {
      for (const n of nodes) {
        if (!n.deletedAt)
          out.push({ id: n.id, title: n.title || "Untitled", icon: n.icon });
        flatten(n.children ?? [], out);
      }
      return out;
    };
    setPageSearchProvider(async (query) => {
      const q = query.trim();
      if (!q) return flatten(treeRef.current).slice(0, 8);
      const ws = activeWs;
      if (ws) {
        try {
          const r = await api<{ results: PageRefItem[] }>(
            `/search?workspaceId=${ws.id}&q=${encodeURIComponent(q)}`,
            {},
            csrfRef.current ?? undefined,
          );
          return r.results.map((p) => ({
            id: p.id,
            title: p.title || "Untitled",
            icon: p.icon,
          }));
        } catch {
          // fall through to local filter
        }
      }
      const ql = q.toLowerCase();
      return flatten(treeRef.current)
        .filter((p) => p.title.toLowerCase().includes(ql))
        .slice(0, 8);
    });
  }, [activeWs]);

  // Stable identity — DragHandle re-registers its plugin (destroying every
  // plugin view, incl. open suggestion menus) whenever this prop changes.
  const gutterTippyOptions = useMemo(
    () => ({
      placement: "left-start" as const,
      // distance 0 so the handle butts right up against the block — no dead
      // zone between text and handle where a mouseleave would hide it.
      offset: [0, 0] as [number, number],
    }),
    [],
  );

  // ── Auth ──

  async function handleAuth() {
    setAuthErr("");
    setAuthBusy(true);
    loginStartRef.current = performance.now();
    setLoginLoadMs(null);
    try {
      const endpoint =
        authMode === "register" ? "/auth/register" : "/auth/login";
      const r = await api<{
        user: SessionUser;
        csrfToken: string;
        token?: string;
      }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ email: authEmail, password: authPw }),
      });
      if (r.token) setAuthToken(r.token);
      setUser(r.user);
      setCsrf(r.csrfToken);
      if (r.user.language) setLang(r.user.language as Lang);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleForgot() {
    setAuthErr("");
    setAuthBusy(true);
    try {
      const r = await api<{ devLink?: string }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: authEmail }),
      });
      setForgotSent(true);
      if (r.devLink) setForgotDevLink(r.devLink);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await api("/auth/logout", { method: "POST" }, csrf);
    } catch {}
    setAuthToken(null);
    setUser(null);
    setCsrf("");
    setWorkspaces([]);
    setActiveWs(null);
    setTree([]);
    setActivePage(null);
    setShowVersionLog(false);
    // Reset so the next sign-in (within this same app instance) gets its own
    // loading skeleton and a fresh login-timing measurement.
    setInitialLoad(true);
    setLoginLoadMs(null);
  }

  async function handleLangChange(newLang: Lang) {
    setLang(newLang);
    try {
      await api(
        "/auth/language",
        { method: "PATCH", body: JSON.stringify({ language: newLang }) },
        csrf,
      );
    } catch {
      /* non-critical — already saved to localStorage */
    }
  }

  // Drop to the login screen if a request 401s mid-session (expired/invalidated
  // token) — but only when we were actually logged in, so the initial /me check
  // for a not-signed-in visitor doesn't flash a "session expired" message.
  const loggedInRef = useRef(false);
  useEffect(() => {
    loggedInRef.current = !!user;
  }, [user]);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!loggedInRef.current) return;
      setUser(null);
      setActiveWs(null);
      setCsrf("");
      setToast(T[_currentLang].err401);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    // No token means we're not signed in (login always stores one), so skip the
    // /me check entirely — otherwise a fresh/incognito visitor logs a 401 for
    // /me on the login screen for no reason.
    if (!localStorage.getItem(TOKEN_KEY)) return;
    api<{ user: SessionUser; csrfToken: string }>("/me")
      .then((r) => {
        setUser(r.user);
        setCsrf(r.csrfToken);
        if (r.user.language) setLang(r.user.language as Lang);
      })
      .catch(() => {
        // Stale/invalid token — drop it so it doesn't ride along on future calls.
        setAuthToken(null);
      });
  }, []);

  // Load the user's to-do list once signed in; the debounced update below
  // autosaves it (the client owns the list, PUT replaces it wholesale).
  useEffect(() => {
    if (!user) {
      setTodoItems([]);
      setTodoLoading(false);
      return;
    }
    let alive = true;
    setTodoLoading(true);
    api<{ items: TodoItemT[] }>("/me/todo", {}, csrfRef.current)
      .then((r) => {
        if (alive) setTodoItems(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setTodoLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [user]);

  const updateTodoItems = useCallback((next: TodoItemT[]) => {
    setTodoItems(next);
    if (todoSaveTimer.current) clearTimeout(todoSaveTimer.current);
    todoSaveTimer.current = setTimeout(() => {
      void api(
        "/me/todo",
        { method: "PUT", body: JSON.stringify({ items: next }) },
        csrfRef.current,
      ).catch(() => {});
    }, 600);
  }, []);

  // Whether the landing page (document hub) is the visible surface right now.
  const onHome = !activePage && !showComa && !showTodo;

  useEffect(() => {
    if (!user) {
      setHomeActivitySummary(null);
      setHomeActivityError(null);
      setHomeActivityLoading(false);
      return;
    }
    // Re-fetch every time the user lands back on the home view so the
    // contribution chart reflects edits made while they were inside a page.
    if (!onHome) return;

    let alive = true;
    // Only show the loading state on the very first fetch; later returns to the
    // landing page refresh silently so the chart doesn't flicker.
    setHomeActivityLoading((prev) => prev || homeActivitySummaryRef.current == null);
    // Pull 5 years so the landing heatmap's year filter can switch instantly
    // (client-side buckets by calendar year). Sparse zero-days gzip away.
    api<UserActivitySummary>("/me/activity?window=1825d")
      .then((data) => {
        if (!alive) return;
        setHomeActivitySummary(data);
        setHomeActivityError(null);
      })
      .catch((error) => {
        if (!alive) return;
        setHomeActivitySummary(null);
        setHomeActivityError(error instanceof Error ? error.message : "Failed to load activity");
      })
      .finally(() => {
        if (!alive) return;
        setHomeActivityLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [user, onHome]);

  useEffect(() => {
    let cancelled = false;

    async function loadVersionLog() {
      setVersionLogLoading(true);
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL}version-log.json?t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error("Failed to load version log");
        const data = (await res.json()) as VersionLogEntry[];
        const entries = Array.isArray(data)
          ? [...data].sort(
              (a, b) =>
                new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
            )
          : [];
        if (!cancelled) setVersionLogEntries(entries);
      } catch {
        if (!cancelled) setVersionLogEntries([]);
      } finally {
        if (!cancelled) setVersionLogLoading(false);
      }
    }

    void loadVersionLog();
    return () => {
      cancelled = true;
    };
  }, []);

  const latestVersionLogAt = versionLogEntries[0]?.publishedAt ?? null;

  // Auto-update: poll version.json (bypassing the HTTP cache). When a strictly
  // newer build has been deployed, reload once to pick it up — this is what
  // keeps phones from getting stuck on a stale cached bundle after a deploy.
  useEffect(() => {
    let stopped = false;
    async function checkVersion() {
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const { id } = (await res.json()) as { id?: string };
        // Numeric (timestamp) compare: only reload when the server is NEWER,
        // so a briefly-stale CDN copy can never trigger a needless reload.
        if (
          id &&
          Number(id) > Number(__BUILD_ID__) &&
          sessionStorage.getItem("ymca_updated_to") !== id
        ) {
          sessionStorage.setItem("ymca_updated_to", id);
          if (!stopped) window.location.reload();
        }
      } catch {
        /* offline / transient — ignore, try again next tick */
      }
    }
    void checkVersion();
    const onFocus = () => void checkVersion();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(checkVersion, 5 * 60 * 1000);
    return () => {
      stopped = true;
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, []);

  // ── Workspaces ──

  const loadWorkspaces = useCallback(async () => {
    if (!user) return;
    try {
      const r = await api<{ workspaces: Workspace[] }>("/workspaces");
      setWorkspaces(r.workspaces);
      if (r.workspaces.length > 0) {
        // Reset the active workspace when it doesn't belong to the current user
        // — otherwise switching accounts in the same tab keeps the previous
        // account's workspace id, and every workspace-scoped call 403s.
        const stillValid = activeWs && r.workspaces.some((w) => w.id === activeWs.id);
        if (!stillValid) setActiveWs(r.workspaces[0]!);
      } else {
        // No workspace at all — nothing will ever trigger loadTree, so the
        // skeleton would otherwise spin forever.
        setInitialLoad(false);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Load failed");
      setInitialLoad(false);
    }
  }, [user, activeWs]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const loadTree = useCallback(async () => {
    if (!activeWs) return;
    try {
      const r = await api<{ tree: PageNode[] }>(
        `/workspaces/${activeWs.id}/pages/tree`,
        {},
        csrf,
      );
      setTree(r.tree);
    } catch {
      /* toast is unnecessary here — the hub just shows empty */
    } finally {
      setInitialLoad(false);
    }
  }, [activeWs, csrf]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // Gmail-style page star. Optimistically flips isStarred on the matching tree
  // node, then persists; on failure we reload the tree to fall back to truth.
  const toggleStar = useCallback(
    async (pageId: string, starred: boolean) => {
      const patch = (nodes: PageNode[]): PageNode[] =>
        nodes.map((n) => ({
          ...n,
          isStarred: n.id === pageId ? starred : n.isStarred,
          children: patch(n.children),
        }));
      setTree((prev) => patch(prev));
      try {
        await api(
          `/pages/${pageId}/star`,
          { method: "PUT", body: JSON.stringify({ starred }) },
          csrf,
        );
      } catch {
        void loadTree();
      }
    },
    [csrf, loadTree],
  );

  // Fires exactly once per interactive login: the first time initialLoad
  // settles to false after handleAuth recorded a start time.
  useEffect(() => {
    if (!initialLoad && loginStartRef.current != null) {
      setLoginLoadMs(performance.now() - loginStartRef.current);
      loginStartRef.current = null;
    }
  }, [initialLoad]);

  const loadTrash = useCallback(async () => {
    if (!activeWs) return;
    try {
      const r = await api<{ pages?: { id: string; title: string }[] }>(
        `/workspaces/${activeWs.id}/trash`,
        {},
        csrf,
      );
      setTrash(r.pages ?? []);
    } catch {}
  }, [activeWs, csrf]);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  // ── Editor ──

  // Upload a pasted/dropped image to the attachment store, then insert an <img>
  // pointing at its URL. Avoids embedding base64 bytes in the document JSON.
  const insertImageFromFile = useCallback(
    async (view: EditorView, file: File) => {
      const page = activePageRef.current;
      const currentCsrf = csrfRef.current;
      if (!page || !currentCsrf) return;
      try {
        const url = await uploadImageFile(file, page.id, currentCsrf);
        const node = view.state.schema.nodes["image"];
        if (node) {
          view.dispatch(view.state.tr.replaceSelectionWith(node.create({ src: url })));
        }
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Image upload failed");
      }
    },
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      ImageExt,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: false }),
      Callout,
      Column,
      ColumnList,
      PageRef,
      PageRefSuggestion,
      SlashCommand,
      UniqueID.configure({
        types: [
          "paragraph",
          "heading",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
          "codeBlock",
          "callout",
          "columnList",
          "image",
        ],
      }),
    ],
    content: "<p></p>",
    editorProps: {
      attributes: { class: "outline-none" },
      handlePaste(view, event) {
        const items = Array.from(event.clipboardData?.items ?? []);
        const imgItem = items.find((item) => item.type.startsWith("image/"));
        if (imgItem) {
          const file = imgItem.getAsFile();
          if (!file) return false;
          void insertImageFromFile(view, file);
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        const dt = (event as DragEvent).dataTransfer;
        const file = Array.from(dt?.files ?? []).find((f) =>
          f.type.startsWith("image/"),
        );
        if (file) {
          event.preventDefault();
          void insertImageFromFile(view, file);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(async () => {
        const page = activePageRef.current;
        if (!page) return;
        const currentCsrf = csrfRef.current;
        if (!currentCsrf) {
          setSaveStatus("error");
          return;
        }
        try {
          await api(
            `/pages/${page.id}/content`,
            {
              method: "PUT",
              body: JSON.stringify({
                content: editor.getJSON(),
                expectedVersion: page.version,
              }),
            },
            currentCsrf,
          );
          setActivePage((prev) =>
            prev ? { ...prev, version: prev.version + 1 } : prev,
          );
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2500);
        } catch {
          setSaveStatus("error");
        }
      }, 1800);
    },
  });

  // ── Page actions ──

  async function handleSelectPage(id: string) {
    try {
      const r = await api<{ page: PageDetail }>(`/pages/${id}`, {}, csrf);
      setShowComa(false);
      setShowTodo(false);
      setActivePage(r.page);
      setPageTitle(r.page.title);
      setPublicLink(
        r.page.publishToken ? `${API}/public/${r.page.publishToken}` : "",
      );
      setShowRevisions(false);
      setShowPublish(false);
      if (isMobileViewport()) setSidebarOpen(false);
      const isEmpty =
        !r.page.content ||
        Object.keys(r.page.content).length === 0 ||
        JSON.stringify(r.page.content) ===
          JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
      if (editor) {
        editor.commands.setContent(
          r.page.content && Object.keys(r.page.content).length > 0
            ? (r.page.content as Parameters<
                typeof editor.commands.setContent
              >[0])
            : "<p></p>",
        );
        // Focus editor at end for new/empty pages
        if (isEmpty) {
          setTimeout(() => editor.commands.focus("end"), 60);
        }
      }
      // reset title textarea height
      setTimeout(() => {
        const el = titleAreaRef.current;
        if (el) {
          el.style.height = "auto";
          el.style.height = el.scrollHeight + "px";
        }
      }, 0);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to load page");
    }
  }

  selectPageFnRef.current = (id: string) => void handleSelectPage(id);

  async function handleNewPage(parentId?: string) {
    if (!activeWs) return;
    try {
      const body: Record<string, unknown> = { title: "Untitled" };
      if (parentId) body.parentPageId = parentId;
      const r = await api<{ page: PageDetail }>(
        `/workspaces/${activeWs.id}/pages`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        csrf,
      );
      await loadTree();
      await handleSelectPage(r.page.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function handleDeletePage(id: string) {
    try {
      await api(`/pages/${id}`, { method: "DELETE" }, csrf);
      if (activePage?.id === id) {
        setActivePage(null);
        editor?.commands.setContent("<p></p>");
      }
      void loadTree();
      void loadTrash();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function handleRestore(id: string) {
    try {
      await api(`/pages/${id}/restore`, { method: "POST" }, csrf);
      void loadTree();
      void loadTrash();
      setToast("Page restored");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Restore failed");
    }
  }

  async function saveTags(tags: string[]) {
    if (!activePage) return;
    setActivePage((prev) => (prev ? { ...prev, tags } : prev));
    try {
      await api(
        `/pages/${activePage.id}/meta`,
        {
          method: "PATCH",
          body: JSON.stringify({ tags }),
        },
        csrf,
      );
      void loadTree();
    } catch {}
  }

  async function saveIcon(icon: string | null) {
    if (!activePage) return;
    setActivePage((prev) => (prev ? { ...prev, icon } : prev));
    try {
      await api(
        `/pages/${activePage.id}/meta`,
        {
          method: "PATCH",
          body: JSON.stringify({ icon }),
        },
        csrf,
      );
      void loadTree();
    } catch {}
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-HTTPS / LAN contexts
      const el = document.createElement("textarea");
      el.value = text;
      el.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePublish() {
    if (!activePage) return;
    try {
      const r = await api<{
        publishToken: string;
        page: { publishToken: string };
      }>(
        `/pages/${activePage.id}/publish`,
        { method: "POST", body: JSON.stringify({ publishTheme: theme }) },
        csrf,
      );
      const token = r.publishToken ?? r.page?.publishToken;
      const link = `${API}/public/${token}`;
      setPublicLink(link);
      setActivePage((prev) =>
        prev ? { ...prev, isPublished: true, publishToken: token } : prev,
      );
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Publish failed");
    }
  }

  async function handleUnpublish() {
    if (!activePage) return;
    try {
      await api(`/pages/${activePage.id}/unpublish`, { method: "POST" }, csrf);
      setPublicLink("");
      setShowPublish(false);
      setActivePage((prev) =>
        prev ? { ...prev, isPublished: false, publishToken: null } : prev,
      );
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Unpublish failed");
    }
  }

  async function saveTitle(val: string) {
    if (!activePage) return;
    try {
      await api(
        `/pages/${activePage.id}/meta`,
        { method: "PATCH", body: JSON.stringify({ title: val }) },
        csrf,
      );
      void loadTree();
    } catch {}
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === "Escape") {
        setShowSearch(false);
        setShowPublish(false);
        setShowVersionLog(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ────────────────────────────────────────────────────────
  // RENDER: Reset password (when ?token= is in URL)
  // ────────────────────────────────────────────────────────

  if (resetToken) {
    return <ResetPasswordPage token={resetToken} />;
  }

  // ────────────────────────────────────────────────────────
  // RENDER: Login / Register / Forgot password
  // ────────────────────────────────────────────────────────

  if (!user) {
    // ── Forgot password view ──
    if (authMode === "forgot") {
      return (
        <div
          className='min-h-screen flex items-center justify-center p-6'
          style={{ background: "var(--bg-secondary)" }}
        >
          <div className='w-full max-w-[380px]'>
            <div className='text-center mb-7'>
              <div
                className='inline-flex items-center justify-center w-12 h-12 rounded-xl text-white text-xl font-bold mb-4'
                style={{ background: "var(--text-primary)" }}
              >
                Y
              </div>
              <h1
                className='text-2xl font-bold'
                style={{ color: "var(--text-primary)" }}
              >
                {T[lang].resetPassword}
              </h1>
              <p
                className='text-sm mt-1'
                style={{ color: "var(--text-muted)" }}
              >
                {T[lang].resetPasswordSubtitle}
              </p>
            </div>

            <div
              className='rounded-xl border p-6 space-y-3'
              style={{
                background: "var(--bg-primary)",
                borderColor: "var(--border-color)",
              }}
            >
              {!forgotSent ? (
                <>
                  <div>
                    <label
                      className='block text-xs font-medium mb-1.5'
                      style={{ color: "var(--text-primary)" }}
                    >
                      {T[lang].email}
                    </label>
                    <input
                      type='email'
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && void handleForgot()
                      }
                      autoFocus
                      className='w-full rounded-[6px] border px-3 py-2 text-sm outline-none'
                      style={{
                        background: "var(--input-bg)",
                        borderColor: "var(--border-color)",
                        color: "var(--text-primary)",
                      }}
                      placeholder='you@example.com'
                    />
                  </div>
                  {authErr && (
                    <div
                      className='rounded-[6px] border px-3 py-2 text-xs'
                      style={{
                        background: "rgba(200,48,48,0.08)",
                        borderColor: "rgba(200,48,48,0.3)",
                        color: "#c83030",
                      }}
                    >
                      {authErr}
                    </div>
                  )}
                  <button
                    onClick={() => void handleForgot()}
                    disabled={authBusy}
                    className='w-full rounded-[6px] py-2.5 text-sm font-medium text-white disabled:opacity-60'
                    style={{ background: "var(--accent-color)" }}
                  >
                    {authBusy ? T[lang].sending : T[lang].sendResetLink}
                  </button>
                </>
              ) : (
                <div className='text-center py-2 space-y-3'>
                  <div className='text-3xl'>📬</div>
                  <p
                    className='text-sm font-medium'
                    style={{ color: "var(--text-primary)" }}
                  >
                    {T[lang].checkInbox}
                  </p>
                  <p
                    className='text-[13px]'
                    style={{ color: "var(--text-muted)" }}
                  >
                    {T[lang].resetLinkSent} <strong>{authEmail}</strong>
                  </p>
                  {forgotDevLink && (
                    <div
                      className='text-left mt-3 p-3 rounded-[6px] border text-[11px] break-all'
                      style={{
                        background: "var(--bg-hover)",
                        borderColor: "var(--border-color)",
                        color: "var(--text-muted)",
                      }}
                    >
                      <strong style={{ color: "var(--text-primary)" }}>
                        Dev mode — use this link:
                      </strong>
                      <br />
                      <a
                        href={forgotDevLink}
                        style={{ color: "var(--accent-color)" }}
                      >
                        {forgotDevLink}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            <p
              className='text-center text-sm mt-5'
              style={{ color: "var(--text-muted)" }}
            >
              <button
                onClick={() => {
                  setAuthMode("login");
                  setAuthErr("");
                  setForgotSent(false);
                  setForgotDevLink("");
                }}
                className='font-medium underline underline-offset-2'
                style={{ color: "var(--text-primary)" }}
              >
                {T[lang].backToSignIn}
              </button>
            </p>
          </div>
        </div>
      );
    }

    // ── Login / Register view ──
    return (
      <div
        className='min-h-screen flex items-center justify-center p-6'
        style={{ background: "var(--bg-secondary)" }}
      >
        <div className='w-full max-w-[380px]'>
          <div className='text-center mb-7'>
            {/* Fixed brand-blue badge with white text — readable on every theme
                (the old var(--text-primary) background went white-on-white in the
                dark/vscode themes). */}
            <div
              className='inline-flex items-center justify-center w-12 h-12 rounded-xl text-white text-xl font-bold mb-4'
              style={{ background: "#2383e2", boxShadow: "0 2px 8px rgba(35,131,226,0.35)" }}
            >
              Y
            </div>
            <h1
              className='text-2xl font-bold'
              style={{ color: "var(--text-primary)" }}
            >
              {authMode === "login"
                ? T[lang].welcomeBack
                : T[lang].createAccount}
            </h1>
            <p className='text-sm mt-1' style={{ color: "var(--text-muted)" }}>
              {authMode === "login"
                ? T[lang].signInSubtitle
                : T[lang].registerSubtitle}
            </p>
          </div>

          <div
            className='rounded-xl border p-6 space-y-3'
            style={{
              background: "var(--bg-primary)",
              borderColor: "var(--border-color)",
            }}
          >
            <div>
              <label
                className='block text-xs font-medium mb-1.5'
                style={{ color: "var(--text-primary)" }}
              >
                {T[lang].email}
              </label>
              <input
                type='email'
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleAuth()}
                autoFocus
                className='w-full rounded-[6px] border px-3 py-2 text-base sm:text-sm outline-none transition'
                style={{
                  background: "var(--input-bg)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                }}
                placeholder='you@example.com'
              />
            </div>
            <div>
              <label
                className='block text-xs font-medium mb-1.5'
                style={{ color: "var(--text-primary)" }}
              >
                {T[lang].password}
              </label>
              <input
                type='password'
                value={authPw}
                onChange={(e) => setAuthPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleAuth()}
                className='w-full rounded-[6px] border px-3 py-2 text-base sm:text-sm outline-none transition'
                style={{
                  background: "var(--input-bg)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                }}
                placeholder={T[lang].passwordPlaceholder}
              />
            </div>
            {authErr && (
              <div
                className='rounded-[6px] border px-3 py-2 text-xs'
                style={{
                  background: "rgba(200,48,48,0.08)",
                  borderColor: "rgba(200,48,48,0.3)",
                  color: "#c83030",
                }}
              >
                {authErr}
              </div>
            )}
            <button
              onClick={() => void handleAuth()}
              disabled={authBusy}
              className='w-full rounded-[6px] py-2.5 text-sm font-medium text-white transition disabled:opacity-60 mt-1'
              style={{ background: "var(--accent-color)" }}
            >
              {authBusy
                ? T[lang].pleaseWait
                : authMode === "login"
                  ? T[lang].continue
                  : T[lang].createAccount}
            </button>

            {authMode === "login" && (
              <div className='text-center'>
                <button
                  onClick={() => {
                    setAuthMode("forgot");
                    setAuthErr("");
                  }}
                  className='text-[12px] underline underline-offset-2'
                  style={{ color: "var(--text-muted)" }}
                >
                  {T[lang].forgotPassword}
                </button>
              </div>
            )}
          </div>

          <p
            className='text-center text-sm mt-5'
            style={{ color: "var(--text-muted)" }}
          >
            {authMode === "login" ? T[lang].noAccount : T[lang].haveAccount}
            <button
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setAuthErr("");
                setAuthEmail("");
                setAuthPw("");
              }}
              className='font-medium underline underline-offset-2 ml-1'
              style={{ color: "var(--text-primary)" }}
            >
              {authMode === "login" ? T[lang].signUpFree : T[lang].signIn}
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────
  // RENDER: New workspace
  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // RENDER: Main
  // ────────────────────────────────────────────────────────

  return (
    <LangContext.Provider value={T[lang]}>
      <div
        className='flex h-screen overflow-hidden'
        onClickCapture={handleAnalyticsClick as never}
        data-analytics-zone='app-root'
        style={{
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
          // iOS Safari: keep the app inside the visible viewport (toolbar-aware)
          height: "100dvh",
        }}
      >
        {/* ════════════════ SIDEBAR ════════════════ */}
        {sidebarOpen && (
          <div
            className='fixed inset-0 z-30 bg-black/40 md:hidden'
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {sidebarOpen && (
          <aside
            className='w-[240px] shrink-0 flex flex-col border-r overflow-hidden max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl'
            data-analytics-zone='sidebar'
            style={{
              background: "var(--bg-secondary)",
              borderColor: "var(--border-color)",
            }}
          >
            {/* Profile at top */}
            <ProfileDropdown
              user={user}
              workspace={activeWs}
              theme={theme}
              fontSize={fontSize}
              isDark={isDark}
              csrf={csrf}
              lang={lang}
              txMonitor={txMonitor}
              onThemeChange={setTheme}
              onFontChange={setFontSize}
              onLangChange={handleLangChange}
              onTxMonitorChange={setTxMonitor}
              onOpenFunSettings={() => setFunOpen(true)}
              onLogout={handleLogout}
            />

            {/* Nav */}
            <div className='px-1 mt-1 space-y-px'>
              {[
                {
                  label: T[lang].home,
                  icon: <Ico.Grid />,
                  action: () => {
                    setShowComa(false);
                    setShowTodo(false);
                    setActivePage(null);
                    if (isMobileViewport()) setSidebarOpen(false);
                  },
                },
                {
                  label: T[lang].search,
                  icon: <Ico.Search />,
                  action: () => setShowSearch(true),
                  kbd: "Ctrl K",
                },
                {
                  label: T[lang].newPage,
                  icon: <Ico.Plus />,
                  action: () => void handleNewPage(),
                },
                {
                  label: T[lang].todo,
                  icon: <Ico.Check />,
                  action: () => {
                    setShowTodo(true);
                    setShowComa(false);
                    setActivePage(null);
                    if (isMobileViewport()) setSidebarOpen(false);
                  },
                },
              ].map(({ label, icon, action, kbd }) => (
                <button
                  key={label}
                  onClick={action}
                  className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[4px] text-[13px] transition-colors text-left'
                  style={{
                    color: "var(--text-primary)",
                    background: "transparent",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--bg-hover)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <span
                    className='w-4 flex justify-center'
                    style={{ color: "var(--text-muted)" }}
                  >
                    {icon}
                  </span>
                  <span className='flex-1'>
                    {label}
                  </span>
                  {kbd && (
                    <kbd
                      className='text-[10px] px-1.5 py-0.5 rounded'
                      style={{
                        background: "var(--bg-active)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {kbd}
                    </kbd>
                  )}
                </button>
              ))}
            </div>

            {/* Starred pages (Gmail-style favourites). Only rendered when the
                user has starred something; otherwise a spacer pins the bottom nav.
                The full page list lives in the Home / Document Hub grid. */}
            {(() => {
              const starredPages = flattenTree(tree).filter((p) => p.isStarred);
              if (starredPages.length === 0) return <div className='flex-1' />;
              return (
                <div className='flex-1 min-h-0 overflow-y-auto mt-3'>
                  <div
                    className='px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5'
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Ico.Star filled />
                    {T[lang].starred}
                  </div>
                  <div className='px-1 space-y-px'>
                    {starredPages.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => {
                          void handleSelectPage(p.id);
                          if (isMobileViewport()) setSidebarOpen(false);
                        }}
                        className='group/star w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[4px] text-[13px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]'
                        style={{ color: "var(--text-primary)" }}
                      >
                        <span className='w-4 flex justify-center shrink-0' style={{ color: "var(--text-muted)" }}>
                          {p.icon ? <span className='text-sm'>{p.icon}</span> : <Ico.Page />}
                        </span>
                        <span className='flex-1 truncate'>{p.title || T[lang].untitled}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleStar(p.id, false);
                          }}
                          className='shrink-0 p-0.5 rounded opacity-70 hover:opacity-100 transition-opacity'
                          title={T[lang].unstar}
                          aria-label={T[lang].unstar}
                        >
                          <Ico.Star filled />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* To-do calendar — days with a scheduled task get a yellow round
                highlight; hover shows the tasks booked for that day. */}
            <div className='border-t pb-1' style={{ borderColor: "var(--border-color)" }}>
              <TodoCalendar items={todoItems} />
            </div>

            {/* Live transaction monitor — its own separated block above the
                Console / Trash controls. Toggled in personal settings. */}
            {txMonitor && (
              <div className='border-t pb-1' style={{ borderColor: "var(--border-color)" }}>
                <TransactionMonitor />
              </div>
            )}

            {/* Bottom */}
            <div
              className='px-1 pb-1.5 pt-1 border-t space-y-px'
              style={{ borderColor: "var(--border-color)" }}
            >
              {/* Console — Configuration Manager (admin only) */}
              {isAdmin && (
                <button
                  onClick={() => {
                    setShowComa(true);
                    setShowTodo(false);
                    setActivePage(null);
                    if (isMobileViewport()) setSidebarOpen(false);
                  }}
                  className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[4px] text-[13px] transition-colors text-left'
                  style={{
                    color: showComa
                      ? "var(--accent-color)"
                      : "var(--text-muted)",
                    background: showComa ? "var(--bg-active)" : "transparent",
                  }}
                  onMouseEnter={(e) =>
                    !showComa &&
                    (e.currentTarget.style.background = "var(--bg-hover)")
                  }
                  onMouseLeave={(e) =>
                    !showComa &&
                    (e.currentTarget.style.background = "transparent")
                  }
                  title={AT[lang].configManager}
                >
                  <span
                    className='w-4 flex justify-center'
                    style={{
                      color: showComa
                        ? "var(--accent-color)"
                        : "var(--text-muted)",
                    }}
                  >
                    <Ico.Settings />
                  </span>
                  <span className='flex-1'>{AT[lang].console}</span>
                </button>
              )}

              {/* Trash */}
              <button
                onClick={() => setShowTrash((v) => !v)}
                className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[4px] text-[13px] transition-colors'
                style={{
                  color: showTrash
                    ? "var(--text-primary)"
                    : "var(--text-muted)",
                  background: showTrash ? "var(--bg-hover)" : "transparent",
                }}
                onMouseEnter={(e) =>
                  !showTrash &&
                  (e.currentTarget.style.background = "var(--bg-hover)")
                }
                onMouseLeave={(e) =>
                  !showTrash &&
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span className='w-4 flex justify-center'>
                  <Ico.Trash />
                </span>
                <span className='flex-1 text-left'>{T[lang].trash}</span>
                {trash.length > 0 && (
                  <span
                    className='text-[10px] px-1.5 py-0.5 rounded-full'
                    style={{
                      background: "var(--bg-active)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {trash.length}
                  </span>
                )}
              </button>
              {showTrash && (
                <div className='ml-1 space-y-px'>
                  {trash.length === 0 && (
                    <p
                      className='text-[11px] px-2.5 py-1.5'
                      style={{ color: "var(--text-muted)" }}
                    >
                      {T[lang].emptyTrash}
                    </p>
                  )}
                  {trash.map((p) => (
                    <div
                      key={p.id}
                      className='flex items-center gap-2 px-2.5 py-1 rounded-[4px] group transition-colors'
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "var(--bg-hover)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      <span style={{ color: "var(--text-muted)" }}>
                        <Ico.Page />
                      </span>
                      <span
                        className='flex-1 text-[12px] truncate'
                        style={{ color: "var(--text-muted)" }}
                      >
                        {p.title || T[lang].untitled}
                      </span>
                      <button
                        onClick={() => void handleRestore(p.id)}
                        className='text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-opacity'
                        style={{ color: "var(--accent-color)" }}
                      >
                        {T[lang].restore}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* ════════════════ MAIN ════════════════ */}
        <div className='flex-1 flex flex-col overflow-hidden relative'>
          {/* Fun: critters that swim across (and just below) the top bar */}
          <CritterField types={animals} quantity={quantity} speed={animalSpeed} />
          {/* Top bar */}
          <div
            className='flex items-center justify-between px-4 py-1.5 border-b shrink-0'
            style={{
              background: "var(--bg-primary)",
              borderColor: "var(--border-color)",
            }}
          >
            <div className='flex items-center gap-2'>
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className='p-1.5 rounded-[4px] transition-colors'
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <Ico.Sidebar />
              </button>
              {activePage && (
                <div
                  className='flex items-center gap-1 text-[13px]'
                  style={{ color: "var(--text-muted)" }}
                >
                  <button
                    onClick={() => setActivePage(null)}
                    className='hover:underline underline-offset-2'
                  >
                    {activeWs?.name}
                  </button>
                  <span>/</span>
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className='font-medium truncate max-w-[110px] sm:max-w-[240px]'
                  >
                    {activePage.title || "Untitled"}
                  </span>
                </div>
              )}
            </div>

            {/* Right actions */}
            <div className='flex items-center gap-1'>
              {/* Diagnostic: time from login submit to workspace fully loaded */}
              {loginLoadMs != null && (
                <span
                  className='flex items-center gap-1 text-[11px] mr-1 px-1.5 py-0.5 rounded-[4px]'
                  style={{ color: "var(--text-muted)" }}
                  title='Time from pressing sign-in to the workspace finishing its initial load'
                >
                  <Ico.Clock />
                  {formatDuration(loginLoadMs)}
                </span>
              )}
              {activePage && (
                <>
                  {/* Save indicator */}
                  <span
                    className={`text-[12px] mr-2 items-center gap-1 transition-all duration-300 hidden sm:flex ${
                      saveStatus === "idle" ? "opacity-0" : "opacity-100"
                    }`}
                    style={{
                      color:
                        saveStatus === "saved"
                          ? "#2d8a2d"
                          : saveStatus === "error"
                            ? "#c03030"
                            : "var(--text-muted)",
                    }}
                  >
                    {saveStatus === "saved" && <Ico.Check />}
                    {saveStatus === "saving"
                      ? T[lang].saving
                      : saveStatus === "saved"
                        ? T[lang].saved
                        : saveStatus === "error"
                          ? T[lang].saveError
                          : ""}
                  </span>

                  {/* Star (favourite) — reflects/toggles this page's star */}
                  {(() => {
                    const starred = !!flattenTree(tree).find((n) => n.id === activePage.id)?.isStarred;
                    return (
                      <button
                        onClick={() => void toggleStar(activePage.id, !starred)}
                        className='flex items-center p-1.5 rounded-[4px] transition-colors'
                        style={{ color: "var(--text-muted)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        title={starred ? T[lang].unstar : T[lang].star}
                        aria-label={starred ? T[lang].unstar : T[lang].star}
                        aria-pressed={starred}
                      >
                        <Ico.Star filled={starred} />
                      </button>
                    );
                  })()}

                  {/* History */}
                  <button
                    onClick={() => setShowRevisions((v) => !v)}
                    className='flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] text-[12px] transition-colors'
                    style={{
                      background: showRevisions
                        ? "var(--bg-active)"
                        : "transparent",
                      color: showRevisions
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                    }}
                    onMouseEnter={(e) =>
                      !showRevisions &&
                      (e.currentTarget.style.background = "var(--bg-hover)")
                    }
                    onMouseLeave={(e) =>
                      !showRevisions &&
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <Ico.Clock />
                    <span className='hidden sm:inline'>{T[lang].history}</span>
                  </button>

                  {/* Publish */}
                  <div className='relative'>
                    <button
                      onClick={() => setShowPublish((v) => !v)}
                      className='flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] text-[12px] font-medium text-white transition-colors'
                      style={{
                        background: activePage.isPublished
                          ? "var(--bg-active)"
                          : "var(--accent-color)",
                        color: activePage.isPublished
                          ? "var(--accent-color)"
                          : "#fff",
                        border: activePage.isPublished
                          ? "1px solid var(--accent-color)"
                          : "1px solid transparent",
                      }}
                    >
                      <Ico.Globe />
                      <span className='hidden sm:inline'>
                        {activePage.isPublished
                          ? T[lang].published
                          : T[lang].publish}
                      </span>
                    </button>
                    {showPublish && (
                      <div
                        className='absolute right-0 top-full mt-2 w-[300px] rounded-xl border shadow-xl p-4 z-30'
                        style={{
                          background: "var(--bg-primary)",
                          borderColor: "var(--border-color)",
                        }}
                      >
                        <div className='flex items-center justify-between mb-3'>
                          <h3
                            className='text-sm font-semibold'
                            style={{ color: "var(--text-primary)" }}
                          >
                            {T[lang].publishToWeb}
                          </h3>
                          <button
                            onClick={() => setShowPublish(false)}
                            style={{ color: "var(--text-muted)" }}
                          >
                            <Ico.X />
                          </button>
                        </div>
                        {activePage.isPublished && publicLink ? (
                          <div className='space-y-3'>
                            <p
                              className='text-[12px]'
                              style={{ color: "var(--text-muted)" }}
                            >
                              {T[lang].anyoneWithLink}
                            </p>
                            {/* URL row with inline copy icon */}
                            <div
                              className='flex items-center gap-1.5 px-3 py-2 rounded-[6px] text-[12px]'
                              style={{
                                background: "var(--bg-hover)",
                                color: "var(--text-primary)",
                              }}
                            >
                              <Ico.Link />
                              <span className='truncate flex-1 select-all'>
                                {publicLink}
                              </span>
                              <button
                                title={T[lang].copyLink}
                                onClick={() => void copyToClipboard(publicLink)}
                                className='shrink-0 p-1 rounded-[4px] transition-colors flex items-center gap-1'
                                style={{
                                  color: copied
                                    ? "var(--accent-color)"
                                    : "var(--text-muted)",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background =
                                    "var(--bg-active)")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background =
                                    "transparent")
                                }
                              >
                                {copied ? (
                                  <>
                                    <Ico.Check />
                                    <span className='text-[11px] font-medium'>
                                      {T[lang].copied}
                                    </span>
                                  </>
                                ) : (
                                  <Ico.Copy />
                                )}
                              </button>
                            </div>
                            {/* Actions row */}
                            <div className='flex gap-2'>
                              <button
                                onClick={() =>
                                  window.open(publicLink, "_blank")
                                }
                                className='flex-1 flex items-center justify-center gap-1.5 rounded-[6px] border py-2 text-[12px] font-medium transition-colors'
                                style={{
                                  borderColor: "var(--border-color)",
                                  color: "var(--text-primary)",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background =
                                    "var(--bg-hover)")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background =
                                    "transparent")
                                }
                              >
                                <Ico.ExternalLink />
                                <span>{T[lang].openInBrowser}</span>
                              </button>
                              <button
                                onClick={() => void handleUnpublish()}
                                className='flex-1 rounded-[6px] border py-2 text-[12px] font-medium transition-colors'
                                style={{
                                  borderColor: "rgba(200,48,48,0.3)",
                                  color: "#c03030",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background =
                                    "rgba(200,48,48,0.06)")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background =
                                    "transparent")
                                }
                              >
                                {T[lang].unpublish}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className='space-y-3'>
                            <p
                              className='text-[12px]'
                              style={{ color: "var(--text-muted)" }}
                            >
                              {T[lang].sharePublicly}
                            </p>
                            <button
                              onClick={() => void handlePublish()}
                              className='w-full rounded-[6px] py-2.5 text-sm font-medium text-white transition-colors'
                              style={{ background: "var(--accent-color)" }}
                            >
                              {T[lang].publishPage}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Content */}
          <div className='flex flex-1 overflow-hidden'>
            <div className='flex-1 overflow-y-auto' data-scroll-host='main'>
              {/* ─── CoMa — Configuration Manager (admin only) ─── */}
              {showComa && isAdmin && (
                <ConfigurationManager csrf={csrf} lang={lang} isDark={isDark} />
              )}

              {/* ─── To-do (personal scratchpad) ─── */}
              {showTodo && !activePage && !showComa && (
                <TodoView items={todoItems} loading={todoLoading} update={updateTodoItems} />
              )}

              {/* ─── Home / Document Hub ─── */}
              {!activePage && !showComa && !showTodo && (
                <DocumentHub
                  tree={tree}
                  isDark={isDark}
                  isLoading={initialLoad}
                  onSelectPage={(id) => void handleSelectPage(id)}
                  onNewPage={() => void handleNewPage()}
                  onDeletePage={(id) => void handleDeletePage(id)}
                  onToggleStar={(id, starred) => void toggleStar(id, starred)}
                  latestUpdateAt={latestVersionLogAt}
                  onOpenVersionLog={() => setShowVersionLog(true)}
                  activitySummary={homeActivitySummary}
                  activityLoading={homeActivityLoading}
                  activityError={homeActivityError}
                />
              )}

              {/* ─── Page Editor ─── */}
              {activePage && (
                <div className='max-w-[720px] mx-auto px-5 py-6 sm:px-[64px] sm:py-12'>
                  {/* Icon */}
                  <div className='mb-2'>
                    <EmojiPicker
                      current={activePage.icon}
                      onSelect={(emoji) => void saveIcon(emoji)}
                      onRemove={() => void saveIcon(null)}
                    />
                  </div>

                  {/* Title */}
                  <textarea
                    ref={titleAreaRef}
                    value={pageTitle}
                    onChange={(e) => {
                      setPageTitle(e.target.value);
                      setActivePage((prev) =>
                        prev ? { ...prev, title: e.target.value } : prev,
                      );
                      // auto-resize
                      const el = titleAreaRef.current;
                      if (el) {
                        el.style.height = "auto";
                        el.style.height = el.scrollHeight + "px";
                      }
                      clearTimeout(
                        (
                          window as unknown as Record<
                            string,
                            ReturnType<typeof setTimeout>
                          >
                        )["_t"],
                      );
                      (
                        window as unknown as Record<
                          string,
                          ReturnType<typeof setTimeout>
                        >
                      )["_t"] = setTimeout(
                        () => void saveTitle(e.target.value),
                        800,
                      );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        editor?.commands.focus();
                      }
                    }}
                    rows={1}
                    className='w-full resize-none overflow-hidden bg-transparent border-0 outline-none font-bold placeholder:opacity-30 leading-tight'
                    style={{
                      fontSize: "var(--title-size)",
                      color: "var(--text-primary)",
                      fontFamily: "var(--font-family)",
                    }}
                    placeholder={T[lang].untitled}
                  />

                  {/* Tags row */}
                  <div className='flex items-center gap-2 mt-3 mb-5'>
                    <span
                      className='text-[11px] font-medium w-[80px] shrink-0'
                      style={{ color: "var(--text-muted)" }}
                    >
                      <span className='flex items-center gap-1.5'>
                        <Ico.Tag /> Category
                      </span>
                    </span>
                    <TagEditor
                      tags={activePage.tags}
                      isDark={isDark}
                      onChange={(tags) => void saveTags(tags)}
                    />
                  </div>

                  <div
                    className='border-b mb-6'
                    style={{ borderColor: "var(--border-color)" }}
                  />

                  {/* Block gutter: + to insert, ⋮⋮ to drag-reorder */}
                  {editor && (
                    <DragHandle
                      editor={editor}
                      tippyOptions={gutterTippyOptions}
                    >
                      <div
                        className='gutter-btn gutter-grip'
                        title='Drag to move'
                      >
                        <svg width='15' height='15' viewBox='0 0 24 24' fill='currentColor'>
                          <circle cx='9' cy='5' r='1.7' />
                          <circle cx='9' cy='12' r='1.7' />
                          <circle cx='9' cy='19' r='1.7' />
                          <circle cx='15' cy='5' r='1.7' />
                          <circle cx='15' cy='12' r='1.7' />
                          <circle cx='15' cy='19' r='1.7' />
                        </svg>
                      </div>
                    </DragHandle>
                  )}
                  {/* Editor */}
                  <div
                    className='notion-editor'
                    onClick={() => editor?.commands.focus()}
                    data-placeholder={T[lang].editorPlaceholder}
                    data-analytics-zone='editor'
                    ref={(el) => {
                      // Propagate placeholder to first paragraph for CSS attr()
                      if (el) {
                        const p = el.querySelector(
                          "p.is-empty",
                        ) as HTMLElement | null;
                        if (p)
                          p.dataset.placeholder = T[lang].editorPlaceholder;
                      }
                    }}
                  >
                    <EditorContent editor={editor} />
                  </div>

                  {/* Attachments */}
                  <AttachmentSection pageId={activePage.id} csrf={csrf} />
                </div>
              )}
            </div>

            {/* Revision drawer */}
            {showRevisions && activePage && (
              <RevisionDrawer
                pageId={activePage.id}
                csrf={csrf}
                onRestore={() => void handleSelectPage(activePage.id)}
                onClose={() => setShowRevisions(false)}
              />
            )}
            {showVersionLog && (
              <>
                <div
                  className='fixed inset-0 z-30 bg-black/40'
                  onClick={() => setShowVersionLog(false)}
                />
                <VersionLogDrawer
                  entries={versionLogEntries}
                  loading={versionLogLoading}
                  onClose={() => setShowVersionLog(false)}
                />
              </>
            )}
          </div>
        </div>

        {/* Search */}
        {showSearch && activeWs && (
          <SearchModal
            workspaceId={activeWs.id}
            csrf={csrf}
            isDark={isDark}
            onSelect={(id) => void handleSelectPage(id)}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* Mobile-only floating back button — second-level surfaces (an open
            page, To-do, the Console) are hard to leave on a phone, so a round
            bottom-right button returns to the landing page. */}
        {(activePage || showTodo || showComa) && (
          <button
            onClick={() => {
              setActivePage(null);
              setShowTodo(false);
              setShowComa(false);
            }}
            className='md:hidden fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full shadow-lg flex items-center justify-center active:scale-95 transition-transform'
            style={{ background: "var(--accent-color)", color: "#fff" }}
            aria-label='Back to home'
          >
            <svg
              width='20'
              height='20'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
              viewBox='0 0 24 24'
            >
              <path d='M19 12H5M12 19l-7-7 7-7' />
            </svg>
          </button>
        )}

        {/* Toast */}
        {toast && <Toast msg={toast} onDismiss={() => setToast("")} />}

        {/* Fun: typing sparkles + combo counter */}
        <TypingFx sparkle={typingSparkle} combo={typingCombo} />

        <FunSettingsModal
          open={funOpen}
          onClose={() => setFunOpen(false)}
          animals={animals}
          quantity={quantity}
          speed={animalSpeed}
          sparkle={typingSparkle}
          combo={typingCombo}
          onAnimals={setAnimals}
          onQuantity={setQuantity}
          onSpeed={setAnimalSpeed}
          onSparkle={setTypingSparkle}
          onCombo={setTypingCombo}
        />
      </div>
    </LangContext.Provider>
  );
}
