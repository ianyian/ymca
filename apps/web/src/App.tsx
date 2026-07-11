import { useCallback, useEffect, useRef, useState } from "react";
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
import type { EditorView } from "@tiptap/pm/view";
import { Callout, SlashCommand, SLASH_ITEMS } from "./editor-extensions";
import { LangContext, LANGUAGES, T, useT, type Lang } from "./i18n";

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

// ────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────

const API = (
  import.meta.env.VITE_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:4000`
).replace(/\/$/, "");

// Module-level lang ref so api() can return translated errors without needing React context
let _currentLang: Lang = (localStorage.getItem("ymca_lang") as Lang) ?? "en";
export function _setApiLang(l: Lang) {
  _currentLang = l;
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
    } | null;
    if (res.status === 413) throw new Error(T[_currentLang].err413);
    if (res.status === 401) throw new Error(T[_currentLang].err401);
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
  user: { email: string; displayName: string | null };
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

  const initials = (user.displayName ?? user.email).slice(0, 2).toUpperCase();
  const displayName = user.displayName ?? user.email.split("@")[0];

  return (
    <div className='relative px-2 pt-2 pb-1' ref={ref}>
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

            {/* Font size */}
            <p
              className='text-[11px] font-semibold mb-1.5'
              style={{ color: "var(--text-muted)" }}
            >
              {t.fontSize}
            </p>
            <div className='flex items-center gap-1 mb-2'>
              {FONT_SIZES.map((f) => (
                <button
                  key={f.id}
                  onClick={() => onFontChange(f.id)}
                  className='flex-1 text-[11px] py-1 rounded-[6px] font-medium transition-colors'
                  style={{
                    background:
                      fontSize === f.id
                        ? "var(--accent-color)"
                        : "var(--bg-hover)",
                    color: fontSize === f.id ? "#fff" : "var(--text-muted)",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Language */}
            <p
              className='text-[11px] font-semibold mb-1.5'
              style={{ color: "var(--text-muted)" }}
            >
              {t.language}
            </p>
            <div className='grid grid-cols-2 gap-1 mb-1'>
              {LANGUAGES.map((l) => (
                <button
                  key={l.id}
                  onClick={() => onLangChange(l.id)}
                  className='flex items-center gap-1.5 px-2 py-1.5 rounded-[6px] text-[11px] text-left transition-colors truncate'
                  style={{
                    background:
                      lang === l.id ? "var(--bg-active)" : "transparent",
                    color:
                      lang === l.id
                        ? "var(--accent-color)"
                        : "var(--text-primary)",
                    border:
                      lang === l.id
                        ? "1px solid var(--accent-color)"
                        : "1px solid transparent",
                  }}
                >
                  <span className='truncate'>{l.native}</span>
                  {lang === l.id && (
                    <span className='ml-auto shrink-0'>
                      <Ico.Check />
                    </span>
                  )}
                </button>
              ))}
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
function WelcomeCard({ onNewPage }: { onNewPage: () => void }) {
  return (
    <div
      className='rounded-xl border p-4 mt-8'
      style={{
        borderColor: "var(--border-color)",
        background: "var(--bg-secondary)",
      }}
    >
      <div className='flex items-center justify-between gap-4 mb-2.5'>
        <h2
          className='text-[15px] font-bold flex items-center gap-2'
          style={{ color: "var(--text-primary)" }}
        >
          👋 Welcome to YMCA
          <span className='text-[12px] font-normal' style={{ color: "var(--text-muted)" }}>
            — open a page and type{" "}
            <kbd
              className='px-1 py-0.5 rounded border text-[11px] font-mono'
              style={{
                borderColor: "var(--border-color)",
                background: "var(--bg-primary)",
                color: "var(--text-primary)",
              }}
            >
              /
            </kbd>{" "}
            for these blocks:
          </span>
        </h2>
        <span
          className='text-[11px] font-medium px-2 py-1 rounded-full whitespace-nowrap'
          style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}
        >
          v{APP_VERSION} · {APP_RELEASE_DATE}
        </span>
      </div>
      <div
        className='grid gap-1.5'
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
      >
        {SLASH_ITEMS.map((item) => (
          <div
            key={item.title}
            className='flex items-center gap-2 px-2 py-1.5 rounded-[6px]'
            style={{
              background: "var(--bg-primary)",
              border: "1px solid var(--border-color)",
            }}
            title={item.subtitle}
          >
            <span
              className='flex items-center justify-center w-6 h-6 rounded-[5px] text-[12px] shrink-0'
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-color)",
                color: "var(--text-primary)",
              }}
            >
              {item.icon}
            </span>
            <span
              className='text-[12px] font-medium truncate'
              style={{ color: "var(--text-primary)" }}
            >
              <span style={{ color: "var(--accent-color)" }}>/</span>
              {item.title.toLowerCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocumentHub({
  tree,
  isDark,
  onSelectPage,
  onNewPage,
}: {
  tree: PageNode[];
  isDark: boolean;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
}) {
  const PER_PAGE = 10;
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pageNum, setPageNum] = useState(0);
  const allPages = flattenTree(tree);
  const allTags = Array.from(new Set(allPages.flatMap((p) => p.tags))).sort();
  const q = query.trim().toLowerCase();
  const filtered = allPages.filter(
    (p) =>
      (!filterTag || p.tags.includes(filterTag)) &&
      (!q || (p.title || "Untitled").toLowerCase().includes(q)),
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
    <div className='flex-1 overflow-y-auto px-8 py-10 max-w-[900px] mx-auto w-full'>
      {/* Header */}
      <div className='flex items-center justify-between mb-6'>
        <h1
          className='text-3xl font-bold'
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
      <div className='flex items-center justify-between gap-3 mb-3'>
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
            className='w-full text-sm pl-8 pr-3 py-1.5 rounded-[8px] border outline-none'
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
        {/* Table header */}
        <div
          className='grid text-[11px] font-semibold uppercase tracking-wider px-4 py-2.5 border-b'
          style={{
            gridTemplateColumns: "1fr 180px 175px 70px",
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            borderColor: "var(--border-color)",
          }}
        >
          <span>Doc name</span>
          <span>Category</span>
          <span className='text-right'>Last modified</span>
          <span></span>
        </div>

        {filtered.length === 0 && (
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
              className='grid items-center px-4 py-2.5 cursor-pointer transition-colors border-b last:border-0 group'
              style={{
                gridTemplateColumns: "1fr 180px 175px 70px",
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

              <div className='flex flex-wrap gap-1.5 overflow-hidden'>
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

              <div
                className='text-right text-[12px]'
                style={{ color: "var(--text-muted)" }}
              >
                {dateStr}
              </div>

              {/* Open button - visible on row hover */}
              <div className='flex justify-end'>
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

      {/* Getting-started / notifications — relocated below the hub */}
      <WelcomeCard onNewPage={onNewPage} />
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
      className='w-[268px] shrink-0 flex flex-col border-l'
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
  const [showRevisions, setShowRevisions] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [publicLink, setPublicLink] = useState("");
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    activePageRef.current = activePage;
  }, [activePage]);
  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  // ── Auth ──

  async function handleAuth() {
    setAuthErr("");
    setAuthBusy(true);
    try {
      const endpoint =
        authMode === "register" ? "/auth/register" : "/auth/login";
      const r = await api<{ user: SessionUser; csrfToken: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ email: authEmail, password: authPw }),
      });
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
    setUser(null);
    setCsrf("");
    setWorkspaces([]);
    setActiveWs(null);
    setTree([]);
    setActivePage(null);
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
      .catch(() => {});
  }, []);

  // ── Workspaces ──

  const loadWorkspaces = useCallback(async () => {
    if (!user) return;
    try {
      const r = await api<{ workspaces: Workspace[] }>("/workspaces");
      setWorkspaces(r.workspaces);
      if (r.workspaces.length > 0 && !activeWs) setActiveWs(r.workspaces[0]!);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Load failed");
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
    } catch {}
  }, [activeWs, csrf]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

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
      SlashCommand,
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
      setActivePage(r.page);
      setPageTitle(r.page.title);
      setPublicLink(
        r.page.publishToken ? `${API}/public/${r.page.publishToken}` : "",
      );
      setShowRevisions(false);
      setShowPublish(false);
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
                className='w-full rounded-[6px] border px-3 py-2 text-sm outline-none transition'
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
                className='w-full rounded-[6px] border px-3 py-2 text-sm outline-none transition'
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
        style={{
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
        }}
      >
        {/* ════════════════ SIDEBAR ════════════════ */}
        {sidebarOpen && (
          <aside
            className='w-[240px] shrink-0 flex flex-col border-r overflow-hidden'
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
                  action: () => setActivePage(null),
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
                    className='font-medium truncate max-w-[240px]'
                  >
                    {activePage.title || "Untitled"}
                  </span>
                </div>
              )}
            </div>

            {/* Right actions */}
            <div className='flex items-center gap-1'>
              {activePage && (
                <>
                  {/* Save indicator */}
                  <span
                    className={`text-[12px] mr-2 flex items-center gap-1 transition-all duration-300 ${
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
                    <span>{T[lang].history}</span>
                  </button>

                  {/* Publish */}
                  <div className='relative'>
                    <button
                      onClick={() => setShowPublish((v) => !v)}
                      className='flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] text-[12px] font-medium text-white transition-colors'
                      style={{
                        background: activePage.isPublished
                          ? "rgba(35,131,226,0.15)"
                          : "var(--accent-color)",
                        color: activePage.isPublished
                          ? "var(--accent-color)"
                          : "#fff",
                      }}
                    >
                      <Ico.Globe />
                      <span>
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
            <div className='flex-1 overflow-y-auto'>
              {/* ─── Home / Document Hub ─── */}
              {!activePage && (
                <DocumentHub
                  tree={tree}
                  isDark={isDark}
                  onSelectPage={(id) => void handleSelectPage(id)}
                  onNewPage={() => void handleNewPage()}
                />
              )}

              {/* ─── Page Editor ─── */}
              {activePage && (
                <div className='max-w-[720px] mx-auto px-[64px] py-12'>
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

                  {/* Editor */}
                  <div
                    className='notion-editor'
                    onClick={() => editor?.commands.focus()}
                    data-placeholder={T[lang].editorPlaceholder}
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
