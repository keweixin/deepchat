/**
 * Markdown Rendering Pipeline
 * marked.js → highlight.js (selective) → KaTeX → Mermaid → DOMPurify
 *
 * Optimizations:
 * - Only import commonly used languages (saves ~300KB bundle)
 * - Incremental rendering support for streaming
 * - Lazy Mermaid rendering
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, escapeRegExp } from './shared-utils.js';
import { renderWidgets } from './widgets.js';
import { bindZoomableMedia } from './media-viewer.js';

// Import highlight.js CORE + only common languages (not the full 190+ bundle)
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import plaintext from 'highlight.js/lib/languages/plaintext';

// Register languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

import 'highlight.js/styles/github-dark-dimmed.css';

let mermaidPromise: Promise<any> | null = null;

// ─── Configure marked ───

let mermaidCounter = 0;
const ANSWER_COMPONENT_TYPES: Record<string, { label: string; className: string }> = Object.freeze({
  summary: { label: '摘要', className: 'answer-component-summary' },
  warning: { label: '注意', className: 'answer-component-warning' },
  steps: { label: '步骤', className: 'answer-component-steps' },
  decision: { label: '决策', className: 'answer-component-decision' },
  source: { label: '来源', className: 'answer-component-source' },
  evidence: { label: '证据', className: 'answer-component-evidence' },
  tradeoff: { label: '取舍', className: 'answer-component-tradeoff' },
  next: { label: '下一步', className: 'answer-component-next' },
  todo: { label: 'TODO', className: 'answer-component-todo' },
  'tool-result': { label: '工具结果', className: 'answer-component-tool-result' },
});

const renderer = new marked.Renderer();

// Custom code block renderer: wrap with header + copy button
renderer.code = function ({ text, lang }: any) {
  const language = lang || '';
  const langLower = language.toLowerCase();

  if (['widget', 'interactive', 'component', 'deepchat-widget'].includes(langLower)) {
    return `<div class="widget-placeholder" data-widget="${encodeURIComponent(text)}"></div>`;
  }

  // Mermaid diagram
  if (langLower === 'mermaid') {
    const id = `mermaid-${Date.now()}-${mermaidCounter++}`;
    return `<div class="mermaid-wrapper" data-mermaid-id="${id}"><pre class="mermaid">${escapeHtml(text)}</pre></div>`;
  }

  // Syntax highlighting
  let highlighted: string;
  if (langLower && hljs.getLanguage(langLower)) {
    try {
      highlighted = hljs.highlight(text, { language: langLower }).value;
    } catch (_) {
      highlighted = escapeHtml(text);
    }
  } else if (langLower) {
    // Unknown language, just escape
    highlighted = escapeHtml(text);
  } else {
    // No language specified, try auto-detect (limited to registered languages)
    try {
      highlighted = hljs.highlightAuto(text).value;
    } catch (_) {
      highlighted = escapeHtml(text);
    }
  }

  // Wrap each line for line-number display
  const rawLines = highlighted.split('\n');
  // Remove trailing empty line that most code blocks have
  if (rawLines.length > 1 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
  const lineCount = rawLines.length;
  const numberedLines = rawLines.map((line) => `<span class="code-line">${line || ' '}</span>`).join('\n');

  const langLabel = language || 'code';
  const lineInfo = lineCount > 1 ? `<span class="code-line-count">${lineCount} 行</span>` : '';
  const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const collapsible = lineCount > 15 ? ' is-collapsible is-collapsed' : '';

  const isRunnable = ['javascript', 'js'].includes(langLower);
  const runBtnHtml = isRunnable
    ? `<button class="code-run-btn" data-language="javascript" data-code="${encodeURIComponent(text)}" title="运行代码">▶ 运行</button>`
    : '';

  return `<div class="code-block-wrapper${collapsible}" data-line-count="${lineCount}">
    <div class="code-block-header">
      <span class="code-lang-label">${escapeHtml(langLabel)}</span>
      ${lineInfo}
      ${runBtnHtml}
      <button class="code-copy-btn" data-code="${encodeURIComponent(text)}" title="复制代码">
        <span class="copy-icon">${copyIcon}</span>
        <span class="check-icon" hidden>${checkIcon}</span>
        <span class="copy-text">复制</span>
      </button>
    </div>
    <pre><code class="hljs language-${escapeHtml(langLower)} has-line-numbers">${numberedLines}</code></pre>
    ${collapsible ? '<button class="code-expand-btn" type="button">展开全部</button>' : ''}
  </div>`;
};

// Treat raw HTML from model/user Markdown as text. DeepChat renders a small
// controlled HTML subset through custom renderers instead of trusting raw HTML.
renderer.html = function ({ text }: any) {
  return escapeHtml(text);
};

// Open links in new tab to prevent navigating away from the app.
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

renderer.link = function ({ href, title, tokens }: any) {
  const text = (this as any).parser.parseInline(tokens);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';

  let safeHref = '#';
  try {
    const url = new URL(href, 'https://example.com');
    if (ALLOWED_LINK_PROTOCOLS.has(url.protocol)) {
      safeHref = escapeHtml(href);
    }
  } catch {
    // Invalid URL, keep as #
  }

  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
};

// Render images as media blocks so they can be opened in the built-in viewer.
renderer.image = function ({ href, title, text }: any) {
  const src = String(href || '').trim();
  if (!src) return '';

  const alt = String(text || '').trim();
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const caption = alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : '';
  return `<figure class="markdown-media-frame markdown-image-frame">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" decoding="async">
    <span class="media-zoom-hint" aria-hidden="true">点击放大</span>
    ${caption}
  </figure>`;
};

// Wrap GitHub-flavored tables so wide comparisons remain readable.
renderer.table = function (token: any) {
  const tableKind = classifyTableToken(token);
  let header = '';
  for (const cell of token.header) {
    header += (this as any).tablecell(cell);
  }

  let body = '';
  for (const row of token.rows) {
    let cells = '';
    for (const cell of row) {
      cells += (this as any).tablecell(cell);
    }
    body += (this as any).tablerow({ text: cells });
  }

  return `<div class="markdown-table-wrap" data-table-kind="${tableKind}">
    <div class="markdown-table-toolbar"><span>表格</span><button class="table-export-btn" type="button">导出 CSV</button></div>
    <table>
      <thead>${(this as any).tablerow({ text: header })}</thead>
      ${body ? `<tbody>${body}</tbody>` : ''}
    </table>
  </div>`;
};

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true,
});

// ─── DOMPurify config ───

const purifyConfig = {
  ALLOWED_TAGS: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'div',
    'span',
    'figure',
    'figcaption',
    'strong',
    'em',
    'del',
    's',
    'u',
    'sub',
    'sup',
    'mark',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'input',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'pre',
    'code',
    'blockquote',
    'button',
    'svg',
    'path',
    'line',
    'rect',
    'circle',
    'polyline',
    'polygon',
    'text',
    'defs',
    'linearGradient',
    'stop',
    'iframe',
    'select',
    'option',
    'label',
  ],
  ALLOWED_ATTR: [
    'class',
    'id',
    'href',
    'src',
    'placeholder',
    'sandbox',
    'style',
    'alt',
    'title',
    'target',
    'rel',
    'data-code',
    'data-mermaid-id',
    'align',
    'loading',
    'decoding',
    'type',
    'checked',
    'disabled',
    'hidden',
    'role',
    'aria-label',
    'width',
    'height',
    'viewBox',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'd',
    'points',
    'x',
    'y',
    'rx',
    'ry',
    'cx',
    'cy',
    'r',
    'x1',
    'y1',
    'x2',
    'y2',
    'offset',
    'stop-color',
    'gradientTransform',
  ],
  ALLOW_DATA_ATTR: true,
};

// ─── Exports ───

/**
 * Render markdown string to sanitized HTML
 */
