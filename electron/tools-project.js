// @ts-nocheck
const fs = require('fs/promises');
const path = require('path');
const { resolveWorkspaceRoot } = require('./tools-path');

const MAX_TOOL_OUTPUT = 12000;
const PROJECT_MAP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'release']);
const DEFAULT_MAX_NODES = 800;
const DEFAULT_MAX_ENTRIES_PER_DIR = 200;

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function projectMap(args, settings) {
  const root = await resolveWorkspaceRoot(args.path, settings.workspaceRoots || []);
  const maxDepth = clampInt(args.maxDepth, 1, 10, 4);
  const maxNodes = clampInt(args.maxNodes, 10, 5000, DEFAULT_MAX_NODES);
  const maxEntriesPerDir = clampInt(args.maxEntriesPerDir, 10, 2000, DEFAULT_MAX_ENTRIES_PER_DIR);
  const lines = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let nodeCount = 0;
  let truncated = false;

  async function walkMap(current, depth, prefix) {
    if (depth > maxDepth) return;
    if (nodeCount >= maxNodes) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const visibleEntries = entries.slice(0, maxEntriesPerDir);
    const hasMore = entries.length > maxEntriesPerDir;
    for (const entry of visibleEntries) {
      if (nodeCount >= maxNodes) {
        truncated = true;
        return;
      }
      if (PROJECT_MAP_EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        totalDirs += 1;
        nodeCount += 1;
        const dirPath = path.join(current, entry.name);
        let fileCount = 0;
        try {
          const inner = await fs.readdir(dirPath);
          fileCount = inner.length;
        } catch {}
        const connector = depth < maxDepth ? '├── ' : '└── ';
        lines.push(`${prefix}${connector}${entry.name}/ (${fileCount} items)`);
        if (depth < maxDepth) {
          await walkMap(dirPath, depth + 1, prefix + '│   ');
        }
      } else if (entry.isFile()) {
        totalFiles += 1;
        nodeCount += 1;
        lines.push(`${prefix}├── ${entry.name}`);
      }
    }
    if (hasMore) {
      lines.push(`${prefix}├── ... (${entries.length - maxEntriesPerDir} more entries)`);
    }
  }

  const rootName = path.basename(root) || root;
  lines.push(`${rootName}/`);
  await walkMap(root, 1, '');
  const metaLines = [
    `项目结构：${root}`,
    `最大深度：${maxDepth}`,
    `节点上限：${maxNodes}${truncated ? '（已触发截断）' : ''}`,
    `单目录上限：${maxEntriesPerDir}`,
    `排除目录：${[...PROJECT_MAP_EXCLUDED_DIRS].join(', ')}`,
    `目录数：${totalDirs}，文件数：${totalFiles}`,
  ];
  if (truncated) {
    metaLines.push('提示：结果已截断，建议缩小目录范围、提高 maxDepth 或增大 maxNodes');
  }
  return [
    ...metaLines,
    '',
    ...lines,
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

module.exports = {
  projectMap,
};
