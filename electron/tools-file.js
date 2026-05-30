// @ts-nocheck
const fs = require('fs/promises');
const fsSync = require('fs');
const readline = require('readline');
const path = require('path');
const {
  resolveWorkspaceRoot,
  resolveAllowedPath,
  resolveAllowedDirectory,
  isSensitivePath,
  isProbablyBinary,
} = require('./tools-path');
const { redactSensitiveText } = require('./tools-run-code');

const MAX_TOOL_OUTPUT = 12000;
const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_READ_MANY_FILES_BYTES = 500 * 1024;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function listFiles(args, settings) {
  const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
  const directory = String(args.directory || '').trim();
  const scanRoot = directory ? await resolveAllowedDirectory(directory, [root]) : root;
  const realRoot = await fs.realpath(root).catch(() => root);
  const pattern = String(args.pattern || '').trim();
  const matcher = createMatcher(pattern);
  const recentDays = clampInt(args.recent_days, 0, 3650, 0);
  const sortBy = String(args.sort_by || '')
    .trim()
    .toLowerCase();
  const sortByModified = sortBy === 'modified' || recentDays > 0;
  const cutoff = recentDays > 0 ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : 0;
  const files = [];
  await walk(scanRoot, scanRoot, files, matcher);
  const matchedFiles = files
    .filter((file) => cutoff <= 0 || file.mtimeMs >= cutoff)
    .sort((a, b) =>
      sortByModified ? b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path) : a.path.localeCompare(b.path)
    );
  const relativeDirectory = path.relative(realRoot, scanRoot) || '.';
  if (matchedFiles.length === 0) return `工作区 ${root} 的目录 ${relativeDirectory} 中没有找到匹配文件。`;
  return [
    `工作区：${root}`,
    `目录：${relativeDirectory}`,
    recentDays > 0 ? `筛选：最近 ${recentDays} 天修改` : '',
    `排序：${sortByModified ? '修改时间倒序' : '文件名'}`,
    `匹配文件数：${matchedFiles.length}`,
    '',
    ...matchedFiles.slice(0, 200).map((file) => formatListedFile(file, sortByModified)),
    matchedFiles.length > 200 ? `\n仅显示前 200 个结果。` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

async function readFile(args, settings) {
  const citation = parsePathLineCitation(args.path);
  const requestedPath = citation.path || args.path;
  const filePath = await resolveAllowedPath(requestedPath, settings.workspaceRoots || []);
  if (isSensitivePath(filePath)) throw new Error('该文件路径看起来包含密钥、凭证或敏感配置，已拒绝读取。');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('只能读取文件，不能读取目录。');

  const explicitStart = clampInt(args.start_line, 1, Number.MAX_SAFE_INTEGER, 0);
  const explicitEnd = clampInt(args.end_line, 1, Number.MAX_SAFE_INTEGER, 0);
  const lineRange = normalizeLineRange(explicitStart || citation.startLine, explicitEnd || citation.endLine);

  if (lineRange) {
    // Stream large files line-by-line using readline to avoid reading the whole file into buffer
    const start = Math.max(1, lineRange.start - 20);
    const end = lineRange.end + 20;

    const fileStream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let currentLine = 0;
    const lines = [];
    let isBinary = false;
    let sampleBuffer = Buffer.alloc(0);

    try {
      for await (const line of rl) {
        currentLine++;
        if (currentLine <= 10) {
          sampleBuffer = Buffer.concat([sampleBuffer, Buffer.from(line)]);
        }
        if (currentLine === 10) {
          if (isProbablyBinary(sampleBuffer)) {
            isBinary = true;
            rl.close();
            break;
          }
        }

        if (currentLine >= start && currentLine <= end) {
          lines.push(`${currentLine}: ${redactSensitiveText(line)}`);
        }
        if (currentLine > end) {
          rl.close();
          break;
        }
      }
    } finally {
      fileStream.destroy();
    }

    if (isBinary) throw new Error('该文件看起来是二进制文件，已拒绝读取。');

    const rangeText =
      lineRange.start === lineRange.end ? String(lineRange.start) : `${lineRange.start}-${lineRange.end}`;
    const formattedLines = lines.length > 0 ? lines : [`请求的行范围 ${lineRange.start}-${lineRange.end} 不在文件内。`];
    return [
      `文件：${filePath}`,
      `大小：${stat.size} bytes`,
      `行范围：${rangeText}（仅读取 ${start}-${Math.min(currentLine, end)}，包含前后 20 行上下文）`,
      '',
      ...formattedLines,
    ]
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  } else {
    // Fallback: read standard max_bytes header buffer
    const maxBytes = clampInt(args.max_bytes, 1024, MAX_FILE_BYTES, DEFAULT_FILE_BYTES);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, 0);
      if (isProbablyBinary(buffer)) throw new Error('该文件看起来是二进制文件，已拒绝读取。');
      const text = redactSensitiveText(buffer.toString('utf8'));
      const truncated = stat.size > maxBytes;
      return [
        `文件：${filePath}`,
        `大小：${stat.size} bytes${truncated ? `（仅读取前 ${maxBytes} bytes）` : ''}`,
        '',
        text,
      ]
        .join('\n')
        .slice(0, MAX_TOOL_OUTPUT);
    } finally {
      await handle.close();
    }
  }
}

