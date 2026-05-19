import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'electron'];
const EXTRA_FILES = ['electron.js', 'preload.js', 'index.html'];
const DANGEROUS_PATTERNS = [
  { name: 'eval()', pattern: /\beval\s*\(/ },
  { name: 'new Function', pattern: /\bnew\s+Function\b/ },
  { name: 'executeJavaScript', pattern: /\bexecuteJavaScript\b/ },
  { name: 'inline event handler', pattern: /<[^>]+\son[a-z]+\s*=/i },
];
const SECRET_PATTERNS = [
  { name: 'OpenAI-like API key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Tavily-like API key', pattern: /tvly-[A-Za-z0-9]{20,}/ },
];

const files = [
  ...SCAN_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir))),
  ...EXTRA_FILES.map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file)),
].filter((file) => /\.(js|mjs|html|css)$/.test(file));

const issues = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(text)) issues.push(`${relative(file)} contains ${rule.name}`);
  }
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text) && !text.includes('xxxxxxxx')) {
      issues.push(`${relative(file)} may contain ${rule.name}`);
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
