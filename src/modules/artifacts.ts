import { escapeHtml } from './shared-utils.js';

const HTML_ARTIFACT_LANGS = new Set(['html', 'htm']);
const MERMAID_LANGS = new Set(['mermaid']);
const TABLE_LANGS = new Set(['csv', 'tsv']);
const JSON_LANGS = new Set(['json']);
const CODE_FILE_LANGS = new Set([
  'js',
  'javascript',
  'ts',
  'typescript',
  'jsx',
  'tsx',
  'py',
  'python',
  'java',
  'c',
  'cpp',
  'c++',
  'cs',
  'csharp',
  'go',
  'golang',
  'rust',
  'rs',
  'ruby',
  'rb',
  'php',
  'swift',
  'kotlin',
  'kt',
  'scala',
  'r',
  'sql',
  'sh',
  'bash',
  'zsh',
  'powershell',
  'ps1',
  'yaml',
  'yml',
  'toml',
  'ini',
  'dockerfile',
  'makefile',
  'graphql',
  'gql',
  'css',
  'scss',
  'sass',
  'less',
  'xml',
  'svg',
]);

const MAX_ARTIFACTS = 8;
const DEFAULT_MAX_SOURCE_CHARS = 80_000;

const TYPE_LABELS: Record<string, string> = {
  'html-preview': 'HTML 预览',
  mermaid: 'Mermaid 图表',
  table: '表格',
  'json-data': 'JSON 数据',
  'code-file': '代码文件',
};

const TYPE_EXTENSIONS: Record<string, string> = {
  'html-preview': 'html',
  mermaid: 'mmd',
  table: 'csv',
  'json-data': 'json',
  'code-file': 'txt',
};

export interface Artifact {
  id: string;
  type: string;
  title: string;
  source: string;
  size: number;
  truncated: boolean;
  scriptCount?: number;
  externalResourceCount?: number;
  security?: Record<string, string>;
  parsed?: unknown;
  format?: string;
  language?: string;
  ext?: string;
  messageIndex?: number;
  createdAt?: number;
}

export interface ExtractOptions {
  types?: string[];
  maxArtifacts?: number;
  maxSourceChars?: number;
}

/** Legacy entrypoint — extracts HTML artifacts only. */
export function extractHtmlArtifacts(markdown: string, options: ExtractOptions = {}): Artifact[] {
  return extractArtifacts(markdown, { ...options, types: ['html-preview'] });
}

/**
 * Unified artifact extractor.
 */
export function extractArtifacts(markdown: string, options: ExtractOptions = {}): Artifact[] {
  const source = String(markdown || '');
  const allowedTypes = new Set(
    Array.isArray(options.types) && options.types.length ? options.types : Object.keys(TYPE_LABELS)
  );
  const maxArtifacts = Number.isFinite(options.maxArtifacts) ? options.maxArtifacts! : MAX_ARTIFACTS;
  const maxSourceChars = Number.isFinite(options.maxSourceChars) ? options.maxSourceChars! : DEFAULT_MAX_SOURCE_CHARS;
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();

  // Scan code fences
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(source)) && artifacts.length < maxArtifacts) {
    const language = String(match[1] || '')
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
    const body = normalizeArtifactSource(match[2], maxSourceChars);
    if (!body.trim()) continue;
    const hash = hashArtifactSource(body);
    if (seen.has(hash)) continue;

    let artifact: Artifact | null = null;
    if (allowedTypes.has('html-preview') && HTML_ARTIFACT_LANGS.has(language)) {
      artifact = createHtmlArtifact(body, artifacts.length);
    } else if (allowedTypes.has('mermaid') && MERMAID_LANGS.has(language)) {
      artifact = createMermaidArtifact(body, artifacts.length);
    } else if (allowedTypes.has('table') && TABLE_LANGS.has(language)) {
      artifact = createTableArtifact(body, artifacts.length, language);
    } else if (allowedTypes.has('json-data') && JSON_LANGS.has(language)) {
      artifact = createJsonArtifact(body, artifacts.length);
    } else if (allowedTypes.has('code-file') && CODE_FILE_LANGS.has(language)) {
      artifact = createCodeFileArtifact(body, artifacts.length, language);
    }

    if (artifact) {
      seen.add(hash);
      artifacts.push(artifact);
    }
  }

  // Scan markdown tables outside code fences (only if we haven't hit the limit)
  if (allowedTypes.has('table') && artifacts.length < maxArtifacts) {
    const tableArtifacts = extractMarkdownTables(source, {
      maxArtifacts: maxArtifacts - artifacts.length,
      maxSourceChars,
      seen,
    });
    artifacts.push(...tableArtifacts);
  }

  // Fallback: full HTML document when no code blocks matched
  if (artifacts.length === 0 && allowedTypes.has('html-preview')) {
    const trimmed = source.trim();
    if (looksLikeFullHtmlDocument(trimmed)) {
      artifacts.push(createHtmlArtifact(normalizeArtifactSource(trimmed, maxSourceChars), 0));
    }
  }

  return artifacts;
}

