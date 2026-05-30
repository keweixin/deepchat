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

  // Strict innerHTML check line-by-line
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.innerHTML\s*=/.test(line)) {
      // Allow DOMPurify.sanitize() on the same line — this is the only truly safe runtime pattern
      if (/DOMPurify\.sanitize\s*\(/.test(line)) continue;
      // Require explicit exemption with a written reason
      if (!/\/\*\s*safeSetHTML-exempt\s*:\s*[^*]+\*\//i.test(line)) {
        issues.push(
          `${rel}:${i + 1} contains unauthorized innerHTML assignment. Use safeSetHTML instead, or mark with /* safeSetHTML-exempt: <reason> */ if it is a verified static template.`
        );
      }
    }
  }
}

if (issues.length > 0) {
  console.error('Source check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Source check passed (${files.length} files scanned).`);

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
