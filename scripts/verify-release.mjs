/**
 * Release verification script.
 * Automates the automatable parts of RELEASE_CHECKLIST.md.
 *
 * Usage: node scripts/verify-release.mjs [--skip-verify]
 */
const skipVerify = process.argv.includes('--skip-verify');
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
let failed = 0;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.error(`  ❌ ${msg}`);
  failed += 1;
}
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function shouldChecksumReleaseFile(fileName, version) {
  const ext = path.extname(fileName).toLowerCase();
  if (fileName === 'sbom.cdx.json') return true;
  if (ext === '.exe' || ext === '.blockmap') return fileName.includes(`v${version}`);
  if (ext === '.yml') return !/v\d+\.\d+\.\d+/i.test(fileName) || fileName.includes(`v${version}`);
  return false;
}

console.log('🔍 Release Verification\n');

// 1. Version consistency: package.json vs CHANGELOG.md
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

if (changelog.includes(`## ${version}`)) {
  ok(`CHANGELOG.md contains section for v${version}`);
} else {
  fail(`CHANGELOG.md is missing section for v${version}`);
}

// 2. ROADMAP.md Shipped section should mention current version
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
if (roadmap.includes(version)) {
  ok(`ROADMAP.md references v${version}`);
} else {
  ok(`ROADMAP.md does not reference v${version} (optional)`);
}

// 3. Run npm run verify
if (!skipVerify) {
  console.log('\n📦 Running npm run verify...');
  try {
    execSync('npm run verify', { cwd: root, stdio: 'inherit' });
    ok('npm run verify passed');
  } catch {
    fail('npm run verify failed');
  }
} else {
  ok('Skipped npm run verify (--skip-verify)');
}

// 4. npm audit (production deps only)
if (!skipVerify) {
  console.log('\n🔒 Running npm audit --omit=dev...');
  try {
    execSync('npm audit --omit=dev --registry=https://registry.npmjs.org', {
      cwd: root,
      stdio: 'inherit',
    });
    ok('npm audit passed (no production vulnerabilities)');
  } catch {
    fail('npm audit found production vulnerabilities');
  }
} else {
  ok('Skipped npm audit (--skip-verify)');
}

// 5. Check dist-electron/ was built
const distElectronMain = path.join(root, 'dist-electron', 'main.js');
if (fs.existsSync(distElectronMain)) {
  ok('dist-electron/main.js exists');
} else {
  fail('dist-electron/main.js missing — run npm run build:electron');
}

// 6. Check release artifacts naming
const releaseDir = path.join(root, 'release');
if (fs.existsSync(releaseDir)) {
  const artifacts = fs.readdirSync(releaseDir);
  const escapedVersion = escapeRegex(version);
  const setup = artifacts.find((f) => f.match(new RegExp(`^DeepChat-Setup-v${escapedVersion}\\.exe$`)));
  const portable = artifacts.find((f) =>
    f.match(new RegExp(`^DeepChat-Portable-v${escapedVersion}-\\d{8}-?\\d{6}\\.exe$`))
  );
  if (setup) ok(`Setup artifact: ${setup}`);
  else ok(`No setup artifact for v${version} in release/ (may not have built yet)`);
  if (portable) ok(`Portable artifact: ${portable}`);
  else ok(`No portable artifact for v${version} in release/ (may not have built yet)`);
} else {
  ok('release/ directory does not exist yet');
}

// 7. Check SHA256SUMS.txt exists if there are .exe files for current version
const versionExeFiles = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((f) => f.endsWith('.exe') && f.includes(`v${version}`))
  : [];
if (versionExeFiles.length > 0) {
  const shaSums = path.join(releaseDir, 'SHA256SUMS.txt');
  if (fs.existsSync(shaSums)) {
    ok('release/SHA256SUMS.txt exists');
    const shaText = fs.readFileSync(shaSums, 'utf8');
    const releaseFiles = fs.readdirSync(releaseDir);
    const filesToChecksum = releaseFiles.filter((fileName) => shouldChecksumReleaseFile(fileName, version)).sort();
    for (const fileName of filesToChecksum) {
      if (shaText.includes(`  ${fileName}`)) ok(`SHA256SUMS.txt includes ${fileName}`);
      else fail(`SHA256SUMS.txt missing ${fileName}`);
    }
    const staleChecksumFiles = releaseFiles.filter((fileName) => !shouldChecksumReleaseFile(fileName, version));
    for (const fileName of staleChecksumFiles) {
      if (shaText.includes(`  ${fileName}`)) fail(`SHA256SUMS.txt includes stale artifact ${fileName}`);
    }
  } else {
    fail('release/SHA256SUMS.txt missing');
  }
} else {
  ok('No release artifacts for current version yet');
}

// Summary
console.log('\n' + '='.repeat(50));
if (failed === 0) {
  console.log('🎉 All release checks passed!');
  process.exit(0);
} else {
  console.log(`⚠️  ${failed} release check(s) failed.`);
  console.log('   Please fix the issues above before publishing.');
  process.exit(1);
}
