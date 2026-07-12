import { Node, Extension, mergeAttributes } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
  Plugin as PMPlugin,
  PluginKey as PMPluginKey,
} from "@tiptap/pm/state";

// ────────────────────────────────────────────────────────────
// Callout block — a colored box with a leading emoji.
// ────────────────────────────────────────────────────────────

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (el) => el.getAttribute("data-emoji") || "💡",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const emoji = (node.attrs.emoji as string) || "💡";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        class: "notion-callout",
      }),
      ["span", { class: "notion-callout-emoji", contenteditable: "false" }, emoji],
      ["div", { class: "notion-callout-body" }, 0],
    ];
  },
});

// ────────────────────────────────────────────────────────────
// Columns — side-by-side block containers (Notion-style layout).
// ────────────────────────────────────────────────────────────

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-column": "", class: "notion-column" }),
      0,
    ];
  },
});

export const ColumnList = Node.create({
  name: "columnList",
  group: "block",
  content: "column{2,4}",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-column-list]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-column-list": "",
        class: "notion-column-list",
      }),
      0,
    ];
  },
});

function columnsContent(count: number) {
  return {
    type: "columnList",
    content: Array.from({ length: count }, () => ({
      type: "column",
      content: [{ type: "paragraph" }],
    })),
  };
}

// Insert a column layout and place the cursor inside the first column.
function insertColumns(editor: Editor, range: Range, count: number) {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent(columnsContent(count))
    .run();
  const { doc } = editor.state;
  let best = -1;
  let bestDist = Infinity;
  doc.descendants((node, pos) => {
    if (node.type.name === "columnList") {
      const d = Math.abs(pos - range.from);
      if (d < bestDist) {
        bestDist = d;
        best = pos;
      }
    }
  });
  // columnList → +1 column → +2 paragraph → +3 cursor inside it
  if (best >= 0) editor.chain().setTextSelection(best + 3).run();
}

// ────────────────────────────────────────────────────────────
// Page reference — inline chip linking to another page.
// Clicking dispatches a window event the app listens for.
// ────────────────────────────────────────────────────────────

export type PageRefItem = { id: string; title: string; icon: string | null };

export const PAGE_REF_OPEN_EVENT = "ymca:open-page";

export const PageRef = Node.create({
  name: "pageRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-id"),
        renderHTML: (attrs) => ({ "data-page-id": attrs.pageId as string }),
      },
      title: {
        default: "Untitled",
        parseHTML: (el) => el.getAttribute("data-page-title") || "Untitled",
        renderHTML: (attrs) => ({ "data-page-title": attrs.title as string }),
      },
      icon: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-icon"),
        renderHTML: (attrs) =>
          attrs.icon ? { "data-page-icon": attrs.icon as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-page-ref]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const icon = (node.attrs.icon as string | null) || "📄";
    const title = (node.attrs.title as string) || "Untitled";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-page-ref": "",
        class: "notion-page-ref",
        role: "link",
        tabindex: "0",
      }),
      ["span", { class: "notion-page-ref-icon", contenteditable: "false" }, icon],
      ["span", { class: "notion-page-ref-title", contenteditable: "false" }, title],
    ];
  },

  addProseMirrorPlugins() {
    return [
      new PMPlugin({
        props: {
          handleClickOn(_view, _pos, node, _nodePos, event) {
            if (node.type.name !== "pageRef") return false;
            const pageId = node.attrs.pageId as string | null;
            if (!pageId) return false;
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent(PAGE_REF_OPEN_EVENT, { detail: { pageId } }),
            );
            return true;
          },
        },
      }),
    ];
  },
});

// The app registers a provider so the @-menu can search workspace pages.
let _pageSearch: (query: string) => Promise<PageRefItem[]> = async () => [];
export function setPageSearchProvider(
  fn: (query: string) => Promise<PageRefItem[]>,
) {
  _pageSearch = fn;
}

