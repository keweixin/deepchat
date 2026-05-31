/**
 * Generate a production dependency CycloneDX SBOM for release artifacts.
 *
 * Uses package-lock only so CI and local release checks do not depend on
 * incidental node_modules state.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const outputFile = path.join(releaseDir, 'sbom.cdx.json');
const outputFileForCli = path.join('release', 'sbom.cdx.json');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const verifyOnly = process.argv.includes('--verify-only');

function ok(message) {
  console.log(`  ✅ ${message}`);
}

function fail(message) {
  console.error(`  ❌ ${message}`);
  process.exit(1);
}

function validateSbom() {
  if (!fs.existsSync(outputFile)) fail('release/sbom.cdx.json missing');
  const raw = fs.readFileSync(outputFile, 'utf8');
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== 'CycloneDX') fail('SBOM bomFormat is not CycloneDX');
  if (!String(sbom.specVersion || '').startsWith('1.')) fail('SBOM specVersion is missing or invalid');
  if (sbom.metadata?.component?.name !== pkg.name) {
    fail(`SBOM component name mismatch: expected ${pkg.name}`);
  }
  if (sbom.metadata?.component?.version !== pkg.version) {
    fail(`SBOM component version mismatch: expected ${pkg.version}`);
  }
  if (!Array.isArray(sbom.components)) fail('SBOM components array missing');
  ok(`SBOM validated (${sbom.components.length} components)`);
}

if (!verifyOnly) {
  fs.mkdirSync(releaseDir, { recursive: true });
  try {
    execSync(
      [
        'npx cyclonedx-npm',
        '--package-lock-only',
        '--omit dev',
        '--output-reproducible',
        '--output-format JSON',
        `--output-file ${outputFileForCli}`,
        '--validate',
      ].join(' '),
      { cwd: root, stdio: 'inherit' }
    );
  } catch {
    fail('cyclonedx-npm failed');
  }
}

validateSbom();