export function renderMarkdown(md: string) {
  if (!md) return '';
  const { markdown, components } = extractAnswerComponents(md);
  let html = marked.parse(markdown) as string;
  html = DOMPurify.sanitize(html, purifyConfig);
  html = injectAnswerComponents(html, components);
  return html;
}

/**
 * Post-process a DOM element: render KaTeX + Mermaid + copy handlers
 * @param skipIfProcessed - If true, skip containers already marked with data-post-processed.
 *                          Use for historical messages to avoid redundant work on re-render.
 */
export async function postProcess(container: HTMLElement, skipIfProcessed = false) {
  if (skipIfProcessed && container.dataset.postProcessed === '1') return;
  await renderKatex(container);
  await renderMermaidDiagrams(container);
  decorateMermaidDiagrams(container);
  renderWidgets(container);
  decorateReadableContent(container);
  attachCopyHandlers(container);
  bindZoomableMedia(container);
  container.dataset.postProcessed = '1';
}

/**
 * Render KaTeX in a container
 */
let _renderMathInElement: any = null;

async function renderKatex(container: HTMLElement) {
  try {
    if (!_renderMathInElement) {
      const mod = await import('katex/contrib/auto-render');
      _renderMathInElement = mod.default || mod;
      await import('katex/dist/katex.min.css');
    }
    _renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      trust: false,
    });
  } catch {
    // Silently ignore invalid LaTeX fragments.
  }
}