async function readManyFiles(args, settings) {
  const paths_ = Array.isArray(args.paths) ? args.paths : [];
  if (paths_.length === 0) throw new Error('文件路径列表不能为空。');
  if (paths_.length > 50) throw new Error('单次最多读取 50 个文件。');
  const maxTotalBytes = clampInt(args.maxTotalBytes, 1024, MAX_READ_MANY_FILES_BYTES, MAX_READ_MANY_FILES_BYTES);
  const results = [];
  let totalBytesRead = 0;

  for (const rawPath of paths_) {
    const label = String(rawPath || '').trim();
    if (!label) continue;
    try {
      const filePath = await resolveAllowedPath(label, settings.workspaceRoots || []);
      if (isSensitivePath(filePath)) {
        results.push({ path: label, error: '该文件路径看起来包含敏感信息，已拒绝读取。' });
        continue;
      }
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        results.push({ path: label, error: '不是文件，已跳过。' });
        continue;
      }
      const remainingBytes = maxTotalBytes - totalBytesRead;
      if (remainingBytes <= 0) {
        results.push({ path: label, error: '已达到总字节数上限，跳过剩余文件。' });
        continue;
      }
      const bytesToRead = Math.min(stat.size, remainingBytes);
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        await handle.read(buffer, 0, bytesToRead, 0);
        if (isProbablyBinary(buffer)) {
          results.push({ path: label, error: '该文件看起来是二进制文件，已跳过。' });
          continue;
        }
        const text = redactSensitiveText(buffer.toString('utf8'));
        totalBytesRead += Buffer.byteLength(text, 'utf8');
        results.push({
          path: label,
          size: stat.size,
          bytesRead: bytesToRead,
          truncated: stat.size > bytesToRead,
          content: text,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      results.push({ path: label, error: error?.message || String(error) });
    }
  }

  const outputLines = [
    `批量文件读取`,
    `文件数：${results.length}/${paths_.length}`,
    `总读取字节：${totalBytesRead}/${maxTotalBytes}`,
    '',
  ];
  for (const result of results) {
    outputLines.push(`${'='.repeat(60)}`);
    outputLines.push(`文件：${result.path}`);
    if (result.error) {
      outputLines.push(`错误：${result.error}`);
    } else {
      outputLines.push(`大小：${result.size} bytes${result.truncated ? `（仅读取前 ${result.bytesRead} bytes）` : ''}`);
      outputLines.push('');
      outputLines.push(result.content);
    }
    outputLines.push('');
  }
  return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

async function walk(root, current, files, matcher, maxFiles = 220) {
  if (files.length >= maxFiles) return;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files, matcher, maxFiles);
    } else if (entry.isFile() && matcher(relative)) {
      const stat = await fs.stat(fullPath).catch(() => null);
      files.push({
        path: relative,
        fullPath,
        size: stat?.size || 0,
        mtimeMs: stat?.mtimeMs || 0,
      });
    }
  }
}

function formatListedFile(file, includeMeta = false) {
  if (!includeMeta) return `- ${file.path}`;
  return `- ${file.path} (mtime ${formatMtime(file.mtimeMs)}, ${file.size} bytes)`;
}

function formatMtime(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function parsePathLineCitation(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: raw, startLine: 0, endLine: 0 };
  return {
    path: match[1],
    startLine: Number.parseInt(match[2], 10) || 0,
    endLine: Number.parseInt(match[3] || match[2], 10) || 0,
  };
}

function normalizeLineRange(startLine, endLine) {
  const start = Number.parseInt(startLine, 10);
  const end = Number.parseInt(endLine || startLine, 10);
  if (!Number.isFinite(start) || start <= 0) return null;
  const safeEnd = Number.isFinite(end) && end > 0 ? end : start;
  return {
    start: Math.min(start, safeEnd),
    end: Math.max(start, safeEnd),
  };
}

function formatLineRangeFileOutput(filePath, fileSize, maxBytes, text, truncated, range) {
  const lines = text.split(/\r?\n/);
  const cappedEnd = Math.min(lines.length, Math.min(range.end, range.start + 399));
  const selected = [];
  for (let lineNumber = range.start; lineNumber <= cappedEnd; lineNumber += 1) {
    selected.push(`${lineNumber}: ${lines[lineNumber - 1] ?? ''}`);
  }
  if (selected.length === 0) {
    selected.push(`请求的行范围 ${range.start}-${range.end} 不在已读取内容内。`);
  }
  const rangeText = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  const cappedText =
    selected.length > 0 && cappedEnd < range.end
      ? `（范围已限制到 ${range.start}-${cappedEnd}，单次最多读取 400 行）`
      : '';
  return [
    `文件：${filePath}`,
    `大小：${fileSize} bytes${truncated ? `（仅读取前 ${maxBytes} bytes）` : ''}`,
    `行范围：${rangeText}${cappedText}`,
    '',
    ...selected,
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

function shouldSkip(name) {
  return ['.git', 'node_modules', 'dist', 'release', 'build', '.cache'].includes(name);
}

function createMatcher(pattern) {
  if (!pattern) return () => true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(escaped, 'i');
    return (value) => regex.test(value);
  }
  const lower = pattern.toLowerCase();
  return (value) => value.toLowerCase().includes(lower);
}

module.exports = {
  listFiles,
  readFile,
  readManyFiles,
  walk,
  shouldSkip,
  createMatcher,
  formatListedFile,
  formatMtime,
  parsePathLineCitation,
  normalizeLineRange,
  formatLineRangeFileOutput,
};
