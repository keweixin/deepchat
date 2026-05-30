/**
 * Build Electron main/preload for production.
 *
 * Copies electron/ to a temp dir, rewrites .ts imports to .js,
 * then runs tsc to compile into dist-electron/.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'electron');
const tmpDir = path.join(rootDir, 'tmp-electron-build');
const outDir = path.join(rootDir, 'dist-electron');

// Clean
fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// Copy electron/ to temp dir, rewriting .ts imports/requires to .js in both .ts and .js files
function copyAndReplace(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyAndReplace(srcPath, destPath);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      let content = fs.readFileSync(srcPath, 'utf8');
      // Replace relative .ts imports with .js (but not .d.ts or node_modules)
      content = content.replace(/from\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'from $1$2.js$1');
      // Also handle dynamic imports
      content = content.replace(/import\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.js$1)');
      // Replace relative .ts requires with .js
      content = content.replace(/require\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'require($1$2.js$1)');
      fs.writeFileSync(destPath, content);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyAndReplace(srcDir, tmpDir);

// Write temp tsconfig for the build
const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    moduleResolution: 'node',
    ignoreDeprecations: '6.0',
    outDir: 'dist-electron',
    rootDir: 'tmp-electron-build',
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    strict: false,
    noEmitOnError: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    declaration: false,
    sourceMap: true,
  },
  include: ['tmp-electron-build/**/*'],
};

const tsconfigPath = path.join(rootDir, 'tsconfig.electron.build.json');
fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

try {
  execSync('npx tsc -p tsconfig.electron.build.json', {
    cwd: rootDir,
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tsconfigPath, { force: true });
}

// Post-build validation: scan dist-electron/**/*.js to ensure NO .ts imports or requires exist
function scanForResidualTsReferences(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForResidualTsReferences(fullPath);
    } else if (entry.name.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      // Regex to search for require('./xxx.ts') or from './xxx.ts' or import('./xxx.ts') across arbitrary path depths and quotes
      const importTsRegex = /(?:require|from|import)\s*\(?\s*['"`]\.\.?\/[^'"`]+\.ts['"`]\s*\)?/g;
      const matches = content.match(importTsRegex);
      if (matches) {
        console.error(`Build verification failed: Residual .ts reference found in compiled file ${fullPath}:`);
        for (const match of matches) {
          console.error(`  -> ${match}`);
        }
        process.exit(1);
      }
    }
  }
}

scanForResidualTsReferences(outDir);

// Ensure dist-electron is treated as CommonJS
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));

// Verify required output files exist
const requiredOutputs = ['main.js', 'preload.js', 'chat-service.js', 'package.json'];
for (const output of requiredOutputs) {
  const outputPath = path.join(outDir, output);
  if (!fs.existsSync(outputPath)) {
    console.error(`Build failed: dist-electron/${output} not found`);
    process.exit(1);
  }
}

console.log('dist-electron/ built successfully');
