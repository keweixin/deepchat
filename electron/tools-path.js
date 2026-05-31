// @ts-check
const fs = require('fs/promises');
const path = require('path');

const SENSITIVE_PATH_PARTS = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.vault',
  '.password-store',
  'secrets',
  'tokens',
  '.env',
  '.env.local',
  '.env.production',
]);
const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.envrc',
  'credentials.json',
  'secrets.json',
  'tokens.json',
  'cookie.json',
  'session.json',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
  'known_hosts',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.der', '.cer', '.jks', '.keystore']);

/**
 * @param {string[]} roots
 * @returns {string[]}
 */
function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots.map((root) => path.resolve(String(root))).filter(Boolean);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function pathEquals(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
function isPathInsideRoot(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {string | undefined} inputRoot
 * @param {string[]} workspaceRoots
 * @returns {Promise<string>}
 */
async function resolveWorkspaceRoot(inputRoot, workspaceRoots) {
  const roots = normalizeRoots(workspaceRoots);
  if (roots.length === 0) throw new Error('请先在设置中添加允许读取的工作区目录。');
  if (!inputRoot) return roots[0];
  const requested = path.resolve(String(inputRoot));
  const matched = roots.find((root) => pathEquals(root, requested));
  if (!matched) throw new Error('请求的 root 不在已授权工作区中。');
  return matched;
}

/**
 * @param {string} inputPath
 * @param {string[]} workspaceRoots
 * @returns {Promise<string>}
 */
async function resolveAllowedPath(inputPath, workspaceRoots) {
  const roots = normalizeRoots(workspaceRoots);
  if (roots.length === 0) throw new Error('请先在设置中添加允许读取的工作区目录。');
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('文件路径不能为空。');

  const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : roots.map((root) => path.resolve(root, raw));

  for (const candidate of candidates) {
    let realCandidate;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch {
      continue;
    }
    for (const root of roots) {
      let realRoot;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        continue;
      }
      if (isPathInsideRoot(realCandidate, realRoot)) return realCandidate;
    }
  }
  throw new Error('文件路径不在已授权工作区中。');
}

/**
 * @param {string | undefined} inputPath
 * @param {string[]} workspaceRoots
 * @returns {Promise<string>}
 */
async function resolveAllowedDirectory(inputPath, workspaceRoots) {
  const directoryPath = await resolveAllowedPath(inputPath || '.', workspaceRoots);
  const stat = await fs.stat(directoryPath);
  if (!stat.isDirectory()) throw new Error('只能列出目录，不能把文件作为 list_files 的 directory。');
  return directoryPath;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isSensitivePath(filePath) {
  const normalized = path.resolve(String(filePath || ''));
  const parts = normalized.split(/[\\/]+/).map((part) => part.toLowerCase());
  const base = parts[parts.length - 1] || '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(base).toLowerCase())) return true;
  if (parts.some((part) => SENSITIVE_PATH_PARTS.has(part))) return true;
  return /(token|secret|password|api[_-]?key|credential|private[_-]?key)/i.test(base);
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const scanLength = Math.min(buffer.length, 4096);
  for (let i = 0; i < scanLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

module.exports = {
  resolveWorkspaceRoot,
  resolveAllowedPath,
  resolveAllowedDirectory,
  isSensitivePath,
  normalizeRoots,
  pathEquals,
  isPathInsideRoot,
  isProbablyBinary,
};
