import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'electron'];
const EXTRA_FILES = ['electron.js', 'preload.js', 'index.html'];
const DANGEROUS_PATTERNS = [
  { name: 'eval()', pattern: /\beval\s*\(/ },
  { name: 'new Function', pattern: /\bnew\s+Function\b/ },
  { name: 'executeJavaScript', pattern: /\bexecuteJavaScript\b/ },
  { name: 'inline event handler', pattern: /<[^>\n]*\son[a-z]+\s*=/i },
];
const SECURITY_PATTERNS = [
  {
    name: 'shell.openExternal without allowlist',
    pattern: /shell\.openExternal\s*\(/,
    allowlist: ['electron.js', 'electron/main.ts'],
  },
];
const SECRET_PATTERNS = [
  { name: 'OpenAI-like API key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Tavily-like API key', pattern: /tvly-[A-Za-z0-9]{20,}/ },
];
const SENSITIVE_FILE_PATTERNS = /\.(env|pem|key|cert)$/i;
const FORBIDDEN_TOOL_TEXT = [
  {
    name: 'run_code hard memory limit copy',
    pattern: /512MB memory limit|内存目标：?512MB/,
  },
  {
    name: 'source-local edit backup copy',
    pattern: /\.deepchat-backups/,
  },
];
const REQUIRED_FILE_TOOL_EXPORTS = [
  'editFile',
  'multiEdit',
  'previewEditFile',
  'previewMultiEdit',
  'previewFileEditTool',
];
const REQUIRED_JS_TOOL_DECLARATIONS = [
  'electron/tools-file.d.ts',
  'electron/tools-path.d.ts',
  'electron/tools-run-code.d.ts',
  'electron/tools-schemas.d.ts',
  'electron/shared/tool-definitions.d.ts',
];

const files = [
  ...SCAN_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir))),
  ...EXTRA_FILES.map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file)),
].filter((file) => /\.(js|mjs|ts|html|css)$/.test(file));

const issues = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = relative(file);
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(text)) issues.push(`${rel} contains ${rule.name}`);
  }
  for (const rule of SECURITY_PATTERNS) {
    if (rule.pattern.test(text)) {
      if (!rule.allowlist || !rule.allowlist.some((p) => rel.replace(/\\/g, '/').includes(p))) {
        issues.push(`${rel} contains ${rule.name}`);
      }
    }
  }
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text) && !text.includes('xxxxxxxx')) {
      issues.push(`${rel} may contain ${rule.name}`);
    }
  }
  if (SENSITIVE_FILE_PATTERNS.test(path.basename(file))) {
    issues.push(`${rel} is a sensitive file type and should not be in source`);
  }
  for (const rule of FORBIDDEN_TOOL_TEXT) {
    if (rule.pattern.test(text)) issues.push(`${rel} contains stale tool safety text: ${rule.name}`);
  }

  // Strict innerHTML check line-by-line
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.innerHTML\s*=/.test(line)) {
      // 1. Allow safeSetHTML-impl strictly only in src/modules/renderer.ts
      if (line.includes('/* safeSetHTML-impl') && rel === 'src/modules/renderer.ts') {
        continue;
      }
      // 2. Allow verified static templates with explicit trusted-html, template-safe, or safeSetHTML-exempt comments
      if (
        line.includes('/* trusted-html */') ||
        line.includes('/* template-safe */') ||
        /\/\*\s*safeSetHTML-exempt\s*:\s*[^*]+\*\//i.test(line)
      ) {
        continue;
      }

      issues.push(
        `${rel}:${i + 1} contains unauthorized innerHTML assignment. Use safeSetHTML instead, or annotate with /* trusted-html */, /* template-safe */, or /* safeSetHTML-exempt: <reason> */ if it is a verified static template.`
      );
    }

    if (/\bsetTrustedTemplateHTML\s*\(/.test(line)) {
      // 1. Allow function definition inside renderer.ts (export function setTrustedTemplateHTML)
      if (rel === 'src/modules/renderer.ts' && /function\s+setTrustedTemplateHTML/.test(line)) {
        continue;
      }
      // 2. Require explicit validation comment at call sites
      if (
        line.includes('/* trusted-html */') ||
        line.includes('/* template-safe */') ||
        /\/\*\s*safeSetHTML-exempt\s*:\s*[^*]+\*\//i.test(line)
      ) {
        continue;
      }

      issues.push(
        `${rel}:${i + 1} contains setTrustedTemplateHTML without validation comment. You must annotate the call with /* trusted-html */, /* template-safe */, or /* safeSetHTML-exempt: <reason> */ to certify its static safety.`
      );
    }
  }
}

checkToolSurfaceContracts(issues);

if (issues.length > 0) {
  console.error('Source check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Source check passed (${files.length} files scanned).`);

function checkToolSurfaceContracts(issues) {
  const toolsFile = fs.readFileSync(path.join(ROOT, 'electron/tools-file.js'), 'utf8');
  const toolDefinitions = fs.readFileSync(path.join(ROOT, 'electron/shared/tool-definitions.js'), 'utf8');
  const workspaceIndex = fs.readFileSync(path.join(ROOT, 'electron/workspace-index.ts'), 'utf8');
  const missingExports = REQUIRED_FILE_TOOL_EXPORTS.filter((name) => !new RegExp(`\\b${name}\\b`).test(toolsFile));
  if (missingExports.length) {
    issues.push(`electron/tools-file.js is missing required write-tool exports: ${missingExports.join(', ')}`);
  }
  for (const rel of REQUIRED_JS_TOOL_DECLARATIONS) {
    if (!fs.existsSync(path.join(ROOT, rel))) issues.push(`${rel} is required to type-check JS tool module imports`);
  }
  if (/\bapplyPatch\b/.test(toolsFile) || /\bapply_patch\b/.test(toolDefinitions)) {
    issues.push('dangerous partial patch tool is still exposed; use edit_file or multi_edit instead');
  }
  if (/^\s*(?:import|export)\s/m.test(workspaceIndex)) {
    issues.push(
      'electron/workspace-index.ts must stay CommonJS-shaped to avoid Node MODULE_TYPELESS_PACKAGE_JSON warnings'
    );
  }
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath);
    return entry.isFile() ? [fullPath] : [];
  });
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}
