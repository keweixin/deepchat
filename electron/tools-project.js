// @ts-check
const fs = require('fs/promises');
const path = require('path');
const { resolveWorkspaceRoot } = require('./tools-path');

const MAX_TOOL_OUTPUT = 12000;
const PROJECT_MAP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'release']);

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function projectMap(args, settings) {
  const root = await resolveWorkspaceRoot(args.path, settings.workspaceRoots || []);
  const maxDepth = clampInt(args.maxDepth, 1, 10, 4);
  const lines = [];
  let totalFiles = 0;
  let totalDirs = 0;

  async function walkMap(current, depth, prefix) {
    if (depth > maxDepth) return;
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
    for (const entry of entries) {
      if (PROJECT_MAP_EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        totalDirs += 1;
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
        lines.push(`${prefix}├── ${entry.name}`);
      }
    }
  }

  const rootName = path.basename(root) || root;
  lines.push(`${rootName}/`);
  await walkMap(root, 1, '');
  return [
    `项目结构：${root}`,
    `最大深度：${maxDepth}`,
    `排除目录：${[...PROJECT_MAP_EXCLUDED_DIRS].join(', ')}`,
    `目录数：${totalDirs}，文件数：${totalFiles}`,
    '',
    ...lines,
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

module.exports = {
  projectMap,
};
