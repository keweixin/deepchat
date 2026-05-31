import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { parseWorkspaceQuery, matchesFileDirective, matchesChangedDirective } from './workspace-query.js';
import { resolveWorkspaceRoot, resolveAllowedDirectory, isSensitivePath, isProbablyBinary } from './tools-path.js';
import { walk, createMatcher } from './tools-file.js';
import { redactSensitiveText } from './tools-run-code.js';
import * as indexMod from './workspace-index.ts';

const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_TOOL_OUTPUT = 12000;
const WORKSPACE_INDEX_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_INDEX_DISK_TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_INDEX_DISK_MAX_BYTES = 8 * 1024 * 1024;
const WORKSPACE_INDEX_DISK_VERSION = 1;
const WORKSPACE_INDEX_CACHE_MAX = 8;

/** @type {import('./workspace-index')} */
let workspaceIndexModule = indexMod;
function getWorkspaceIndexModule() {
  return workspaceIndexModule;
}

const workspaceIndexCache = new Map();

async function indexWorkspace(args, settings) {
  const index = await getWorkspaceIndex(args, settings, {
    forceRefresh: Boolean(args.force_refresh),
    maxFiles: clampInt(args.max_files, 1, MAX_SEARCH_SCAN_FILES, MAX_SEARCH_SCAN_FILES),
  });
  return formatWorkspaceIndexOutput(index);
}

async function searchWorkspace(args, settings) {
  const rawQuery = String(args.query || args.symbol || '').trim();
  if (!rawQuery) throw new Error('搜索关键词不能为空。');

  const parsed = parseWorkspaceQuery(rawQuery);
  const symbol = normalizeSearchSymbol(args.symbol || parsed.symbol);
  const query = parsed.textQuery || symbol;
  const maxResults = clampInt(args.max_results, 1, 20, 8);

  // --- SQLite FTS5 fast path ---
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
      const directory = String(args.directory || '').trim();
      let resolvedRoot = root;
      if (directory) {
        const resolved = await resolveAllowedDirectory(directory, [root]);
        resolvedRoot = resolved;
      } else {
        resolvedRoot = root;
      }
      const pattern = String(args.pattern || '').trim();
      const directiveSummary = buildDirectiveSummary(parsed);

      const searchQuery = symbol || query;
      const ftsResults = indexMod.searchWorkspace(searchQuery, {
        root: resolvedRoot,
        pattern: pattern || undefined,
        limit: maxResults,
      });

      if (ftsResults.length > 0) {
        const structured = {
          type: 'deepchat.workspaceSearchResults',
          version: 1,
          query,
          symbol: symbol || '',
          root: resolvedRoot,
          directory: directory || '.',
          pattern: pattern || '',
          index: {
            cache: 'sqlite-fts5',
            fileCount: indexMod.getWorkspaceStats().fileCount,
            chunkCount: indexMod.getWorkspaceStats().chunkCount,
            snapshotHash: '',
            hash: '',
          },
          results: ftsResults.map((hit, i) => ({
            index: i + 1,
            file: path.join((hit as any).workspaceRoot, hit.file).replace(/\\/g, '/'),
            startLine: hit.lineStart,
            endLine: hit.lineEnd,
            score: hit.score,
            scoreBreakdown: { content: hit.score },
            matchReasons: ['content'],
            kind: inferWorkspaceHitKind({ snippet: hit.snippet }, symbol),
            symbol: symbol || inferWorkspaceHitSymbol({ snippet: hit.snippet }),
            truncated: false,
            snippet: hit.snippet,
          })),
        };

        const lines = [
          `工作区搜索：${rawQuery}`,
          directiveSummary,
          symbol ? `符号：${symbol}` : '',
          `工作区：${resolvedRoot}`,
          directory ? `目录：${directory}` : '',
          pattern ? `文件筛选：${pattern}` : '',
          `索引：sqlite-fts5 · files=${structured.index.fileCount} · chunks=${structured.index.chunkCount}`,
          `结果数：${ftsResults.length}`,
          'Structured Results:',
          JSON.stringify(structured, null, 2),
          '',
        ].filter(Boolean);

        ftsResults.forEach((hit, i) => {
          const absPath = path.join((hit as any).workspaceRoot, hit.file).replace(/\\/g, '/');
          lines.push(`${i + 1}. ${absPath}:${hit.lineStart}-${hit.lineEnd}`);
          lines.push(`   score: ${hit.score.toFixed(2)}`);
          lines.push('   摘录:');
          for (const s of hit.snippet) {
            lines.push(`   ${s.line}: ${s.text}`);
          }
          lines.push('');
        });
        return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
      }
    } catch {
      // SQLite FTS5 not available; fall back to legacy path
    }
  }

  // --- Legacy in-memory search path ---
  const index = await getWorkspaceIndex(args, settings);

  // Apply directive filters
  const filteredFiles = index.files.filter((file) => {
    if (!matchesFileDirective(file.path, parsed)) return false;
    if (!matchesChangedDirective(file.mtimeMs, parsed)) return false;
    return true;
  });

  const terms = tokenizeSearchQuery(query);
  const queryLower = query.toLowerCase();
  const hits = [];
  for (const file of filteredFiles) {
    if (hits.length >= maxResults * 4) break;
    const fileRelevance = scoreWorkspaceFileRelevance(file, query, terms, symbol);
    const fileHits = findTextHits(file.text, terms, queryLower, symbol, 2);
    if (fileHits.length === 0 && hasFileIdentityMatch(fileRelevance)) {
      hits.push({
        ...buildFileNameWorkspaceHit(file),
        file: file.path,
        size: file.size || 0,
        truncated: (file.size || 0) > MAX_SEARCH_FILE_BYTES,
        fileRelevance,
      });
      continue;
    }
    for (const hit of fileHits) {
      hits.push({
        ...hit,
        file: file.path,
        size: file.size || 0,
        truncated: (file.size || 0) > MAX_SEARCH_FILE_BYTES,
        fileRelevance,
      });
      if (hits.length >= maxResults * 4) break;
    }
  }

  const rankedHits = hits.map((hit) => scoreWorkspaceHit(hit));
  rankedHits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.lineStart - b.lineStart);
  const selected = rankedHits.slice(0, maxResults);

  const directiveSummary = buildDirectiveSummary(parsed);
  if (selected.length === 0) {
    const structured = buildWorkspaceSearchStructuredResults({ query, symbol, index, selected });
    return [
      `工作区搜索：${rawQuery}`,
      directiveSummary,
      `工作区：${index.root}`,
      `目录：${index.relativeDirectory}`,
      index.pattern ? `文件筛选：${index.pattern}` : '',
      `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
      'Structured Results:',
      JSON.stringify(structured, null, 2),
      '没有找到匹配的文本结果。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const structured = buildWorkspaceSearchStructuredResults({ query, symbol, index, selected });
  const lines = [
    `工作区搜索：${rawQuery}`,
    directiveSummary,
    symbol ? `符号：${symbol}` : '',
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
    `结果数：${selected.length}`,
    'Structured Results:',
    JSON.stringify(structured, null, 2),
    '',
  ].filter(Boolean);
  selected.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.file}:${hit.lineStart}-${hit.lineEnd}`);
    lines.push(`   score: ${hit.score}`);
    if (hit.truncated) lines.push(`   说明：文件超过 ${MAX_SEARCH_FILE_BYTES} bytes，仅搜索开头片段。`);
    lines.push('   摘录:');
    for (const item of hit.snippet) {
      lines.push(`   ${item.line}: ${item.text}`);
    }
    lines.push('');
  });
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function buildDirectiveSummary(parsed) {
  const parts = [];
  if (parsed.file.length) parts.push(`文件过滤：${parsed.file.join(', ')}`);
  if (parsed.folder.length) parts.push(`目录过滤：${parsed.folder.join(', ')}`);
  if (parsed.symbol) parts.push(`符号：${parsed.symbol}`);
  if (parsed.changedDays !== null) parts.push(`最近 ${parsed.changedDays} 天修改`);
  if (parsed.recentOnly) parts.push('最近修改');
  return parts.length ? `筛选：${parts.join(' · ')}` : '';
}