/**
 * Render Mermaid diagrams (only unrendered ones)
 */
async function renderMermaidDiagrams(container: HTMLElement) {
  const mermaidEls = container.querySelectorAll('.mermaid-wrapper .mermaid:not([data-processed])');
  if (mermaidEls.length === 0) return;

  // Use IntersectionObserver for lazy rendering if available
  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(
      async (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;

        const nodesToRender: HTMLElement[] = [];
        for (const entry of visible) {
          const target = entry.target as HTMLElement;
          observer.unobserve(target);
          if (!target.hasAttribute('data-processed')) {
            target.setAttribute('data-processed', '1');
            nodesToRender.push(target);
          }
        }

        if (nodesToRender.length === 0) return;
        try {
          const mermaid = await getMermaid();
          await mermaid.run({ nodes: nodesToRender });
        } catch {
          // Silently ignore malformed diagram syntax.
        }
      },
      { rootMargin: '200px' }
    );
    mermaidEls.forEach((el) => observer.observe(el));
  } else {
    // Fallback: render immediately
    try {
      const mermaid = await getMermaid();
      mermaidEls.forEach((el) => el.setAttribute('data-processed', '1'));
      await mermaid.run({ nodes: Array.from(mermaidEls) as HTMLElement[] });
    } catch {
      // Silently ignore malformed diagram syntax.
    }
  }
}

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod: any) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        themeVariables: {
          darkMode: true,
          background: '#10161a',
          primaryColor: '#2dd4bf',
          primaryTextColor: '#e6edf3',
          primaryBorderColor: '#2dd4bf',
          lineColor: '#a8b3bd',
          secondaryColor: '#f59e0b',
          tertiaryColor: '#172027',
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Attach click handlers to code copy buttons (idempotent)
 */
function attachCopyHandlers(container: HTMLElement) {
  container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn) => {
    const button = btn as HTMLElement;
    button.setAttribute('data-bound', '1');

    button.addEventListener('click', async () => {
      const code = decodeURIComponent(button.dataset.code || '');
      try {
        await navigator.clipboard.writeText(code);
        const copyIcon = button.querySelector('.copy-icon') as HTMLElement | null;
        const checkIcon = button.querySelector('.check-icon') as HTMLElement | null;
        const copyText = button.querySelector('.copy-text') as HTMLElement | null;
        if (copyIcon) copyIcon.hidden = true;
        if (checkIcon) checkIcon.hidden = false;
        if (copyText) copyText.textContent = '已复制';
        button.classList.add('copied');

        setTimeout(() => {
          if (copyIcon) copyIcon.hidden = false;
          if (checkIcon) checkIcon.hidden = true;
          if (copyText) copyText.textContent = '复制';
          button.classList.remove('copied');
        }, 1500);
      } catch {
        // Clipboard permission denied or transient failure — silently ignore.
      }
    });
  });

  // Code block expand/collapse
  container.querySelectorAll('.code-expand-btn:not([data-bound])').forEach((btn) => {
    const button = btn as HTMLElement;
    button.setAttribute('data-bound', '1');
    button.addEventListener('click', () => {
      const wrapper = button.closest('.code-block-wrapper') as HTMLElement | null;
      if (!wrapper) return;
      const collapsed = wrapper.classList.toggle('is-collapsed');
      button.textContent = collapsed ? '展开全部' : '收起';
    });
  });

  container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn) => {
    const button = btn as HTMLElement;
    button.setAttribute('data-bound', '1');
    button.addEventListener('click', () => {
      document.dispatchEvent(
        new CustomEvent('deepchat:run-code-block', {
          detail: {
            button,
            code: decodeURIComponent(button.dataset.code || ''),
            language: button.dataset.language || 'javascript',
          },
        })
      );
    });
  });

  container.querySelectorAll('.table-export-btn:not([data-bound])').forEach((btn) => {
    const button = btn as HTMLElement;
    button.setAttribute('data-bound', '1');
    button.addEventListener('click', () =>
      exportTableCsv(button.closest('.markdown-table-wrap') as HTMLElement | null)
    );
  });

  container.querySelectorAll('.mermaid-download-btn:not([data-bound])').forEach((btn) => {
    const button = btn as HTMLElement;
    button.setAttribute('data-bound', '1');
    button.addEventListener('click', () =>
      downloadMermaid(button.closest('.mermaid-wrapper') as HTMLElement | null, button.dataset.format || 'svg')
    );
  });
}

