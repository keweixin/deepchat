const fs = require('fs');
const path = require('path');

const MAX_DOCSET_ROOTS = 8;
const MAX_DOCSET_RESULTS = 8;
const MAX_DOCSET_SNIPPET = 900;

function normalizeDocsetRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const normalized = path.resolve(String(root || '').trim());
    if (!normalized) continue;
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= MAX_DOCSET_ROOTS) break;
  }
  return out;
}

function validateDocsetRoot(root) {
  const docsetRoot = path.resolve(String(root || '').trim());
  const dbPath = getDocsetDbPath(docsetRoot);
  const docsRoot = getDocsetDocsRoot(docsetRoot);
  if (!fs.existsSync(dbPath)) throw new Error(`不是有效 docset：缺少 ${path.relative(docsetRoot, dbPath)}`);
  if (!fs.existsSync(docsRoot)) throw new Error(`不是有效 docset：缺少 ${path.relative(docsetRoot, docsRoot)}`);
  return {
    root: docsetRoot,
    name: path.basename(docsetRoot).replace(/\.docset$/i, ''),
    dbPath,
    docsRoot,
  };
}

function listDocsets(settings = {}) {
  return normalizeDocsetRoots(settings.docsetRoots)
    .map((root) => {
      try {
        return { ...validateDocsetRoot(root), ok: true };
      } catch (error) {
        return {
          root: path.resolve(String(root || '')),
          name: path.basename(String(root || '')),
          ok: false,
          error: error.message,
        };
      }
    })
    .map((item) => ({
      root: item.root,
      name: item.name,
      ok: item.ok,
      entryCount: item.ok ? countDocsetEntries(item) : 0,
      error: item.error || '',
    }));
}

function searchDocsets(query, settings = {}, options = {}) {
  if (settings.docsetSearchEnabled === false) return { provider: 'local_docset', results: [], warnings: [] };
  const roots = normalizeDocsetRoots(settings.docsetRoots);
  const maxResults = clampInt(options.maxResults ?? settings.tavilyMaxResults, 1, MAX_DOCSET_RESULTS, 5);
  const results = [];
  const warnings = [];
  for (const root of roots) {
    if (results.length >= maxResults) break;
    try {
      const info = validateDocsetRoot(root);
      results.push(...searchOneDocset(info, query, maxResults - results.length));
    } catch (error) {
      warnings.push(`${path.basename(root)}：${error.message}`);
    }
  }
  return {
    provider: 'local_docset',
    query: String(query || ''),
    results: results.map((item, index) => ({ ...item, index: index + 1 })),
    warnings,
  };
}

function searchOneDocset(info, query, maxResults) {
  const db = openReadonlyDatabase(info.dbPath);
  try {
    const term = `%${escapeLike(String(query || '').trim())}%`;
    const rows = db.all(
      `SELECT name, type, path
         FROM searchIndex
         WHERE name LIKE ? ESCAPE '\\'
         ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, length(name), name
         LIMIT ?`,
      [term, String(query || '').trim(), maxResults]
    );
    return rows.map((row) => buildDocsetResult(info, row, query)).filter(Boolean);
  } finally {
    db.close();
  }
}

function buildDocsetResult(info, row, query) {
  const relativePath = String(row.path || '');
  const filePath = path.resolve(info.docsRoot, relativePath);
  if (!isPathInside(filePath, info.docsRoot)) throw new Error(`Docset 文档路径越界：${relativePath}`);
  const html = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  return {
    provider: 'local_docset',
    docset: info.name,
    title: String(row.name || relativePath).slice(0, 220),
    entryType: String(row.type || '').slice(0, 80),
    path: relativePath,
    url: `docset://${encodeURIComponent(info.name)}/${relativePath.replace(/\\/g, '/')}`,
    content: buildSnippet(html, query),
  };
}

function countDocsetEntries(info) {
  try {
    const db = openReadonlyDatabase(info.dbPath);
    try {
      const rows = db.all('SELECT count(*) AS count FROM searchIndex', []);
      return Number(rows[0]?.count || 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function openReadonlyDatabase(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return {
      all(sql, params) {
        return db.prepare(sql).all(...params);
      },
      close() {
        db.close();
      },
    };
  } catch (primaryError) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      return {
        all(sql, params) {
          return db.prepare(sql).all(...params);
        },
        close() {
          db.close();
        },
      };
    } catch {
      throw primaryError;
    }
  }
}

function formatDocsetSearchResults(payload, fallbackReason = '') {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const structured = {
    type: 'deepchat.webSearchPlanResults',
    version: 2,
    provider: 'local_docset',
    fallbackReason,
    telemetry: {
      provider: 'local_docset',
      cache: { hits: 0, misses: 0 },
      warnings: payload?.warnings || [],
    },
    queries: [
      { index: 1, originalQuery: payload?.query || '', query: payload?.query || '', maxResults: results.length },
    ],
    results,
    extraction: null,
  };
  const lines = [
    `搜索时间：${new Date().toISOString().slice(0, 10)}`,
    `用户原始问题：${payload?.query || ''}`,
    `实际搜索 query：${payload?.query || ''}`,
    'Fallback provider：local_docset',
    fallbackReason ? `Fallback reason：${fallbackReason}` : '',
    ...(payload?.warnings || []).map((warning) => `Fallback warning：${warning}`),
    '',
    'Structured Search:',
    JSON.stringify(structured, null, 2),
    '',
    '离线 Docset 返回来源：',
  ].filter(Boolean);
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    lines.push(`   Provider: local_docset`);
    lines.push(`   Docset: ${item.docset}`);
    lines.push(`   URL: ${item.url}`);
    if (item.entryType) lines.push(`   Type: ${item.entryType}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  if (results.length === 0) lines.push('离线 Docset 没有命中结果。');
  return lines.join('\n');
}

function getDocsetDbPath(root) {
  return path.join(root, 'Contents', 'Resources', 'docSet.dsidx');
}

function getDocsetDocsRoot(root) {
  return path.join(root, 'Contents', 'Resources', 'Documents');
}

function buildSnippet(html, query) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  const start = index >= 0 ? Math.max(0, index - 240) : 0;
  return text.slice(start, start + MAX_DOCSET_SNIPPET);
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isPathInside(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

module.exports = {
  normalizeDocsetRoots,
  validateDocsetRoot,
  listDocsets,
  searchDocsets,
  formatDocsetSearchResults,
};