function buildWorkspaceSearchStructuredResults({ query, symbol, index, selected }) {
  return {
    type: 'deepchat.workspaceSearchResults',
    version: 1,
    query,
    symbol: symbol || '',
    root: index.root,
    directory: index.relativeDirectory,
    pattern: index.pattern || '',
    index: {
      cache: formatWorkspaceIndexCacheLabel(index),
      fileCount: index.fileCount,
      chunkCount: index.chunkCount,
      snapshotHash: index.snapshotHash || '',
      hash: index.hash,
    },
    results: selected.map((hit, resultIndex) => ({
      index: resultIndex + 1,
      file: normalizeWorkspaceResultPath(hit.file),
      startLine: hit.lineStart,
      endLine: hit.lineEnd,
      score: hit.score,
      scoreBreakdown: hit.scoreBreakdown || {},
      matchReasons: hit.matchReasons || [],
      kind: inferWorkspaceHitKind(hit, symbol),
      symbol: symbol || inferWorkspaceHitSymbol(hit),
      truncated: Boolean(hit.truncated),
      snippet: hit.snippet.map((item) => ({
        line: item.line,
        text: item.text,
      })),
    })),
  };
}

async function readSymbol(args, settings) {
  const symbol = normalizeSearchSymbol(args.symbol);
  if (!symbol) throw new Error('符号名称不能为空，且只能包含字母、数字、_、$、. 或 -。');
  const contextLines = clampInt(args.context_lines, 0, 20, 3);
  const maxLines = clampInt(args.max_lines, 20, 240, 120);

  let matches = [];

  // --- SQLite FTS5 fast path ---
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
      const directory = String(args.directory || '').trim();
      let resolvedRoot = root;
      if (directory) resolvedRoot = await resolveAllowedDirectory(directory, [root]);
      const pattern = String(args.pattern || '').trim();

      const dbSymbols = indexMod.findSymbol(symbol, { root: resolvedRoot });
      const filtered = pattern
        ? dbSymbols.filter((s: any) => path.join(s.workspaceRoot, s.file).replace(/\\/g, '/').includes(pattern))
        : dbSymbols;

      if (filtered.length > 0) {
        for (const sym of filtered) {
          const contentLines = [];
          for (const ctx of sym.context) {
            const lines = ctx.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              contentLines.push({ line: ctx.lineStart + i, text: lines[i] });
            }
          }
          const symLine = contentLines.findIndex((l) => l.line === sym.line);
          const startIdx = Math.max(0, symLine - contextLines);
          const uncappedEndIdx = Math.min(contentLines.length - 1, symLine + 1 + contextLines);
          const endIdx = Math.min(uncappedEndIdx, startIdx + maxLines - 1);
          const snippet = contentLines.slice(startIdx, endIdx + 1);

          matches.push({
            file: path.join((sym as any).workspaceRoot, sym.file).replace(/\\/g, '/'),
            startLine: startIdx + 1,
            endLine: endIdx + 1,
            definitionLine: sym.line,
            score: 20,
            kind: sym.kind === 'export' ? 'function' : sym.kind,
            signature: (contentLines[symLine]?.text || '').trim().slice(0, 240),
            truncated: uncappedEndIdx > endIdx,
            snippet,
          });
        }
      }
    } catch {
      // SQLite not available; fall back to legacy path
    }
  }

  // --- Legacy fallback ---
  if (matches.length === 0) {
    const index = await getWorkspaceIndex({ ...args, symbol, query: symbol }, settings);
    for (const file of index.files) {
      const symbolHits = findSymbolDefinitionHits(file, symbol, { contextLines, maxLines });
      for (const hit of symbolHits) matches.push(hit);
    }
  }

  const index =
    matches.length > 0
      ? {
          root: settings.workspaceRoots?.[0] || '',
          relativeDirectory: String(args.directory || '.'),
          pattern: String(args.pattern || ''),
          fileCount: 0,
          chunkCount: 0,
          snapshotHash: '',
          hash: '',
          fromCache: false,
          cacheLayer: '',
          builtAtMs: 0,
        }
      : await getWorkspaceIndex({ ...args, symbol, query: symbol }, settings);

  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.startLine - b.startLine);
  const selected = matches[0] || null;
  const structured = buildWorkspaceSymbolStructuredResult({
    symbol,
    index,
    selected,
    alternatives: matches.slice(1, 6),
  });

  if (!selected) {
    return [
      `符号读取：${symbol}`,
      `工作区：${index.root}`,
      `目录：${index.relativeDirectory}`,
      index.pattern ? `文件筛选：${index.pattern}` : '',
      `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
      'Structured Symbol:',
      JSON.stringify(structured, null, 2),
      `没有找到 ${symbol} 的明确符号定义。可先调用 search_workspace({ "symbol": "${symbol}" }) 查看引用。`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  }

  const lines = [
    `符号读取：${symbol}`,
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
    `结果：${selected.file}:${selected.startLine}-${selected.endLine}`,
    `类型：${selected.kind}`,
    selected.signature ? `签名：${selected.signature}` : '',
    'Structured Symbol:',
    JSON.stringify(structured, null, 2),
    '',
    '代码片段:',
    ...selected.snippet.map((item) => `${item.line}: ${item.text}`),
  ].filter(Boolean);
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function findSymbolDefinitionHits(file, symbol, options = {}) {
  const lines = String(file.text || '').split(/\r?\n/);
  const hits = [];
  const symbolPattern = createSymbolPattern(symbol);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || '';
    if (!symbolPattern.test(line) || !looksLikeSymbolDefinition(line, symbol)) continue;
    const definitionEnd = inferSymbolDefinitionEnd(lines, index);
    const contextLines = clampInt((options as any).contextLines, 0, 20, 3);
    const maxLines = clampInt((options as any).maxLines, 20, 240, 120);
    const startIndex = Math.max(0, index - contextLines);
    const uncappedEndIndex = Math.min(lines.length - 1, definitionEnd + contextLines);
    const endIndex = Math.min(uncappedEndIndex, startIndex + maxLines - 1);
    const snippet = [];
    for (let lineIndex = startIndex; lineIndex <= endIndex; lineIndex += 1) {
      snippet.push({ line: lineIndex + 1, text: truncateCodeLine(lines[lineIndex] || '') });
    }
    hits.push({
      file: file.path,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      definitionLine: index + 1,
      score: scoreSymbolDefinitionHit(file.path, line, symbol),
      kind: inferSymbolKind(line, symbol),
      signature: truncateLine(line),
      truncated: uncappedEndIndex > endIndex || Boolean(file.truncated),
      snippet,
    });
  }
  return hits;
}

function inferSymbolDefinitionEnd(lines, startIndex) {
  let braceDepth = 0;
  let sawBrace = false;
  for (let index = startIndex; index < lines.length; index++) {
    const line = stripLineComments(lines[index] || '');
    for (const char of line) {
      if (char === '{') {
        braceDepth += 1;
        sawBrace = true;
      } else if (char === '}') {
        braceDepth -= 1;
      }
    }
    if (sawBrace && braceDepth <= 0 && index > startIndex) return index;
    if (!sawBrace && index > startIndex && !String(lines[index] || '').trim()) return Math.max(startIndex, index - 1);
  }
  return Math.min(lines.length - 1, startIndex + 40);
}

function stripLineComments(line) {
  return String(line || '').replace(/\/\/.*$/, '');
}

function scoreSymbolDefinitionHit(filePath, line, symbol) {
  let score = 20;
  const fileName = path.basename(String(filePath || '')).toLowerCase();
  const symbolLower = String(symbol || '').toLowerCase();
  if (fileName.includes(symbolLower)) score += 3;
  if (/^\s*export\b/.test(line)) score += 2;
  if (/^\s*(export\s+)?(async\s+)?function\s+/u.test(line)) score += 2;
  if (/^\s*(export\s+)?class\s+/u.test(line)) score += 2;
  return score;
}

function inferSymbolKind(line, symbol) {
  const text = String(line || '');
  if (/^\s*(export\s+)?(async\s+)?function\s+/u.test(text)) return 'function';
  if (/^\s*(export\s+)?class\s+/u.test(text)) return 'class';
  if (/^\s*(export\s+)?(?:const|let|var)\s+/u.test(text)) return 'variable';
  if (new RegExp(`<${symbol}(?:\\s|>|/)`, 'u').test(text)) return 'component';
  if (new RegExp(`(?:async\s+)?${symbol}\s*\(`, 'u').test(text)) return 'method';
  return 'symbol';
}

function buildWorkspaceSymbolStructuredResult({ symbol, index, selected, alternatives = [] }) {
  return {
    type: 'deepchat.workspaceSymbolResult',
    version: 1,
    symbol,
    root: index.root,
    directory: index.relativeDirectory,
    pattern: index.pattern || '',
    index: {
      cache: formatWorkspaceIndexCacheLabel(index),
      fileCount: index.fileCount,
      chunkCount: index.chunkCount,
      snapshotHash: index.snapshotHash || '',
      hash: index.hash,
    },
    result: selected ? formatWorkspaceSymbolHit(selected) : null,
    alternatives: alternatives.map(formatWorkspaceSymbolHit),
  };
}

function formatWorkspaceSymbolHit(hit) {
  return {
    file: normalizeWorkspaceResultPath(hit.file),
    startLine: hit.startLine,
    endLine: hit.endLine,
    definitionLine: hit.definitionLine,
    score: hit.score,
    kind: hit.kind,
    signature: hit.signature || '',
    truncated: Boolean(hit.truncated),
    snippet: hit.snippet.map((item) => ({
      line: item.line,
      text: item.text,
    })),
  };
}

function normalizeWorkspaceResultPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function inferWorkspaceHitKind(hit, symbol = '') {
  const text = (hit?.snippet || []).map((item) => item.text).join('\n');
  if (symbol && text.split(/\r?\n/).some((line) => looksLikeSymbolDefinition(line, symbol))) return 'symbol';
  if (/^\s*(export\s+)?(async\s+)?function\s+/m.test(text)) return 'function';
  if (/^\s*(export\s+)?class\s+/m.test(text)) return 'class';
  if (/^\s*(export\s+)?(?:const|let|var)\s+/m.test(text)) return 'variable';
  if (/^\s*#{1,6}\s+/m.test(text)) return 'markdown-section';
  return 'text';
}

function inferWorkspaceHitSymbol(hit) {
  const text = (hit?.snippet || []).map((item) => item.text).join('\n');
  const match =
    text.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu) ||
    text.match(/^\s*(?:export\s+)?class\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu) ||
    text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu);
  return match?.[1] || '';
}

async function getWorkspaceIndex(args, settings, options = {}) {
  const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
  const directory = String(args.directory || '').trim();
  const scanRoot = directory ? await resolveAllowedDirectory(directory, [root]) : root;
  const realRoot = await fs.realpath(root).catch(() => root);
  const realScanRoot = await fs.realpath(scanRoot).catch(() => scanRoot);
  const pattern = String(args.pattern || '').trim();
  const maxFiles = clampInt(
    (options as any).maxFiles ?? args.max_files,
    1,
    MAX_SEARCH_SCAN_FILES,
    MAX_SEARCH_SCAN_FILES
  );
  const cacheKey = buildWorkspaceIndexCacheKey(realRoot, realScanRoot, pattern, maxFiles);
  const cached = workspaceIndexCache.get(cacheKey);
  const now = Date.now();
  if (!(options as any).forceRefresh && cached && now - cached.builtAtMs < WORKSPACE_INDEX_TTL_MS) {
    return {
      ...cached,
      fromCache: true,
      cacheLayer: 'memory',
      ageMs: now - cached.builtAtMs,
    };
  }

  const matcher = createMatcher(pattern);
  const rawFiles = [];
  await walk(realScanRoot, realScanRoot, rawFiles, matcher, maxFiles);
  const snapshot = buildWorkspaceSnapshot(rawFiles, realRoot);
  if (
    !(options as any).forceRefresh &&
    cached &&
    cached.snapshotHash === snapshot.hash &&
    now - cached.builtAtMs < WORKSPACE_INDEX_DISK_TTL_MS
  ) {
    return {
      ...cached,
      rawFileCount: rawFiles.length,
      snapshotFileCount: snapshot.fileCount,
      fromCache: true,
      cacheLayer: 'memory',
      ageMs: now - cached.builtAtMs,
    };
  }

  let incrementalCache = null;
  if (!(options as any).forceRefresh) {
    const diskIndex = await readWorkspaceIndexDiskCache(cacheKey, snapshot.hash, settings, now);
    if (diskIndex) {
      const restored = {
        ...diskIndex,
        rawFileCount: rawFiles.length,
        snapshotFileCount: snapshot.fileCount,
        fromCache: true,
        cacheLayer: 'disk',
        ageMs: now - diskIndex.builtAtMs,
      };
      rememberWorkspaceIndex(cacheKey, restored);
      return restored;
    }
    // Try incremental: load old cache even if snapshot changed
    incrementalCache = await readWorkspaceIndexDiskCacheRaw(cacheKey, settings);
  }

  const files = [];
  let skippedSensitive = 0;
  let skippedBinary = 0;
  let scannedBytes = 0;
  let chunkCount = 0;
  let reusedCount = 0;

  const oldFileMap = incrementalCache?.files ? new Map(incrementalCache.files.map((f) => [f.path, f])) : new Map();

  for (const file of rawFiles) {
    if (!file.fullPath) continue;
    if (isSensitivePath(file.fullPath)) {
      skippedSensitive += 1;
      continue;
    }
    const relPath = path.relative(realRoot, file.fullPath) || file.path;
    const oldFile = oldFileMap.get(relPath);
    // Attempt incremental reuse if path, size, and mtime match exactly
    if (
      oldFile &&
      oldFile.size === (file.size || 0) &&
      oldFile.mtimeMs === (file.mtimeMs || 0) &&
      oldFile.text &&
      oldFile.sha256
    ) {
      files.push({
        path: relPath,
        fullPath: file.fullPath,
        size: file.size || 0,
        mtimeMs: file.mtimeMs || 0,
        sha256: oldFile.sha256,
        lineCount: oldFile.lineCount,
        chunks: oldFile.chunks,
        text: oldFile.text,
      });
      chunkCount += oldFile.chunks;
      scannedBytes += Math.min(file.size || MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES);
      reusedCount += 1;
      continue;
    }
    const readResult = await readSearchableFile(
      file.fullPath,
      Math.min(file.size || MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES)
    );
    if (!readResult.text) {
      skippedBinary += 1;
      continue;
    }
    const lineCount = readResult.text.split(/\r?\n/).length;
    const chunks = Math.max(1, Math.ceil(lineCount / 80));
    chunkCount += chunks;
    scannedBytes += Math.min(file.size || Buffer.byteLength(readResult.text, 'utf8'), MAX_SEARCH_FILE_BYTES);
    files.push({
      path: relPath,
      fullPath: file.fullPath,
      size: file.size || 0,
      mtimeMs: file.mtimeMs || 0,
      sha256: readResult.sha256,
      lineCount,
      chunks,
      text: redactSensitiveText(readResult.text),
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const index = {
    cacheKey,
    root: realRoot,
    scanRoot: realScanRoot,
    relativeDirectory: path.relative(realRoot, realScanRoot) || '.',
    pattern,
    fileCount: files.length,
    rawFileCount: rawFiles.length,
    snapshotHash: snapshot.hash,
    snapshotFileCount: snapshot.fileCount,
    skippedSensitive,
    skippedBinary,
    scannedBytes,
    chunkCount,
    reusedCount,
    files,
    hash: buildWorkspaceIndexHash(files),
    builtAt: new Date(now).toISOString(),
    builtAtMs: now,
    ttlMs: WORKSPACE_INDEX_TTL_MS,
    fromCache: false,
    cacheLayer: reusedCount > 0 ? 'incremental' : 'new',
    ageMs: 0,
    diskCache: {
      enabled: Boolean(getWorkspaceIndexDiskDir(settings)),
      written: false,
    },
  };
  index.diskCache = await writeWorkspaceIndexDiskCache(cacheKey, index, settings);
  rememberWorkspaceIndex(cacheKey, index);
  return index;
}

function rememberWorkspaceIndex(cacheKey, index) {
  // Delete then re-insert to update LRU order
  if (workspaceIndexCache.has(cacheKey)) workspaceIndexCache.delete(cacheKey);
  workspaceIndexCache.set(cacheKey, index);
  while (workspaceIndexCache.size > WORKSPACE_INDEX_CACHE_MAX) {
    const firstKey = workspaceIndexCache.keys().next().value;
    if (firstKey === undefined) break;
    workspaceIndexCache.delete(firstKey);
  }
}

function clearWorkspaceIndexCache() {
  workspaceIndexCache.clear();
}

function buildWorkspaceIndexCacheKey(root, scanRoot, pattern, maxFiles) {
  return [root, scanRoot, pattern || '*', maxFiles].map((item) => String(item || '').toLowerCase()).join('\0');
}

function buildWorkspaceIndexHash(files = []) {
  const payload = files
    .map((file) => `${file.path}:${file.size}:${Math.round(file.mtimeMs || 0)}:${file.lineCount}`)
    .join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function buildWorkspaceSnapshot(rawFiles = [], realRoot = '') {
  const entries = rawFiles
    .filter((file) => file.fullPath && !isSensitivePath(file.fullPath))
    .map((file) =>
      [path.relative(realRoot, file.fullPath) || file.path, file.size || 0, Math.round(file.mtimeMs || 0)].join(':')
    )
    .sort();
  const payload = entries.join('\n');
  return {
    hash: crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16),
    fileCount: entries.length,
  };
}

function getWorkspaceIndexDiskDir(settings: any = {}) {
  const explicit = String(
    settings.workspaceIndexCacheDir || process.env.DEEPCHAT_WORKSPACE_INDEX_CACHE_DIR || ''
  ).trim();
  if (explicit) return explicit;
  const dataDir = String(settings.storageStatus?.dataDir || '').trim();
  return dataDir ? path.join(dataDir, 'workspace-indexes') : '';
}

function getWorkspaceIndexDiskPath(cacheKey, settings = {}) {
  const dir = getWorkspaceIndexDiskDir(settings);
  if (!dir) return '';
  const id = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
  return path.join(dir, `${id}.json`);
}

async function readWorkspaceIndexDiskCache(cacheKey, snapshotHash, settings = {}, now = Date.now()) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) return null;
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.version !== WORKSPACE_INDEX_DISK_VERSION) return null;
  if (payload.cacheKeyHash !== buildWorkspaceIndexCacheFileId(cacheKey)) return null;
  if (payload.snapshotHash !== snapshotHash) return null;
  const index = payload.index;
  if (!index || !Array.isArray(index.files) || !Number.isFinite(index.builtAtMs)) return null;
  if (now - index.builtAtMs > WORKSPACE_INDEX_DISK_TTL_MS) return null;
  return {
    ...index,
    cacheKey,
    snapshotHash,
    diskCache: {
      enabled: true,
      hit: true,
      path: filePath,
    },
  };
}

async function readWorkspaceIndexDiskCacheRaw(cacheKey, settings = {}) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) return null;
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.version !== WORKSPACE_INDEX_DISK_VERSION) return null;
  if (payload.cacheKeyHash !== buildWorkspaceIndexCacheFileId(cacheKey)) return null;
  const index = payload.index;
  if (!index || !Array.isArray(index.files) || !Number.isFinite(index.builtAtMs)) return null;
  return index;
}

async function writeWorkspaceIndexDiskCache(cacheKey, index, settings = {}) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) {
    return {
      enabled: false,
      written: false,
      reason: 'missing-data-dir',
    };
  }
  const payload = {
    version: WORKSPACE_INDEX_DISK_VERSION,
    cacheKeyHash: buildWorkspaceIndexCacheFileId(cacheKey),
    snapshotHash: index.snapshotHash,
    savedAt: new Date().toISOString(),
    index: serializeWorkspaceIndex(index),
  };
  const text = JSON.stringify(payload);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WORKSPACE_INDEX_DISK_MAX_BYTES) {
    return {
      enabled: true,
      written: false,
      reason: 'too-large',
      bytes,
      maxBytes: WORKSPACE_INDEX_DISK_MAX_BYTES,
      path: filePath,
    };
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, text, 'utf8');
    await fs.rename(tmpPath, filePath);
    return {
      enabled: true,
      written: true,
      bytes,
      path: filePath,
    };
  } catch (error) {
    return {
      enabled: true,
      written: false,
      reason: 'write-failed',
      error: error?.message || String(error),
      path: filePath,
    };
  }
}

async function clearWorkspaceIndexDiskCache(settings = {}) {
  clearWorkspaceIndexCache();
  // Also clear the SQLite FTS5 index
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      await indexMod.clearWorkspaceIndex();
    } catch {
      // best-effort
    }
  }
  const dir = getWorkspaceIndexDiskDir(settings);
  if (!dir) {
    return {
      ok: true,
      memoryCleared: true,
      diskEnabled: false,
      deletedFiles: 0,
      deletedBytes: 0,
    };
  }
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return {
      ok: true,
      memoryCleared: true,
      diskEnabled: true,
      deletedFiles: 0,
      deletedBytes: 0,
      cacheDir: dir,
    };
  }
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    await fs.rm(filePath, { force: true }).catch((err) => console.warn('[Tools] cache cleanup failed:', err.message));
    deletedFiles += 1;
    deletedBytes += stat?.size || 0;
  }
  return {
    ok: true,
    memoryCleared: true,
    diskEnabled: true,
    deletedFiles,
    deletedBytes,
    cacheDir: dir,
  };
}

function buildWorkspaceIndexCacheFileId(cacheKey) {
  return crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
}

function serializeWorkspaceIndex(index) {
  const { fromCache, ageMs, cacheLayer, diskCache, ...rest } = index;
  return {
    ...rest,
    files: (index.files || []).map((file) => {
      const { fullPath, ...safeFile } = file;
      return safeFile;
    }),
  };
}

function formatWorkspaceIndexOutput(index) {
  const files = index.files
    .slice(0, 80)
    .map((file) => `- ${file.path} (${file.lineCount} lines, ${file.size} bytes, chunks ${file.chunks})`);
  return [
    `工作区索引：${formatWorkspaceIndexCacheLabel(index)}`,
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引 hash：${index.hash}`,
    index.snapshotHash ? `快照 hash：${index.snapshotHash}` : '',
    `缓存策略：内存 ${formatDuration(WORKSPACE_INDEX_TTL_MS)} · 磁盘 ${formatDuration(WORKSPACE_INDEX_DISK_TTL_MS)}${index.fromCache ? ` · age ${formatDuration(index.ageMs)}` : ''}`,
    formatWorkspaceIndexDiskStatus(index.diskCache),
    `文件数：${index.fileCount}/${index.rawFileCount}`,
    `文本块：${index.chunkCount}`,
    `扫描字节：${index.scannedBytes}`,
    index.skippedSensitive ? `跳过敏感路径：${index.skippedSensitive}` : '',
    index.skippedBinary ? `跳过二进制/不可读：${index.skippedBinary}` : '',
    '',
    '索引文件：',
    ...files,
    index.files.length > files.length ? `... 仅显示前 ${files.length} 个文件` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

function formatWorkspaceIndexCacheLabel(index) {
  if (!index?.fromCache) return '新建';
  if (index.cacheLayer === 'disk') return '命中缓存（磁盘）';
  if (index.cacheLayer === 'memory') return '命中缓存（内存）';
  return '命中缓存';
}

function formatWorkspaceIndexDiskStatus(diskCache: any = {}) {
  if (!diskCache.enabled) return '磁盘缓存：未启用（缺少应用数据目录）';
  if (diskCache.hit) return '磁盘缓存：已命中';
  if (diskCache.written) return `磁盘缓存：已写入${diskCache.bytes ? `（${diskCache.bytes} bytes）` : ''}`;
  if (diskCache.reason === 'too-large') return `磁盘缓存：跳过写入（超过 ${diskCache.maxBytes} bytes）`;
  if (diskCache.reason === 'write-failed') return '磁盘缓存：写入失败';
  return '磁盘缓存：未写入';
}

async function readSearchableFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return { text: '', sha256: '' };
  try {
    const bytesToRead = Math.max(1, Math.min(maxBytes, MAX_SEARCH_FILE_BYTES));
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, result.bytesRead);
    if (isProbablyBinary(slice)) return { text: '', sha256: '' };
    const sha256 = crypto.createHash('sha256').update(slice).digest('hex').slice(0, 16);
    return { text: slice.toString('utf8'), sha256 };
  } finally {
    await handle.close().catch((err) => console.warn('[Tools] handle.close failed:', err.message));
  }
}

function tokenizeSearchQuery(query) {
  return [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.$/-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 8)
    ),
  ];
}

