// @ts-nocheck
/**
 * Workspace search query parser with advanced directive support.
 *
 * Supported directives:
 *   @file:path        — exact or partial file path match
 *   @folder:path      — directory scope filter
 *   @symbol:name      — symbol search
 *   @changed:Nd       — files modified within N days
 *   @recent           — recently modified files (last 7 days)
 */

const DIRECTIVE_PATTERN = /(?:^|[\s([，,;；])@(\w+)(?::([^\s@]+))?/gi;

export function parseWorkspaceQuery(query = '') {
  const text = String(query || '').trim();
  const directives = {
    file: [],
    folder: [],
    symbol: '',
    changedDays: null,
    recentOnly: false,
  };
  let cleaned = text;

  let match;
  while ((match = DIRECTIVE_PATTERN.exec(text)) !== null) {
    const key = match[1];
    const value = match[2];
    const full = match[0];

    switch (key.toLowerCase()) {
      case 'file':
        if (value) directives.file.push(value);
        break;
      case 'folder':
        if (value) directives.folder.push(value);
        break;
      case 'symbol':
        if (value) directives.symbol = value;
        break;
      case 'changed': {
        const days = Number.parseInt(value, 10);
        if (Number.isFinite(days) && days > 0) directives.changedDays = days;
        break;
      }
      case 'recent':
        directives.recentOnly = true;
        break;
      default:
        continue;
    }
    cleaned = cleaned.replace(full, ' ');
  }

  const textQuery = cleaned.replace(/\s+/g, ' ').trim();
  return { textQuery, ...directives };
}

export function matchesFileDirective(filePath, directives) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (directives.file.length > 0) {
    const fileLower = directives.file.map((f) => String(f).replace(/\\/g, '/').toLowerCase());
    if (!fileLower.some((f) => normalized === f || normalized.endsWith('/' + f) || normalized.includes(f))) {
      return false;
    }
  }
  if (directives.folder.length > 0) {
    const folderLower = directives.folder.map((f) => String(f).replace(/\\/g, '/').toLowerCase());
    if (!folderLower.some((f) => normalized.includes('/' + f + '/') || normalized.startsWith(f + '/'))) {
      return false;
    }
  }
  return true;
}

export function matchesChangedDirective(mtimeMs, directives) {
  const days = directives.changedDays ?? (directives.recentOnly ? 7 : null);
  if (days === null) return true;
  if (!mtimeMs) return false;
  const ageMs = Date.now() - Number(mtimeMs);
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
}

export function highlightWorkspaceSnippet(text, terms = [], queryLower = '', symbol = '') {
  const lines = String(text || '').split(/\r?\n/);
  const symbolPattern = symbol ? createSymbolPattern(symbol) : null;
  const highlighted = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || '';
    const lower = line.toLowerCase();
    let score = 0;
    if (symbolPattern && symbolPattern.test(line)) {
      score += 10;
      if (looksLikeSymbolDefinition(line, symbol)) score += 8;
    }
    if (queryLower && lower.includes(queryLower)) score += 5;
    for (const term of terms) {
      if (lower.includes(term)) score += 1;
    }
    if (score > 0) {
      highlighted.push({ line: index + 1, text: line, score });
    }
  }

  highlighted.sort((a, b) => b.score - a.score || a.line - b.line);
  return highlighted.slice(0, 6);
}

function createSymbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '[^\\p{L}\\p{N}_$.-]';
  return new RegExp(`(^|${boundary})${escaped}(?=$|${boundary})`, 'u');
}

function looksLikeSymbolDefinition(line, symbol) {
  const lower = line.toLowerCase();
  const symLower = symbol.toLowerCase();
  const defPatterns = [
    new RegExp(
      `\\b(?:function|class|const|let|var|def|async\\s+def|interface|type|enum|struct)\\s+${symLower}\\b`,
      'i'
    ),
    new RegExp(`\\b${symLower}\\s*[=:]\\s*(?:function|class|async|=>)`, 'i'),
    new RegExp(`\\b${symLower}\\s*\\(`, 'i'),
  ];
  return defPatterns.some((p) => p.test(lower));
}

export function buildHighlightedSnippet(lines, centerLine, radius = 2) {
  const result = [];
  const start = Math.max(0, centerLine - radius - 1);
  const end = Math.min(lines.length, centerLine + radius);
  for (let i = start; i < end; i++) {
    result.push({ line: i + 1, text: lines[i] || '' });
  }
  return result;
}