function decorateMermaidDiagrams(container: HTMLElement) {
  container.querySelectorAll('.mermaid-wrapper:not([data-controls-bound])').forEach((wrapper) => {
    const el = wrapper as HTMLElement;
    if (!el.querySelector('svg')) return;
    el.dataset.controlsBound = '1';
    const controls = document.createElement('div');
    controls.className = 'mermaid-actions';
    const svgBtn = document.createElement('button');
    svgBtn.type = 'button';
    svgBtn.className = 'mermaid-download-btn';
    svgBtn.dataset.format = 'svg';
    svgBtn.textContent = '下载 SVG';
    const pngBtn = document.createElement('button');
    pngBtn.type = 'button';
    pngBtn.className = 'mermaid-download-btn';
    pngBtn.dataset.format = 'png';
    pngBtn.textContent = '下载 PNG';
    controls.append(svgBtn, pngBtn);
    el.appendChild(controls);
  });
}

function exportTableCsv(wrapper: HTMLElement | null) {
  const table = wrapper?.querySelector('table');
  if (!table) return;
  const rows = [...table.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) => csvEscape((cell as HTMLElement).textContent?.trim())).join(',')
  );
  downloadText(rows.join('\n'), 'deepchat-table.csv', 'text/csv;charset=utf-8');
}

function downloadMermaid(wrapper: HTMLElement | null, format: string) {
  const svg = wrapper?.querySelector('svg');
  if (!svg) return;
  const serialized = new XMLSerializer().serializeToString(svg);
  if (format === 'svg') {
    downloadText(serialized, 'deepchat-diagram.svg', 'image/svg+xml;charset=utf-8');
    return;
  }
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 1200;
    canvas.height = image.naturalHeight || 800;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      downloadBlob(pngBlob, 'deepchat-diagram.png');
    }, 'image/png');
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}

