import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

function jsonToHtml(node: Record<string, unknown>): string {
  if (!node || typeof node !== 'object') return '';
  const type = node.type as string;
  const content = (node.content as Record<string, unknown>[] | undefined) ?? [];

  const inner = () => content.map((c) => jsonToHtml(c)).join('');

  switch (type) {
    case 'doc': return inner();
    case 'paragraph': {
      const html = inner();
      return html ? `<p>${html}</p>` : '<p><br></p>';
    }
    case 'heading': {
      const level = (node.attrs as Record<string, unknown>)?.level ?? 1;
      return `<h${level}>${inner()}</h${level}>`;
    }
    case 'bulletList': return `<ul>${inner()}</ul>`;
    case 'orderedList': return `<ol>${inner()}</ol>`;
    case 'listItem': return `<li>${inner()}</li>`;
    case 'blockquote': return `<blockquote>${inner()}</blockquote>`;
    case 'codeBlock': return `<pre><code>${inner()}</code></pre>`;
    case 'horizontalRule': return `<hr>`;
    case 'hardBreak': return `<br>`;
    case 'text': {
      let text = escapeHtml(node.text as string ?? '');
      const marks = (node.marks as Record<string, unknown>[] | undefined) ?? [];
      for (const mark of marks) {
        switch ((mark as Record<string, unknown>).type) {
          case 'bold': text = `<strong>${text}</strong>`; break;
          case 'italic': text = `<em>${text}</em>`; break;
          case 'code': text = `<code>${text}</code>`; break;
          case 'strike': text = `<s>${text}</s>`; break;
          case 'underline': text = `<u>${text}</u>`; break;
          case 'link': {
            const href = escapeHtml(((mark as Record<string, unknown>).attrs as Record<string, unknown>)?.href as string ?? '#');
            text = `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
            break;
          }
        }
      }
      return text;
    }
    case 'image': {
      const src = escapeHtml((node.attrs as Record<string, unknown>)?.src as string ?? '');
      const alt = escapeHtml((node.attrs as Record<string, unknown>)?.alt as string ?? '');
      return src ? `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:6px;margin:8px 0;">` : '';
    }
    default: return inner();
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPublicPage(title: string, icon: string | null, tags: string[], bodyHtml: string, publishedAt: Date | null, publishTheme: string, webOrigin: string): string {
  const displayTitle = escapeHtml(title || 'Untitled');
  const iconHtml = icon ? `<span class="page-icon">${icon}</span>` : '';
  const dateStr = publishedAt
    ? new Date(publishedAt).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : '';

  // Theme-specific CSS variable overrides
  const themeOverrides: Record<string, string> = {
    dark: `
      --text: #e8e8e5; --muted: #6f6f6c; --border: #2f2f2f;
      --bg: #191919; --code-bg: rgba(255,255,255,0.07); --pre-bg: #252525;
      --accent: #5b8def; --topbar-bg: rgba(25,25,25,0.92);`,
    muji: `
      --text: #4a4035; --muted: #9b9080; --border: #e0d8cc;
      --bg: #f5f0e8; --code-bg: rgba(139,117,85,0.10); --pre-bg: #ede8de;
      --accent: #8b6f47; --topbar-bg: rgba(245,240,232,0.92);`,
    vscode: `
      --text: #d4d4d4; --muted: #6a737d; --border: #3e3e42;
      --bg: #1e1e1e; --code-bg: rgba(255,255,255,0.06); --pre-bg: #252526;
      --accent: #569cd6; --topbar-bg: rgba(30,30,30,0.95);`,
    light: ``,
  };
  const themeVars = themeOverrides[publishTheme] ?? '';

  // Build colored tag badges using a simple hash
  function tagColor(tag: string): { bg: string; fg: string } {
    const palette = [
      { bg: 'rgba(35,131,226,0.15)',  fg: '#2383e2' },
      { bg: 'rgba(66,166,96,0.18)',   fg: '#2d8a2d' },
      { bg: 'rgba(200,117,51,0.18)',  fg: '#b85c00' },
      { bg: 'rgba(127,63,191,0.18)',  fg: '#7030a0' },
      { bg: 'rgba(208,48,48,0.15)',   fg: '#c02020' },
      { bg: 'rgba(19,152,127,0.18)',  fg: '#0d7a63' },
      { bg: 'rgba(183,59,126,0.15)',  fg: '#a0306a' },
      { bg: 'rgba(120,120,120,0.12)', fg: '#5a5a5a' },
    ];
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = tag.charCodeAt(i) + ((h << 5) - h);
    const p = palette[Math.abs(h) % palette.length]!;
    return p;
  }
  const tagsHtml = tags.length > 0
    ? `<div class="page-tags">${tags.map((t) => {
        const { bg, fg } = tagColor(t);
        return `<span class="page-tag" style="background:${bg};color:${fg}">${escapeHtml(t)}</span>`;
      }).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayTitle}</title>
  <meta name="description" content="A shared page from YMCA workspace">
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    :root {
      --text: #37352f;
      --muted: #9b9a97;
      --border: #e9e9e7;
      --bg: #ffffff;
      --code-bg: rgba(135,131,120,0.15);
      --pre-bg: #f7f6f3;
      --accent: #2383e2;
      --topbar-bg: rgba(255,255,255,0.9);
      --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      ${themeVars}
    }

    html { font-size: 16px; -webkit-font-smoothing: antialiased; }

    body {
      margin: 0;
      padding: 0;
      font-family: var(--font);
      color: var(--text);
      background: var(--bg);
      line-height: 1.65;
    }

    /* Top bar */
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 45px;
      background: var(--topbar-bg);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      z-index: 100;
    }

    .topbar-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: var(--text);
    }

    .topbar-logo {
      width: 24px;
      height: 24px;
      background: var(--text);
      color: white;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
    }

    .topbar-name { font-size: 14px; font-weight: 600; }
    .topbar-badge { font-size: 11px; color: var(--muted); background: #f1f0ee; border-radius: 4px; padding: 2px 8px; }

    /* Page layout */
    .page-wrapper { padding-top: 80px; padding-bottom: 120px; }
    .page-inner { max-width: 720px; margin: 0 auto; padding: 0 64px; }
    @media (max-width: 768px) { .page-inner { padding: 0 24px; } }

    /* Page header */
    .page-icon { display: block; font-size: 60px; line-height: 1; margin-bottom: 16px; }

    .page-title {
      font-size: 40px; font-weight: 700; color: var(--text);
      line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.5px;
    }

    /* Tags */
    .page-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
    .page-tag {
      display: inline-flex; align-items: center;
      font-size: 11px; font-weight: 500;
      padding: 2px 10px; border-radius: 999px;
      white-space: nowrap;
    }

    .page-meta {
      font-size: 13px; color: var(--muted); margin-bottom: 40px;
      padding-bottom: 24px; border-bottom: 1px solid var(--border);
    }

    /* Content */
    .page-content { font-size: 16px; color: var(--text); }
    .page-content > * + * { margin-top: 4px; }
    .page-content p { margin: 0; padding: 3px 2px; min-height: 1em; }
    .page-content h1 { font-size: 1.875rem; font-weight: 700; margin: 1.4em 0 2px; line-height: 1.3; }
    .page-content h2 { font-size: 1.5rem;   font-weight: 600; margin: 1.2em 0 2px; line-height: 1.3; }
    .page-content h3 { font-size: 1.25rem;  font-weight: 600; margin: 1em 0 2px; }
    .page-content strong { font-weight: 600; }
    .page-content em { font-style: italic; }
    .page-content s { text-decoration: line-through; color: var(--muted); }
    .page-content u { text-decoration: underline; }
    .page-content a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    .page-content a:hover { opacity: 0.75; }
    .page-content code { font-family: var(--font-mono); font-size: 85%; background: var(--code-bg); color: #eb5757; border-radius: 3px; padding: 0.2em 0.4em; }
    .page-content pre { background: var(--pre-bg); border-radius: 6px; padding: 16px 20px; overflow-x: auto; margin: 8px 0; border: 1px solid var(--border); }
    .page-content pre code { background: none; color: var(--text); padding: 0; font-size: 14px; }
    .page-content blockquote { border-left: 3px solid var(--border); padding-left: 16px; margin: 4px 0; color: var(--muted); }
    .page-content ul, .page-content ol { padding-left: 24px; margin: 4px 0; }
    .page-content li { margin: 2px 0; }
    .page-content hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

    /* Footer */
    .page-footer {
      max-width: 720px; margin: 60px auto 0;
      padding: 24px 64px 0; border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; color: var(--muted);
    }
    @media (max-width: 768px) { .page-footer { padding: 24px 24px 0; } .page-title { font-size: 28px; } }
  </style>
</head>
<body>

  <nav class="topbar">
    <a href="${webOrigin}" class="topbar-brand">
      <div class="topbar-logo">Y</div>
      <span class="topbar-name">YMCA</span>
    </a>
    <span class="topbar-badge">Published page</span>
  </nav>

  <div class="page-wrapper">
    <div class="page-inner">
      <header>
        ${iconHtml}
        <h1 class="page-title">${displayTitle}</h1>
        ${tagsHtml}
        ${dateStr ? `<p class="page-meta">Published ${dateStr}</p>` : ''}
      </header>

      <article class="page-content">
        ${bodyHtml || '<p style="color:#9b9a97">This page has no content yet.</p>'}
      </article>
    </div>

    <footer class="page-footer">
      <span>Created with YMCA Workspace</span>
      <span>${dateStr}</span>
    </footer>
  </div>

</body>
</html>`;
}

export async function registerPublicPageRoutes(app: FastifyInstance) {
  app.get(
    '/public/:shareToken',
    {
      schema: {
        params: {
          type: 'object',
          properties: { shareToken: { type: 'string' } },
          required: ['shareToken'],
        },
      },
    },
    async (request, reply) => {
      const { shareToken } = request.params as { shareToken: string };

      // Derive web UI origin from the request host (swap port 4000 → 5173)
      const reqHost = request.headers['host'] ?? 'localhost:4000';
      const hostname = reqHost.split(':')[0];
      const webOrigin = `http://${hostname}:5173`;

      const page = await prisma.page.findUnique({
        where: { publishToken: shareToken },
        select: {
          id: true,
          title: true,
          icon: true,
          tags: true,
          content: true,
          version: true,
          publishedAt: true,
          publishTheme: true,
          isPublished: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!page || !page.isPublished) {
        return reply
          .status(404)
          .header('content-type', 'text/html; charset=utf-8')
          .send(`<!DOCTYPE html><html><head><title>Page not found</title>
            <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f6f3;}
            .box{text-align:center;color:#37352f;} h1{font-size:2rem;margin-bottom:8px;} p{color:#9b9a97;}</style>
            </head><body><div class="box"><h1>404</h1><p>This page is not published or does not exist.</p>
            <a href="${webOrigin}" style="color:#2383e2;font-size:14px;margin-top:16px;display:inline-block;">Back to YMCA</a>
            </div></body></html>`);
      }

      const bodyHtml = jsonToHtml(page.content as Record<string, unknown>);
      const html = renderPublicPage(page.title, page.icon, page.tags, bodyHtml, page.publishedAt, page.publishTheme, webOrigin);

      return reply
        .status(200)
        .header('content-type', 'text/html; charset=utf-8')
        .send(html);
    },
  );
}

