const { execFile } = require('child_process');
const { resolveWorkspaceRoot, isSensitivePath } = require('./tools-path');

const MAX_TOOL_OUTPUT = 12000;

/**
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * @param {any} value
 * @param {number} max
 * @returns {string}
 */
function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} 失败：${error.message}${stderr ? '\n' + truncate(stderr, 500) : ''}`));
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

/**
 * @param {string} indexStatus
 * @param {string} worktreeStatus
 * @returns {string}
 */
function mapGitStatus(indexStatus, worktreeStatus) {
  if (indexStatus === '?' && worktreeStatus === '?') return 'untracked';
  if (indexStatus === '!' && worktreeStatus === '!') return 'ignored';
  const combined = indexStatus + worktreeStatus;
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(combined)) return 'conflict';
  if (indexStatus === 'A') return 'added';
  if (indexStatus === 'D') return 'deleted';
  if (indexStatus === 'R') return 'renamed';
  if (indexStatus === 'C') return 'copied';
  if (indexStatus === 'M') return 'modified';
  if (worktreeStatus === 'M') return 'modified';
  if (worktreeStatus === 'D') return 'deleted';
  return 'unchanged';
}

/**
 * @param {{ path?: string }} args
 * @param {{ workspaceRoots?: string[] }} settings
 * @returns {Promise<string>}
 */
async function gitStatus(args, settings) {
  const root = await resolveWorkspaceRoot(args.path, settings.workspaceRoots || []);
  let branch = '';
  try {
    const branchResult = await execGit(root, ['branch', '--show-current']);
    branch = branchResult.stdout.trim();
  } catch {
    try {
      const headResult = await execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = headResult.stdout.trim();
    } catch {
      branch = 'unknown';
    }
  }
  const { stdout } = await execGit(root, ['status', '--porcelain=v1']);
  const statusLines = stdout.split(/\r?\n/).filter((line) => line.trim());
  const files = [];
  const summary = {
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
    copied: 0,
    conflict: 0,
    ignored: 0,
    unchanged: 0,
  };
  for (const line of statusLines) {
    if (line.length < 3) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    let filePath = line.slice(3).trim();
    if (indexStatus === 'R' || indexStatus === 'C') {
      const arrowIndex = filePath.indexOf(' -> ');
      if (arrowIndex !== -1) filePath = filePath.slice(arrowIndex + 4);
    }
    const status = mapGitStatus(indexStatus, worktreeStatus);
    files.push({ path: filePath, indexStatus, worktreeStatus, status });
    if (status in summary) /** @type {Record<string, number>} */ (summary)[status] += 1;
  }
  const structured = { type: 'deepchat.gitStatus', version: 1, root, branch, files, summary };
  const outputLines = [
    'Git 工作区状态',
    `工作区：${root}`,
    `分支：${branch || '(detached HEAD)'}`,
    `状态文件数：${files.length}`,
    'Structured Status:',
    JSON.stringify(structured, null, 2),
    '',
  ];
  if (files.length === 0) {
    outputLines.push('工作区干净，没有未提交的更改。');
  } else {
    outputLines.push('状态文件：');
    files.forEach((file, index) => {
      outputLines.push(`${index + 1}. [${file.indexStatus}${file.worktreeStatus}] ${file.path} (${file.status})`);
    });
  }
  return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

/**
 * @param {{ path?: string; file?: string; staged?: boolean }} args
 * @param {{ workspaceRoots?: string[] }} settings
 * @returns {Promise<string>}
 */
async function gitDiff(args, settings) {
  const root = await resolveWorkspaceRoot(args.path, settings.workspaceRoots || []);
  const file = String(args.file || '').trim();
  const staged = Boolean(args.staged);

  if (file) {
    // Return detailed diff only for the specified file
    const gitArgs = ['diff'];
    if (staged) gitArgs.push('--staged');
    gitArgs.push('--', file);
    const { stdout: diffOutput } = await execGit(root, gitArgs);
    const additionLines = (diffOutput.match(/^\+[^+]/gm) || []).length;
    const deletionLines = (diffOutput.match(/^-[^-]/gm) || []).length;
    const hunkCount = (diffOutput.match(/^@@/gm) || []).length;

    const structured = {
      type: 'deepchat.gitDiffFile',
      version: 1,
      root,
      staged,
      file,
      additions: additionLines,
      deletions: deletionLines,
      hunks: hunkCount,
      diff: truncate(diffOutput, 8000), // Prevent massive file diff overflows
    };

    const outputLines = [
      `Git 文件差异：${file}`,
      `工作区：${root}`,
      `模式：${staged ? '已暂存' : '未暂存'}`,
      `新增行：${additionLines} · 删除行：${deletionLines} · Hunks数：${hunkCount}`,
      'Structured Diff:',
      JSON.stringify(structured, null, 2),
      '',
    ];

    if (diffOutput.trim()) {
      outputLines.push('差异详情：');
      outputLines.push(structured.diff);
    } else {
      outputLines.push('该文件无未提交更改。');
    }
    return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
  } else {
    // Return a structured numstat summary of all changed files
    const gitArgs = ['diff', '--numstat'];
    if (staged) gitArgs.push('--staged');
    const { stdout: numstatOutput } = await execGit(root, gitArgs);

    const fullGitArgs = ['diff'];
    if (staged) fullGitArgs.push('--staged');
    const { stdout: fullDiffOutput } = await execGit(root, fullGitArgs);

    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    const numstatLines = numstatOutput.split(/\r?\n/).filter((l) => l.trim());

    for (const line of numstatLines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join(' ');

      // Count hunks in full diff output segment
      const fileDiffStart = fullDiffOutput.indexOf(`diff --git a/${filePath} b/${filePath}`);
      let hunks = 0;
      if (fileDiffStart !== -1) {
        let nextDiffStart = fullDiffOutput.indexOf('diff --git a/', fileDiffStart + 1);
        if (nextDiffStart === -1) nextDiffStart = fullDiffOutput.length;
        const fileDiffContent = fullDiffOutput.slice(fileDiffStart, nextDiffStart);
        hunks = (fileDiffContent.match(/^@@/gm) || []).length;
      }

      const isHighRisk = isSensitivePath(filePath) || additions > 500 || deletions > 500;
      files.push({
        path: filePath,
        additions,
        deletions,
        hunks,
        isHighRisk,
      });

      totalAdditions += additions;
      totalDeletions += deletions;
    }

    const structured = {
      type: 'deepchat.gitDiffSummary',
      version: 1,
      root,
      staged,
      files,
      totalAdditions,
      totalDeletions,
    };

    const outputLines = [
      'Git 差异摘要',
      `工作区：${root}`,
      `模式：${staged ? '已暂存' : '未暂存'}`,
      `更改文件数：${files.length}`,
      `总新增行：${totalAdditions}`,
      `总删除行：${totalDeletions}`,
      'Structured Diff Summary:',
      JSON.stringify(structured, null, 2),
      '',
      '修改文件列表：',
    ];

    if (files.length === 0) {
      outputLines.push(staged ? '没有已暂存的更改。' : '没有未提交的更改。');
    } else {
      files.forEach((f, index) => {
        const riskLabel = f.isHighRisk ? ' [⚠️高风险]' : '';
        outputLines.push(`${index + 1}. ${f.path} (+${f.additions} -${f.deletions}, hunks: ${f.hunks})${riskLabel}`);
      });
      outputLines.push('\n提示：若需查看特定文件的详细代码差异，请调用 git_diff({ "file": "文件名" })。');
    }

    return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
  }
}

/**
 * @param {{ path?: string; count?: number; file?: string }} args
 * @param {{ workspaceRoots?: string[] }} settings
 * @returns {Promise<string>}
 */
async function gitLog(args, settings) {
  const root = await resolveWorkspaceRoot(args.path, settings.workspaceRoots || []);
  const count = clampInt(args.count, 1, 100, 10);
  const file = String(args.file || '').trim();
  const gitArgs = ['log', '--format=%H|%h|%an|%ai|%s', '-n', String(count)];
  if (file) gitArgs.push('--', file);
  const { stdout } = await execGit(root, gitArgs);
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  const commits = lines
    .map((line) => {
      const parts = line.split('|');
      if (parts.length < 5) return null;
      return {
        fullHash: parts[0],
        hash: parts[1],
        author: parts[2],
        date: parts[3],
        message: parts.slice(4).join('|'),
      };
    })
    .filter((c) => c !== null);
  const structured = { type: 'deepchat.gitLog', version: 1, root, count, file: file || null, commits };
  const outputLines = [
    'Git 提交历史',
    `工作区：${root}`,
    file ? `文件：${file}` : '范围：所有文件',
    `显示条数：${commits.length}/${count}`,
    'Structured Log:',
    JSON.stringify(structured, null, 2),
    '',
  ];
  if (commits.length === 0) {
    outputLines.push('没有找到提交记录。');
  } else {
    outputLines.push('提交记录：');
    commits.forEach((commit, index) => {
      outputLines.push(`${index + 1}. ${commit.hash} ${commit.date} ${commit.message} (${commit.author})`);
    });
  }
  return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

module.exports = {
  gitStatus,
  gitDiff,
  gitLog,
};
