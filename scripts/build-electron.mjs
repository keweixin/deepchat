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

// Copy electron/ to temp dir, rewriting .ts imports to .js in .ts files
function copyAndReplace(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyAndReplace(srcPath, destPath);
    } else if (entry.name.endsWith('.ts')) {
      let content = fs.readFileSync(srcPath, 'utf8');
      // Replace relative .ts imports with .js (but not .d.ts or node_modules)
      content = content.replace(/from\s+(['"])(\.\/[^'"]+)\.ts\1/g, 'from $1$2.js$1');
      // Also handle dynamic imports
      content = content.replace(/import\s*\(\s*(['"])(\.\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.js$1)');
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
    noEmitOnError: false,
    allowJs: true,
    checkJs: false,
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

// Verify output
const mainJs = path.join(outDir, 'main.js');
if (!fs.existsSync(mainJs)) {
  console.error('Build failed: dist-electron/main.js not found');
  process.exit(1);
}
console.log('dist-electron/ built successfully');
