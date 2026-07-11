import { Node, Extension, mergeAttributes } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";

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