export function createSandboxedHtmlDocument(source: string, options: { title?: string } = {}): string {
  const safeSource = String(source || '');
  const title = escapeHtml(options.title || 'DeepChat Artifact');
  const csp = [
    "default-src 'none'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const meta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  const baseStyle =
    '<style>html,body{margin:0;min-height:100%;background:#fff;color:#111;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}body{padding:16px;box-sizing:border-box;}*{box-sizing:border-box;}img,video,canvas,svg{max-width:100%;height:auto;}pre{white-space:pre-wrap;overflow:auto;}</style>';

  if (looksLikeFullHtmlDocument(safeSource)) {
    return insertIntoHead(safeSource, `${meta}<title>${title}</title>${baseStyle}`);
  }

  return `<!doctype html><html><head>${meta}<title>${title}</title>${baseStyle}</head><body>${safeSource}</body></html>`;
}

export function buildArtifactDownloadName(artifact: Artifact | null, index = 0): string {
  const suffix = Number.isInteger(index) && index > 0 ? `-${index + 1}` : '';
  const typeKey = artifact?.type || 'html-preview';
  const ext = artifact?.ext || TYPE_EXTENSIONS[typeKey] || 'txt';
  const title = String(artifact?.title || `${typeKey}-artifact`)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return `${title || typeKey}${suffix}.${ext}`;
}

export function getArtifactTypeLabel(type: string): string {
  return TYPE_LABELS[type] || 'Artifact';
}

/* ─── Helpers ─── */

function createHtmlArtifact(source: string, index: number): Artifact {
  const scriptCount = countPattern(source, /<script\b/gi);
  const externalResourceCount = countPattern(source, /\s(?:src|href)\s*=\s*["'](?:https?:)?\/\//gi);
  const truncated = source.length >= DEFAULT_MAX_SOURCE_CHARS;
  return {
    id: `html-${index}-${hashArtifactSource(source).slice(0, 8)}`,
    type: 'html-preview',
    title: index === 0 ? 'HTML 预览' : `HTML 预览 ${index + 1}`,
    source,
    size: source.length,
    scriptCount,
    externalResourceCount,
    truncated,
    security: {
      sandbox: 'iframe sandbox',
      scripts: 'disabled',
      csp: "script-src 'none'; connect-src 'none'",
    },
  };
}

function createMermaidArtifact(source: string, index: number): Artifact {
  const truncated = source.length >= DEFAULT_MAX_SOURCE_CHARS;
  return {
    id: `mermaid-${index}-${hashArtifactSource(source).slice(0, 8)}`,
    type: 'mermaid',
    title: index === 0 ? 'Mermaid 图表' : `Mermaid 图表 ${index + 1}`,
    source,
    size: source.length,
    truncated,
  };
}

function createTableArtifact(source: string, index: number, language: string): Artifact {
  const truncated = source.length >= DEFAULT_MAX_SOURCE_CHARS;
  return {
    id: `table-${index}-${hashArtifactSource(source).slice(0, 8)}`,
    type: 'table',
    title: index === 0 ? '表格' : `表格 ${index + 1}`,
    source,
    size: source.length,
    format: language === 'tsv' ? 'tsv' : 'csv',
    truncated,
  };
}

function createJsonArtifact(source: string, index: number): Artifact {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Not valid JSON — still keep as JSON artifact if it looks JSON-ish
  }
  const truncated = source.length >= DEFAULT_MAX_SOURCE_CHARS;
  return {
    id: `json-${index}-${hashArtifactSource(source).slice(0, 8)}`,
    type: 'json-data',
    title: index === 0 ? 'JSON 数据' : `JSON 数据 ${index + 1}`,
    source,
    size: source.length,
    parsed,
    truncated,
  };
}

function createCodeFileArtifact(source: string, index: number, language: string): Artifact {
  const extMap: Record<string, string> = {
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    'c++': 'cpp',
    csharp: 'cs',
    golang: 'go',
    ruby: 'rb',
    kotlin: 'kt',
    yaml: 'yml',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    graphql: 'graphql',
    powershell: 'ps1',
  };
  const ext = extMap[language] || language;
  const truncated = source.length >= DEFAULT_MAX_SOURCE_CHARS;
  return {
    id: `code-${index}-${hashArtifactSource(source).slice(0, 8)}`,
    type: 'code-file',
    title: index === 0 ? `代码 (${ext})` : `代码 (${ext}) ${index + 1}`,
    source,
    size: source.length,
    language,
    ext,
    truncated,
  };
}

interface TableExtractOptions {
  maxArtifacts?: number;
  maxSourceChars?: number;
  seen?: Set<string>;
}

function extractMarkdownTables(source: string, options: TableExtractOptions): Artifact[] {
  const maxArtifacts = options.maxArtifacts || 4;
  const maxSourceChars = options.maxSourceChars || DEFAULT_MAX_SOURCE_CHARS;
  const seen = options.seen || new Set<string>();
  const artifacts: Artifact[] = [];

  // Match markdown tables: rows starting with | and containing |
  const tablePattern = /(?:^|\n)((?:\s*\|[^\n]*\|\s*\n)+)/g;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(source)) && artifacts.length < maxArtifacts) {
    const body = normalizeArtifactSource(match[1], maxSourceChars);
    if (!body.trim()) continue;
    const hash = hashArtifactSource(body);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const index = artifacts.length;
    artifacts.push({
      id: `table-md-${index}-${hash.slice(0, 8)}`,
      type: 'table',
      title: index === 0 ? 'Markdown 表格' : `Markdown 表格 ${index + 1}`,
      source: body,
      size: body.length,
      format: 'markdown',
      truncated: body.length >= DEFAULT_MAX_SOURCE_CHARS,
    });
  }
  return artifacts;
}

function normalizeArtifactSource(source: string, maxSourceChars: number): string {
  const text = String(source || '').trim();
  if (text.length <= maxSourceChars) return text;
  return `${text.slice(0, maxSourceChars)}\n<!-- DeepChat: artifact source truncated for safe preview -->`;
}

function looksLikeFullHtmlDocument(source: string): boolean {
  return /^<!doctype\s+html\b/i.test(source) || /^<html[\s>]/i.test(source);
}

function insertIntoHead(source: string, insertion: string): string {
  if (/<head[\s>]/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1>${insertion}`);
  }
  return source.replace(/<html([^>]*)>/i, `<html$1><head>${insertion}</head>`);
}

function countPattern(source: string, pattern: RegExp): number {
  return (String(source || '').match(pattern) || []).length;
}

function hashArtifactSource(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
