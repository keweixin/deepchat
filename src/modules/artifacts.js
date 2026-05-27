const HTML_ARTIFACT_LANGS = new Set(['html', 'htm']);
const MAX_ARTIFACTS = 4;
const DEFAULT_MAX_SOURCE_CHARS = 80_000;

export function extractHtmlArtifacts(markdown, options = {}) {
  const source = String(markdown || '');
  const maxArtifacts = Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : MAX_ARTIFACTS;
  const maxSourceChars = Number.isFinite(options.maxSourceChars) ? options.maxSourceChars : DEFAULT_MAX_SOURCE_CHARS;
  const artifacts = [];
  const seen = new Set();
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;

  while ((match = fencePattern.exec(source)) && artifacts.length < maxArtifacts) {
    const language = String(match[1] || '').trim().split(/\s+/)[0].toLowerCase();
    if (!HTML_ARTIFACT_LANGS.has(language)) continue;
    const html = normalizeArtifactSource(match[2], maxSourceChars);
    if (!html.trim()) continue;
    const hash = hashArtifactSource(html);
    if (seen.has(hash)) continue;
    seen.add(hash);
    artifacts.push(createHtmlArtifact(html, artifacts.length));
  }

  if (artifacts.length === 0) {
    const trimmed = source.trim();
    if (looksLikeFullHtmlDocument(trimmed)) {
      artifacts.push(createHtmlArtifact(normalizeArtifactSource(trimmed, maxSourceChars), 0));
    }
  }

  return artifacts;
}

export function createSandboxedHtmlDocument(source, options = {}) {
  const safeSource = String(source || '');
  const title = escapeHtml(options.title || 'DeepChat Artifact');
  const csp = [
    "default-src 'none'",
    "img-src data: https:",
    "media-src data: https:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const meta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  const baseStyle = '<style>html,body{margin:0;min-height:100%;background:#fff;color:#111;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}body{padding:16px;box-sizing:border-box;}*{box-sizing:border-box;}img,video,canvas,svg{max-width:100%;height:auto;}pre{white-space:pre-wrap;overflow:auto;}</style>';

  if (looksLikeFullHtmlDocument(safeSource)) {
    const withMeta = insertIntoHead(safeSource, `${meta}<title>${title}</title>${baseStyle}`);
    return withMeta;
  }

  return `<!doctype html><html><head>${meta}<title>${title}</title>${baseStyle}</head><body>${safeSource}</body></html>`;
}

export function buildArtifactDownloadName(artifact, index = 0) {
  const suffix = Number.isInteger(index) && index > 0 ? `-${index + 1}` : '';
  const title = String(artifact?.title || 'html-preview').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${title || 'html-preview'}${suffix}.html`;
}

function createHtmlArtifact(source, index) {
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

function normalizeArtifactSource(source, maxSourceChars) {
  const text = String(source || '').trim();
  if (text.length <= maxSourceChars) return text;
  return `${text.slice(0, maxSourceChars)}\n<!-- DeepChat: artifact source truncated for safe preview -->`;
}

function looksLikeFullHtmlDocument(source) {
  return /^<!doctype\s+html\b/i.test(source) || /^<html[\s>]/i.test(source);
}

function insertIntoHead(source, insertion) {
  if (/<head[\s>]/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1>${insertion}`);
  }
  return source.replace(/<html([^>]*)>/i, `<html$1><head>${insertion}</head>`);
}

function countPattern(source, pattern) {
  return (String(source || '').match(pattern) || []).length;
}

function hashArtifactSource(source) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