function normalizeSearchSymbol(value) {
  const symbol = String(value || '').trim();
  if (!symbol || symbol.length > 160) return '';
  return /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u.test(symbol) ? symbol : '';
}

function findTextHits(text, terms, queryLower, symbol = '', maxHits = 2) {
  const lines = String(text || '').split(/\r?\n/);
  const candidates = [];
  const symbolPattern = symbol ? createSymbolPattern(symbol) : null;
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
    if (score <= 0) continue;
    const lineStart = index + 1;
    const lineEnd = Math.min(lines.length, index + 2);
    const snippet = [];
    for (let i = lineStart - 1; i < lineEnd; i++) {
      snippet.push({ line: i + 1, text: truncateLine(lines[i] || '') });
    }
    candidates.push({ contentScore: score, score, lineStart, lineEnd, snippet });
  }
  candidates.sort((a, b) => b.score - a.score || a.lineStart - b.lineStart);
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((hit) => candidate.lineStart <= hit.lineEnd && candidate.lineEnd >= hit.lineStart);
    if (overlaps) continue;
    selected.push(candidate);
    if (selected.length >= maxHits) break;
  }
  return selected;
}

function buildFileNameWorkspaceHit(file) {
  const lines = String(file.text || '').split(/\r?\n/);
  const lineEnd = Math.min(lines.length || 1, 3);
  const snippet = [];
  for (let index = 0; index < lineEnd; index += 1) {
    snippet.push({ line: index + 1, text: truncateLine(lines[index] || '') });
  }
  return {
    contentScore: 0,
    score: 0,
    lineStart: 1,
    lineEnd,
    snippet,
  };
}

