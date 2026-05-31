/**
 * Smoke test packaged release artifacts by launching the portable app.
 *
 * This catches missing resources and early startup crashes that unit, browser,
 * and Electron-from-source tests cannot prove.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const requireArtifact = process.argv.includes('--require-artifact');
const stableMs = readNumberArg('--stable-ms', 10_000);

function readNumberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

function fail(message) {
  console.error(`  ❌ ${message}`);
  process.exit(1);
}

function findPortableArtifact() {
  if (!fs.existsSync(releaseDir)) return '';
  const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const portablePattern = new RegExp(`^DeepChat-Portable-v${escapedVersion}-\\d{8}-?\\d{6}\\.exe$`);
  const candidates = fs
    .readdirSync(releaseDir)
    .filter((name) => portablePattern.test(name))
    .sort()
    .reverse();
  return candidates[0] ? path.join(releaseDir, candidates[0]) : '';
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

const artifact = findPortableArtifact();
if (!artifact) {
  if (requireArtifact) fail(`No DeepChat portable artifact found for v${pkg.version}`);
  ok(`No DeepChat portable artifact found for v${pkg.version}; skipped packaged smoke`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  fail('Packaged smoke currently requires a Windows portable artifact');
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepchat-release-smoke-'));
const child = spawn(artifact, [], {
  cwd: root,
  env: {
    ...process.env,
    DEEPCHAT_DISABLE_GPU: '1',
    DEEPCHAT_TEST_USER_DATA_DIR: userDataDir,
    NODE_ENV: 'production',
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

const earlyExitTimer = setTimeout(() => {
  killProcessTree(child.pid);
  ok(`Portable artifact launched and stayed alive for ${stableMs}ms: ${path.basename(artifact)}`);
  process.exit(0);
}, stableMs);

child.once('error', (error) => {
  clearTimeout(earlyExitTimer);
  fail(`Failed to launch portable artifact: ${error.message}`);
});

child.once('exit', (code, signal) => {
  clearTimeout(earlyExitTimer);
  fail(
    `Portable artifact exited before smoke window elapsed (code=${code ?? 'null'}, signal=${signal ?? 'null'}). ${
      stderr ? `stderr: ${stderr.slice(-2000)}` : ''
    }`
  );
});