function csvEscape(value: string | undefined) {
  const text = String(value || '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadText(text: string, fileName: string, type: string) {
  downloadBlob(new Blob([text], { type }), fileName);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function decorateReadableContent(container: HTMLElement) {
  resetAdaptiveDecorations(container);
  decorateCallouts(container);
  decorateLists(container);
  classifyAnswer(container);
  decorateSummary(container);
}

function resetAdaptiveDecorations(container: HTMLElement) {
  container.classList.remove(
    'answer-short',
    'answer-long',
    'answer-tutorial',
    'answer-compare',
    'answer-code',
    'answer-visual',
    'answer-table-dense',
    'answer-troubleshoot',
    'answer-report',
    'answer-sourced'
  );
  container
    .querySelectorAll('.answer-note, .answer-callout, .answer-summary, .answer-steps, .answer-checklist')
    .forEach((node) => {
      const el = node as HTMLElement;
      if (el.classList.contains('answer-component')) return;
      el.classList.remove('answer-note', 'answer-callout', 'answer-summary', 'answer-steps', 'answer-checklist');
      delete el.dataset.calloutType;
      delete el.dataset.noteType;
    });
}

function decorateCallouts(container: HTMLElement) {
  container.querySelectorAll('p').forEach((paragraph) => {
    const text = paragraph.textContent?.trim() || '';
    const match = text.match(/^(结论|总结|重点|注意|风险|建议|下一步|提示|前提|假设|来源|参考|引用|适用|不适用)[:：]/);
    if (!match) return;
    paragraph.classList.add('answer-note', 'answer-callout');
    paragraph.dataset.noteType = match[1];
    paragraph.dataset.calloutType = getCalloutType(match[1]);
  });
}

function decorateLists(container: HTMLElement) {
  container.querySelectorAll('ol').forEach((list) => {
    const itemCount = directListItems(list).length;
    const previous = previousTextBlock(list);
    if (itemCount >= 3 || /步骤|流程|方法|操作|实现|修复|验证|计划/.test(previous)) {
      list.classList.add('answer-steps');
    }
  });

  container.querySelectorAll('ul').forEach((list) => {
    if (list.querySelector('input[type="checkbox"]') || list.querySelector('.task-list-item')) {
      list.classList.add('answer-checklist');
    }
  });
}

function classifyAnswer(container: HTMLElement) {
  const text = normalizeWhitespace(container.textContent);
  const textLength = text.length;
  const headings = container.querySelectorAll('h1,h2,h3,h4').length;
  const paragraphs = container.querySelectorAll('p').length;
  const tables = [...container.querySelectorAll('.markdown-table-wrap')];
  const tableRows = container.querySelectorAll('tbody tr').length;
  const codeBlocks = container.querySelectorAll('.code-block-wrapper').length;
  const visuals = container.querySelectorAll('.mermaid-wrapper,.markdown-media-frame,.dc-widget').length;
  const lists = container.querySelectorAll('ol,ul').length;
  const blockCount = headings + paragraphs + tables.length + codeBlocks + visuals + lists;
  const hasHeavyBlock = headings > 0 || tables.length > 0 || codeBlocks > 0 || visuals > 0 || lists > 0;

  if (textLength <= 180 && !hasHeavyBlock) container.classList.add('answer-short');
  if (textLength > 420 || headings >= 2 || blockCount >= 6) container.classList.add('answer-long');
  if (container.querySelector('.answer-steps') || /步骤|教程|操作步骤|操作流程|处理流程|怎么做|如何做/.test(text))
    container.classList.add('answer-tutorial');
  if (
    tables.some((table) => (table as HTMLElement).dataset.tableKind === 'compare') ||
    /对比|比较|区别|选型|取舍|方案\s*[A-ZＡ-Ｚ一二三四五六]?/.test(text)
  )
    container.classList.add('answer-compare');
  if (codeBlocks > 0) container.classList.add('answer-code');
  if (visuals > 0) container.classList.add('answer-visual');
  if (tables.length >= 2 || tableRows >= 6) container.classList.add('answer-table-dense');
  if (/报错|错误|失败|排查|修复|验证|复现|原因/.test(text)) container.classList.add('answer-troubleshoot');
  if (/摘要|依据|风险|建议|结论|分析|评估|报告/.test(text) && (headings >= 2 || paragraphs >= 4))
    container.classList.add('answer-report');
  if (container.querySelectorAll('a').length >= 2 || container.querySelector('[data-callout-type="source"]'))
    container.classList.add('answer-sourced');
}

function decorateSummary(container: HTMLElement) {
  if (!container.classList.contains('answer-long')) return;
  const first = firstMeaningfulChild(container);
  if (first?.classList?.contains('answer-component')) return;
  if (!first || first.tagName !== 'P') return;
  const text = normalizeWhitespace(first.textContent);
  if (text.length < 12 || text.length > 160) return;
  first.classList.add('answer-summary');
}

function extractAnswerComponents(markdown = '') {
  const components: any[] = [];
  const source = String(markdown || '');
  const output = source.replace(
    /^:::(summary|warning|steps|decision|source|evidence|tradeoff|next|todo|tool-result)[ \t]*\n([\s\S]*?)^:::[ \t]*$/gim,
    (_match: string, type: string, body: string) => {
      const normalizedType = String(type || '').toLowerCase();
      const config = ANSWER_COMPONENT_TYPES[normalizedType];
      if (!config) return _match;
      const token = `DEEPCOMPONENT_${components.length}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      components.push({
        token,
        type: normalizedType,
        label: config.label,
        className: config.className,
        body: String(body || '').trim(),
      });
      return `\n\n${token}\n\n`;
    }
  );
  return { markdown: output, components };
}

function injectAnswerComponents(html = '', components: any[] = []) {
  if (!components.length) return html;
  let output = html;
  for (const component of components) {
    const componentHtml = renderAnswerComponent(component);
    const escapedToken = escapeRegExp(component.token);
    output = output
      .replace(new RegExp(`<p>\\s*${escapedToken}\\s*</p>`, 'g'), componentHtml)
      .replace(new RegExp(escapedToken, 'g'), componentHtml);
  }
  return output;
}

function renderAnswerComponent(component: any) {
  const inner = DOMPurify.sanitize(marked.parse(component.body || '') as string, purifyConfig);
  return `<div class="answer-component ${component.className}" data-component-type="${escapeHtml(component.type)}">
    <div class="answer-component-label">${escapeHtml(component.label)}</div>
    <div class="answer-component-body">${inner}</div>
  </div>`;
}

function classifyTableToken(token: any) {
  const headers = (token?.header || []).map(getTableCellText);
  const rows = (token?.rows || []).map((row: any[]) => row.map(getTableCellText));
  const allText = normalizeWhitespace([...headers, ...rows.flat()].join(' '));
  const firstHeader = headers[0] || '';
  const columnCount = headers.length;

  if (
    /对比|比较|区别|方案|维度|优点|缺点|优势|劣势|适用|不适用|取舍|选择|推荐/.test(allText) ||
    (columnCount >= 3 && /维度|项目|能力|特性|指标|标准/.test(firstHeader))
  ) {
    return 'compare';
  }

  if (columnCount <= 2 && rows.length <= 12 && /参数|配置|字段|属性|项目|名称|键|说明|值|含义/.test(allText)) {
    return 'kv';
  }

  return 'data';
}

function getTableCellText(cell: any) {
  if (!cell) return '';
  return normalizeWhitespace(cell.text || cell.raw || '');
}

function getCalloutType(label: string) {
  if (/结论|总结|重点/.test(label)) return 'conclusion';
  if (/风险|注意/.test(label)) return 'risk';
  if (/来源|参考|引用/.test(label)) return 'source';
  if (/下一步/.test(label)) return 'next';
  if (/前提|假设/.test(label)) return 'premise';
  if (/不适用/.test(label)) return 'avoid';
  if (/适用/.test(label)) return 'fit';
  return 'tip';
}

function directListItems(list: HTMLElement) {
  return [...list.children].filter((child) => child.tagName === 'LI');
}

function previousTextBlock(node: HTMLElement) {
  let previous = node.previousElementSibling as HTMLElement | null;
  while (previous) {
    const text = normalizeWhitespace(previous.textContent);
    if (text) return text;
    previous = previous.previousElementSibling as HTMLElement | null;
  }
  return '';
}

function firstMeaningfulChild(container: HTMLElement) {
  return [...container.children].find((child) => normalizeWhitespace(child.textContent)) as HTMLElement | undefined;
}

/**
 * Safely set HTML content on an element.
 * Use for HTML that may contain user-controlled content.
 * For renderMarkdown() output (already sanitized), direct innerHTML is acceptable.
 */
export function safeSetHTML(el: HTMLElement, html: string, options: { source?: string; sanitize?: boolean } = {}) {
  const { sanitize = true } = options;
  if (sanitize) {
    el.innerHTML = DOMPurify.sanitize(html, purifyConfig);
  } else {
    el.innerHTML = html;
  }
}

function normalizeWhitespace(value: string | null) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}
