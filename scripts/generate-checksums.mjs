/**
 * Generate release/SHA256SUMS.txt for uploaded release artifacts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const checksumFile = path.join(releaseDir, 'SHA256SUMS.txt');
const requireArtifact = process.argv.includes('--require-artifact');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

function ok(message) {
  console.log(`  ✅ ${message}`);
}

function fail(message) {
  console.error(`  ❌ ${message}`);
  process.exit(1);
}

function shouldChecksum(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (fileName === 'sbom.cdx.json') return true;
  if (ext === '.exe' || ext === '.blockmap') return fileName.includes(`v${version}`);
  if (ext === '.yml') return !/v\d+\.\d+\.\d+/i.test(fileName) || fileName.includes(`v${version}`);
  return false;
}

if (!fs.existsSync(releaseDir)) {
  if (requireArtifact) fail('release/ directory missing');
  ok('release/ directory missing; skipped checksums');
  process.exit(0);
}

const files = fs.readdirSync(releaseDir).filter(shouldChecksum).sort();
if (files.length === 0) {
  if (requireArtifact) fail('No release artifacts found for checksums');
  ok('No release artifacts found; skipped checksums');
  process.exit(0);
}

const lines = files.map((fileName) => {
  const content = fs.readFileSync(path.join(releaseDir, fileName));
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `${hash.toUpperCase()}  ${fileName}`;
});

fs.writeFileSync(checksumFile, `${lines.join('\n')}\n`, 'utf8');
ok(`Wrote ${path.relative(root, checksumFile)} for ${files.length} artifacts`);
console.log(lines.join('\n'));
