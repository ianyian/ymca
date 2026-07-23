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
import { Bar } from "react-chartjs-2";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
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

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

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
  window: "24h" | "7d" | "14d" | "30d" | "365d";
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
    if (res.status === 401)
      throw new Error(
        b?.code === "INVALID_CREDENTIALS"
          ? T[_currentLang].errInvalidCredentials
          : T[_currentLang].err401,
      );
    if (res.status === 403)
      throw new Error(b?.message ?? T[_currentLang].err403);
    if (res.status === 404)
      throw new Error(b?.message ?? T[_currentLang].err404);
    if (res.status >= 500) throw new Error(T[_currentLang].err500);
    throw new Error(b?.message ?? `Error ${res.status}`);
  }
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

const MAX_INLINE_IMAGE_BYTES = 1024 * 1024 * 1024; // 1 GB

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
  onThemeChange,
  onFontChange,
  onLangChange,
  onLogout,
}: {
  user: { id: string; email: string; displayName: string | null };
  workspace: { name: string } | null;
  theme: Theme;
  fontSize: FontSize;
  isDark: boolean;
  csrf: string;
  lang: Lang;
  onThemeChange: (t: Theme) => void;
  onFontChange: (f: FontSize) => void;
  onLangChange: (l: Lang) => void;
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
              <span>My activity</span>
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
          title='Your activity heatmap'
          subtitle='How you are using the app'
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

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
    } catch {
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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
        markdown, up to 1&nbsp;GB each.
      </p>

      {/* Prominent upload drop-zone so it's easy to notice */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className='w-full flex flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed py-6 transition-colors'
        style={{
          borderColor: "var(--border-color)",
          color: "var(--text-muted)",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <Ico.Plus />
        <span className='text-[13px] font-medium'>
          {uploading ? "Uploading…" : "Click to upload a file"}
        </span>
        <span className='text-[11px]'>
          PDF · Word · PPT · Excel · images — up to 1&nbsp;GB
        </span>
      </button>
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
  if (count <= 0) return "var(--bg-hover)";
  if (count <= 1) return "rgba(35,131,226,0.18)";
  if (count <= 3) return "rgba(35,131,226,0.34)";
  if (count <= 6) return "rgba(35,131,226,0.52)";
  return "rgba(35,131,226,0.78)";
}

function activityHeatmapCellStyle(count: number) {
  return {
    background: count <= 0 ? "var(--bg-hover)" : activityHeatmapIntensity(count),
    borderColor: "var(--border-color)",
    boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.16)",
  } as const;
}

function ActivityContributionHeatmap({ summary }: { summary: UserActivitySummary }) {
  const cells = summary.heatmap;
  const dayHighlights = useMemo(
    () => new Map((summary.dayHighlights ?? []).map((item) => [item.date, item.topTargets])),
    [summary.dayHighlights],
  );
  const heatmapWeeks = useMemo(() => {
    if (cells.length === 0) {
      return Array.from({ length: 53 }, (_, weekIndex) =>
        Array.from({ length: 7 }, (_, dayIndex) => ({
          date: `empty-${weekIndex}-${dayIndex}`,
          count: 0,
        }) as UserActivityHeatmapCell),
      ) as Array<Array<UserActivityHeatmapCell | null>>;
    }
    const first = new Date(`${cells[0]!.date}T00:00:00`);
    const last = new Date(`${cells[cells.length - 1]!.date}T00:00:00`);
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(last);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const byDate = new Map(cells.map((cell) => [cell.date, cell.count]));
    const weeks: Array<Array<UserActivityHeatmapCell | null>> = [];
    let week: Array<UserActivityHeatmapCell | null> = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      if (cursor < first || cursor > last) week.push(null);
      else week.push({ date: key, count: byDate.get(key) ?? 0 });
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return weeks;
  }, [cells]);

  const weekLabels = useMemo(
    () =>
      heatmapWeeks.map((week, index) => {
        const firstCell = week.find((cell) => cell != null);
        if (cells.length === 0) return "";
        if (!firstCell) return "";
        const month = new Date(`${firstCell.date}T00:00:00`).toLocaleDateString([], {
          month: "short",
        });
        if (index > 0) {
          const previousCell = heatmapWeeks[index - 1]?.find((cell) => cell != null);
          const previousMonth = previousCell
            ? new Date(`${previousCell.date}T00:00:00`).toLocaleDateString([], {
                month: "short",
              })
            : "";
          if (previousMonth === month) return "";
        }
        return month;
      }),
    [heatmapWeeks],
  );

  return (
    <div className='rounded-xl border p-3 sm:p-4' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
      <div className='flex items-center justify-between gap-3 mb-3 text-[11px]' style={{ color: "var(--text-muted)" }}>
        <span>Last year</span>
        <span>{summary.totalEvents} actions</span>
      </div>
      <div className='grid gap-2 sm:gap-3 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-start'>
        <div className='hidden lg:grid grid-rows-7 pt-[21px] text-[10px]' style={{ color: "var(--text-muted)" }}>
          {Array.from({ length: 7 }).map((_, index) => {
            const label = index === 1 ? "Mon" : index === 3 ? "Wed" : index === 5 ? "Fri" : "";
            return (
              <div key={index} className='h-[10px] leading-[10px] pr-1 text-right'>
                {label}
              </div>
            );
          })}
        </div>

        <div className='min-w-0'>
          <div className='mb-1 hidden sm:flex gap-[8px] pl-[1px] text-[10px]' style={{ color: "var(--text-muted)" }}>
            {weekLabels.map((label, index) => (
              <span key={`${label}-${index}`} className='w-[10px] text-center'>
                {label}
              </span>
            ))}
          </div>
          <div
            className='grid gap-[2px] sm:gap-[3px]'
            style={{ gridAutoFlow: "column", gridAutoColumns: "10px", gridTemplateRows: "repeat(7, 10px)" }}
          >
            {heatmapWeeks.flatMap((week, weekIndex) =>
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
  const [tab, setTab] = useState<"page" | "guide">("page");

  return (
    <div className='rounded-xl border p-4 mt-8' style={{ borderColor: "var(--border-color)", background: "var(--bg-secondary)" }} data-analytics-zone='information-center'>
      <div className='flex flex-wrap items-center justify-between gap-3 mb-3'>
        <div className='flex items-center gap-1 rounded-full border p-1' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
          {([ ["page", "Page"], ["guide", "Guide"] ] as const).map(([key, label]) => (
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
        <button type='button' onClick={onOpenVersionLog} className='text-[11px] font-medium px-2.5 py-1.5 rounded-full whitespace-nowrap border' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)", color: "var(--text-muted)" }} title={latestUpdateAt ? formatVersionLogTimestamp(latestUpdateAt) : "Open version log"}>
          Log
        </button>
      </div>

      {tab === "page" ? (
        <div className='rounded-xl border p-3 sm:p-4' style={{ borderColor: "var(--border-color)", background: "var(--bg-primary)" }}>
          <h3 className='text-[14px] font-semibold mb-3' style={{ color: "var(--text-primary)" }}>Contribution chart</h3>
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

function DocumentHub({
  tree,
  isDark,
  isLoading,
  onSelectPage,
  onNewPage,
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
  latestUpdateAt: string | null;
  onOpenVersionLog: () => void;
  activitySummary: UserActivitySummary | null;
  activityLoading: boolean;
  activityError: string | null;
}) {
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
          Document Hub
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
          <Ico.Plus /> New page
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
            All docs
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
            placeholder='Search documents by name…'
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
              ‹ Prev
            </button>
            <span
              className='text-[12px] px-1 whitespace-nowrap'
              style={{ color: "var(--text-muted)" }}
            >
              Page {safePage + 1} of {totalPages}
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
              Next ›
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
          className='grid text-[11px] font-semibold uppercase tracking-wider px-4 py-2.5 border-b grid-cols-[1fr] sm:grid-cols-[1fr_180px_70px]'
          style={{
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            borderColor: "var(--border-color)",
          }}
        >
          <span>Title</span>
          <span className='hidden sm:block'>Tag</span>
          <span className='hidden sm:block'></span>
        </div>

        {isLoading && filtered.length === 0 && (
          <div className='px-4 py-2.5' aria-label='Loading pages'>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className='grid items-center py-2.5 grid-cols-[1fr] sm:grid-cols-[1fr_180px_70px]'
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
              className='grid items-center px-4 py-2.5 cursor-pointer transition-colors border-b last:border-0 group grid-cols-[1fr] sm:grid-cols-[1fr_180px_70px]'
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
                    {page.title || "Untitled"}
                  </span>
                </div>
                <div
                  className='text-[11px] mt-0.5 sm:mt-0'
                  style={{ color: "var(--text-muted)" }}
                >
                  {dateStr}
                </div>
              </div>

              <div className='hidden sm:flex flex-wrap gap-1.5 overflow-hidden'>
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

              {/* Open button - visible on row hover */}
              <div className='hidden sm:flex justify-end'>
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
          {filtered.length} {filtered.length === 1 ? "page" : "pages"}
          {filterTag
            ? ` tagged "${filterTag}"`
            : q
              ? ` matching "${query.trim()}"`
              : " total"}
        </p>
      )}

      {/* Getting-started card — hidden on mobile to save space + render cost */}
      {!isMobileViewport() && (
        <WelcomeCard
          onNewPage={onNewPage}
          latestUpdateAt={latestUpdateAt}
          onOpenVersionLog={onOpenVersionLog}
          activitySummary={activitySummary}
          activityLoading={activityLoading}
          activityError={activityError}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Search Modal
// ────────────────────────────────────────────────────────────

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
    { id: string; title: string; tags?: string[] }[]
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
          results: { id: string; title: string; tags?: string[] }[];
        }>(
          `/search?q=${encodeURIComponent(q)}&workspaceId=${workspaceId}`,
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
            className='flex-1 text-sm bg-transparent outline-none'
            style={{ color: "var(--text-primary)" }}
            placeholder='Search pages...'
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
              className='w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors'
              style={{ color: "var(--text-primary)" }}
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
              <span className='flex-1 truncate'>{r.title || "Untitled"}</span>
              <div className='flex gap-1'>
                {r.tags?.slice(0, 2).map((tag) => (
                  <TagBadge key={tag} tag={tag} isDark={isDark} />
                ))}
              </div>
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

  const heatmapIntensity = (count: number) => {
    if (count <= 0) return "var(--bg-hover)";
    if (count <= 1) return "rgba(35,131,226,0.18)";
    if (count <= 3) return "rgba(35,131,226,0.34)";
    if (count <= 6) return "rgba(35,131,226,0.52)";
    return "rgba(35,131,226,0.78)";
  };

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
            Profile analytics
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
            Graphical
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
            List
          </button>
        </div>
      </div>

      <div className='px-4 py-3 border-b space-y-2' style={{ borderColor: "var(--border-color)" }}>
        <div>
          <div className='flex items-center justify-between text-[10px] mb-1' style={{ color: "var(--text-muted)" }}>
            <span>Time range</span>
            <span>{windowKey}</span>
          </div>
          <div className='mt-1 flex justify-between text-[9px]' style={{ color: "var(--text-muted)" }}>
            <span>14d view</span>
            <span>today included</span>
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
                Activity by day
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
                    <span>14 days</span>
                    <span>today</span>
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
                            style={{
                              background: heatmapIntensity(cell.count),
                              borderColor: "var(--border-color)",
                              boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.16)",
                            }}
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
                Top interactions
              </h4>
              <div className='h-[160px] rounded-xl border p-2' style={{ borderColor: "var(--border-color)" }}>
                <Bar data={barData} options={barOptions} />
              </div>
            </section>
          </>
        ) : (
          <section>
            <h4 className='text-[12px] font-semibold mb-2' style={{ color: "var(--text-primary)" }}>
              Recent activities
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

function ConfigurationManager({ csrf, lang, isDark }: { csrf: string; lang: Lang; isDark: boolean }) {
  const t = AT[lang];
  const [tab, setTab] = useState<"monitoring" | "users">("monitoring");
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
      ) : (
        <UserManagementPanel csrf={csrf} lang={lang} isDark={isDark} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────

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

  useEffect(() => {
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

  useEffect(() => {
    if (!user) {
      setHomeActivitySummary(null);
      setHomeActivityError(null);
      setHomeActivityLoading(false);
      return;
    }

    let alive = true;
    setHomeActivityLoading(true);
    api<UserActivitySummary>("/me/activity?window=365d")
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
  }, [user]);

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
      if (r.workspaces.length > 0 && !activeWs) setActiveWs(r.workspaces[0]!);
      // No workspace at all — nothing will ever trigger loadTree, so the
      // skeleton would otherwise spin forever.
      else if (r.workspaces.length === 0) setInitialLoad(false);
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
              onThemeChange={setTheme}
              onFontChange={setFontSize}
              onLangChange={handleLangChange}
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
              ].map(({ label, icon, action, kbd }) => (
                <button
                  key={label}
                  onClick={action}
                  className='w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[4px] text-[13px] transition-colors text-left'
                  style={{ color: "var(--text-primary)" }}
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
                  <span className='flex-1'>{label}</span>
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

            {/* Pages */}
            <div className='flex-1 overflow-y-auto mt-3 px-1'>
              <div className='flex items-center justify-between px-2.5 mb-1'>
                <span
                  className='text-[10px] font-semibold uppercase tracking-wider'
                  style={{ color: "var(--text-muted)" }}
                >
                  Pages
                </span>
                <button
                  onClick={() => void handleNewPage()}
                  style={{ color: "var(--text-muted)" }}
                  title='New page'
                  className='hover:opacity-80 p-0.5 rounded-[3px] transition-opacity'
                >
                  <Ico.Plus />
                </button>
              </div>
              {tree.length === 0 && (
                <p
                  className='text-[12px] px-2.5 py-3 text-center'
                  style={{ color: "var(--text-muted)" }}
                >
                  No pages yet
                </p>
              )}
              {tree.map((node) => (
                <PageTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  activePageId={activePage?.id ?? null}
                  isDark={isDark}
                  onSelect={(id) => void handleSelectPage(id)}
                  onNewChild={(id) => void handleNewPage(id)}
                  onDelete={(id) => void handleDeletePage(id)}
                />
              ))}
            </div>

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
        <div className='flex-1 flex flex-col overflow-hidden'>
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
                      ? "Saving..."
                      : saveStatus === "saved"
                        ? "Saved"
                        : saveStatus === "error"
                          ? "Error"
                          : ""}
                  </span>

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

              {/* ─── Home / Document Hub ─── */}
              {!activePage && !showComa && (
                <DocumentHub
                  tree={tree}
                  isDark={isDark}
                  isLoading={initialLoad}
                  onSelectPage={(id) => void handleSelectPage(id)}
                  onNewPage={() => void handleNewPage()}
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

        {/* Toast */}
        {toast && <Toast msg={toast} onDismiss={() => setToast("")} />}
      </div>
    </LangContext.Provider>
  );
}