function scoreWorkspaceFileRelevance(file, query, terms = [], symbol = '') {
  const filePath = String(file?.path || '').replace(/\\/g, '/');
  const fileName = path.basename(filePath).toLowerCase();
  const pathLower = filePath.toLowerCase();
  const queryLower = String(query || '').toLowerCase();
  const symbolLower = String(symbol || '').toLowerCase();
  const reasons = [];
  let score = 0;

  if (queryLower && fileName.includes(queryLower)) {
    score += 80;
    reasons.push('file_name');
  }
  for (const term of terms) {
    if (!term) continue;
    if (fileName.includes(term)) {
      score += 25;
      if (!reasons.includes('file_name')) reasons.push('file_name');
    } else if (pathLower.includes(term)) {
      score += 8;
      if (!reasons.includes('path')) reasons.push('path');
    }
  }
  if (symbolLower && fileName.includes(symbolLower)) {
    score += 35;
    if (!reasons.includes('file_name')) reasons.push('file_name');
  }

  const ageDays = (Date.now() - Number(file?.mtimeMs || 0)) / (24 * 60 * 60 * 1000);
  let recency = 0;
  if (Number.isFinite(ageDays) && ageDays >= 0) {
    if (ageDays <= 7) recency = 6;
    else if (ageDays <= 30) recency = 3;
    else if (ageDays <= 180) recency = 1;
  }
  if (recency > 0) {
    score += recency;
    reasons.push('recent_modified');
  }

  return { score, recency, reasons };
}