function createPageRefRenderer() {
  let el: HTMLDivElement | null = null;
  let items: PageRefItem[] = [];
  let rows: HTMLButtonElement[] = [];
  let selected = 0;
  let cmd: (item: PageRefItem) => void = () => {};

  function applySelected() {
    rows.forEach((r, i) => r.classList.toggle("is-selected", i === selected));
  }

  function build() {
    if (!el) return;
    el.innerHTML = "";
    rows = [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = "No pages found";
      el.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "slash-item";
      const icon = document.createElement("span");
      icon.className = "slash-item-icon";
      icon.textContent = item.icon || "📄";
      const text = document.createElement("span");
      text.className = "slash-item-text";
      const title = document.createElement("span");
      title.className = "slash-item-title";
      title.textContent = item.title || "Untitled";
      text.appendChild(title);
      row.appendChild(icon);
      row.appendChild(text);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cmd(item);
      });
      row.addEventListener("mouseover", () => {
        selected = i;
        applySelected();
      });
      el!.appendChild(row);
      rows.push(row);
    });
    applySelected();
  }

  function position(rect: DOMRect | null) {
    if (!el || !rect) return;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 6}px`;
  }

  return {
    onStart: (props: {
      items: PageRefItem[];
      command: (item: PageRefItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) => {
      items = props.items;
      selected = 0;
      cmd = props.command;
      el = document.createElement("div");
      el.className = "slash-menu";
      document.body.appendChild(el);
      build();
      position(props.clientRect?.() ?? null);
    },
    onUpdate: (props: {
      items: PageRefItem[];
      command: (item: PageRefItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) => {
      items = props.items;
      cmd = props.command;
      if (selected >= items.length) selected = 0;
      build();
      position(props.clientRect?.() ?? null);
    },
    onKeyDown: (props: { event: KeyboardEvent }): boolean => {
      if (!el || items.length === 0) return false;
      const { key } = props.event;
      if (key === "ArrowDown") {
        selected = (selected + 1) % items.length;
        applySelected();
        return true;
      }
      if (key === "ArrowUp") {
        selected = (selected - 1 + items.length) % items.length;
        applySelected();
        return true;
      }
      if (key === "Enter") {
        const item = items[selected];
        if (item) cmd(item);
        return true;
      }
      if (key === "Escape") return true;
      return false;
    },
    onExit: () => {
      el?.remove();
      el = null;
      rows = [];
    },
  };
}

export const PageRefSuggestion = Extension.create({
  name: "pageRefSuggestion",

  addProseMirrorPlugins() {
    return [
      Suggestion<PageRefItem>({
        editor: this.editor,
        char: "@",
        allowSpaces: true,
        startOfLine: false,
        pluginKey: new PMPluginKey("pageRefSuggestion"),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "pageRef",
                attrs: {
                  pageId: props.id,
                  title: props.title || "Untitled",
                  icon: props.icon,
                },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        items: ({ query }) => _pageSearch(query),
        render: createPageRefRenderer,
      }),
    ];
  },
});

// ────────────────────────────────────────────────────────────
// Slash (/) command menu.
// ────────────────────────────────────────────────────────────

export type SlashItem = {
  title: string;
  subtitle: string;
  icon: string;
  keywords: string;
  command: (opts: { editor: Editor; range: Range }) => void;
};

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    subtitle: "Plain paragraph",
    icon: "¶",
    keywords: "text paragraph plain body",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    subtitle: "Large section heading",
    icon: "H₁",
    keywords: "heading title h1 large",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    subtitle: "Medium section heading",
    icon: "H₂",
    keywords: "heading h2 subtitle medium",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    subtitle: "Small section heading",
    icon: "H₃",
    keywords: "heading h3 small",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "To-do list",
    subtitle: "Track tasks with checkboxes",
    icon: "☑",
    keywords: "todo task checkbox check list",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Bulleted list",
    subtitle: "Simple bulleted list",
    icon: "•",
    keywords: "bullet unordered list ul",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    subtitle: "Ordered list with numbers",
    icon: "1.",
    keywords: "number ordered list ol",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Quote",
    subtitle: "Capture a quotation",
    icon: "❝",
    keywords: "quote blockquote citation",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Callout",
    subtitle: "Highlighted note box",
    icon: "💡",
    keywords: "callout note info box highlight",
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "callout",
          attrs: { emoji: "💡" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    title: "Code block",
    subtitle: "Formatted code snippet",
    icon: "</>",
    keywords: "code snippet monospace pre",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    subtitle: "Horizontal rule",
    icon: "—",
    keywords: "divider horizontal rule hr line separator",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: "2 columns",
    subtitle: "Split into left & right",
    icon: "▥",
    keywords: "columns two split layout side left right lego",
    command: ({ editor, range }) => insertColumns(editor, range, 2),
  },
  {
    title: "3 columns",
    subtitle: "Split into three columns",
    icon: "▦",
    keywords: "columns three split layout thirds lego",
    command: ({ editor, range }) => insertColumns(editor, range, 3),
  },
  {
    title: "Page reference",
    subtitle: "Link to another page (@)",
    icon: "📄",
    keywords: "page reference link mention embed relation @",
    command: ({ editor, range }) =>
      // Replace "/query" with "@" so the page-mention menu takes over.
      editor.chain().focus().deleteRange(range).insertContent("@").run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (i) =>
      i.title.toLowerCase().includes(q) || i.keywords.includes(q),
  );
}

// A self-contained floating popup (no external positioning lib / no React) so
// the menu stays inside this module and the CSP-free build.
function createSlashRenderer() {
  let el: HTMLDivElement | null = null;
  let items: SlashItem[] = [];
  let rows: HTMLButtonElement[] = [];
  let selected = 0;
  let cmd: (item: SlashItem) => void = () => {};

  function applySelected() {
    rows.forEach((r, i) => r.classList.toggle("is-selected", i === selected));
  }

  // Rebuild the button list. Called only when the item set changes — hover just
  // toggles a class (rebuilding on hover would destroy the button mid-click).
  function build() {
    if (!el) return;
    el.innerHTML = "";
    rows = [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = "No blocks";
      el.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "slash-item";
      row.innerHTML =
        `<span class="slash-item-icon">${item.icon}</span>` +
        `<span class="slash-item-text"><span class="slash-item-title">${item.title}</span>` +
        `<span class="slash-item-sub">${item.subtitle}</span></span>`;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cmd(item);
      });
      row.addEventListener("mouseover", () => {
        selected = i;
        applySelected();
      });
      el!.appendChild(row);
      rows.push(row);
    });
    applySelected();
  }

  function position(rect: DOMRect | null) {
    if (!el || !rect) return;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 6}px`;
  }

  return {
    onStart: (props: {
      items: SlashItem[];
      command: (item: SlashItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) => {
      items = props.items;
      selected = 0;
      cmd = props.command;
      el = document.createElement("div");
      el.className = "slash-menu";
      document.body.appendChild(el);
      build();
      position(props.clientRect?.() ?? null);
    },
    onUpdate: (props: {
      items: SlashItem[];
      command: (item: SlashItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) => {
      items = props.items;
      cmd = props.command;
      if (selected >= items.length) selected = 0;
      build();
      position(props.clientRect?.() ?? null);
    },
    onKeyDown: (props: { event: KeyboardEvent }): boolean => {
      if (!el || items.length === 0) return false;
      const { key } = props.event;
      if (key === "ArrowDown") {
        selected = (selected + 1) % items.length;
        applySelected();
        return true;
      }
      if (key === "ArrowUp") {
        selected = (selected - 1 + items.length) % items.length;
        applySelected();
        return true;
      }
      if (key === "Enter") {
        const item = items[selected];
        if (item) cmd(item);
        return true;
      }
      if (key === "Escape") {
        return true;
      }
      return false;
    },
    onExit: () => {
      el?.remove();
      el = null;
      rows = [];
    },
  };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        startOfLine: false,
        command: ({ editor, range, props }) => props.command({ editor, range }),
        items: ({ query }) => filterItems(query),
        render: createSlashRenderer,
      }),
    ];
  },
});