function scoreWorkspaceHit(hit) {
  const contentScore = Number(hit.contentScore ?? hit.score ?? 0);
  const fileScore = Number(hit.fileRelevance?.score || 0);
  const symbolScore = inferWorkspaceHitKind(hit) === 'symbol' ? 50 : 0;
  const score = fileScore + symbolScore + contentScore;
  const matchReasons = [
    ...(hit.fileRelevance?.reasons || []),
    ...(symbolScore > 0 ? ['symbol_definition'] : []),
    ...(contentScore > 0 ? ['content'] : []),
  ];
  return {
    ...hit,
    score,
    scoreBreakdown: {
      file: fileScore,
      symbol: symbolScore,
      content: contentScore,
      recency: Number(hit.fileRelevance?.recency || 0),
    },
    matchReasons: [...new Set(matchReasons)],
  };
}

function hasFileIdentityMatch(fileRelevance: any = {}) {
  return (fileRelevance.reasons || []).some((reason) => reason === 'file_name' || reason === 'path');
}

function createSymbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '[^\\p{L}\\p{N}_$.-]';
  return new RegExp(`(^|${boundary})${escaped}(?=$|${boundary})`, 'u');
}

function looksLikeSymbolDefinition(line, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    `\\bfunction\\s+${escaped}\\b`,
    `\\bclass\\s+${escaped}\\b`,
    `\\b(?:const|let|var)\\s+${escaped}\\b`,
    `\\bexport\\s+(?:async\\s+)?function\\s+${escaped}\\b`,
    `\\b(?:async\\s+)?${escaped}\\s*\\(`,
    `<${escaped}(?:\\s|>|/)`,
  ];
  return patterns.some((pattern) => new RegExp(pattern, 'u').test(line));
}

function truncateLine(value) {
  const text = String(value || '').trim();
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function truncateCodeLine(value) {
  const text = String(value || '').replace(/\s+$/g, '');
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60 * 1000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60000)}m`;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export {
  indexWorkspace,
  searchWorkspace,
  readSymbol,
  getWorkspaceIndex,
  rememberWorkspaceIndex,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  getWorkspaceIndexModule,
};
