/**
 * SQLite FTS5 Workspace Index
 *
 * Full-text search index for workspace files using SQLite FTS5.
 * Stored at {userData}/data/workspace.db
 *
 * Tables:
 *   - files: id, path, size, mtime, hash, language
 *   - chunks: file_id, chunk_index, line_start, line_end, content
 *   - symbols: file_id, name, kind, line, column
 *   - chunks_fts: FTS5 virtual table on chunks.content
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CHUNK_LINES = 80;
const MAX_FILE_BYTES = 64 * 1024;
const SYMBOL_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.mts', '.py']);
const INDEXED_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.r',
  '.lua',
  '.php',
  '.pl',
  '.ex',
  '.exs',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', 'build', '.cache', '__pycache__']);
const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
  'known_hosts',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt']);

let db: any = null;

/**
 * Initialize the workspace index database.
 * Creates the SQLite database and tables if they don't exist.
 * @param {string} [dbPath] - Custom database path. Defaults to {userData}/data/workspace.db
 */
export async function initWorkspaceIndex(dbPath?: string): Promise<void> {
  if (db) return;

  const resolvedPath = dbPath || getDefaultDbPath();
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  const Database = require('better-sqlite3');
  db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      size INTEGER DEFAULT 0,
      mtime REAL DEFAULT 0,
      hash TEXT DEFAULT '',
      language TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      content TEXT DEFAULT '',
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT DEFAULT 'symbol',
      line INTEGER NOT NULL,
      column INTEGER DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
  `);
}

/**
 * Scan a workspace directory and build/update the index.
 * Incremental: compares file hash + mtime, only re-indexes changed files.
 * @param {string} rootPath - Workspace root directory
 * @param {object} [options]
 * @param {number} [options.maxFiles] - Maximum files to scan (default 700)
 */
export async function indexWorkspace(
  rootPath: string,
  options: { maxFiles?: number } = {}
): Promise<{
  totalFiles: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  symbols: number;
}> {
  if (!db) await initWorkspaceIndex();

  const maxFiles = Math.min(options.maxFiles || 700, 700);
  const resolvedRoot = path.resolve(rootPath);

  const filePaths: string[] = [];
  await walkDir(resolvedRoot, resolvedRoot, filePaths, maxFiles);

  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
  const selectFile = db.prepare('SELECT id, path, size, mtime, hash FROM files WHERE path = ?');
  const insertFile = db.prepare('INSERT INTO files (path, size, mtime, hash, language) VALUES (?, ?, ?, ?, ?)');
  const updateFile = db.prepare('UPDATE files SET size = ?, mtime = ?, hash = ?, language = ? WHERE id = ?');
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE file_id = ?');
  const deleteSymbols = db.prepare('DELETE FROM symbols WHERE file_id = ?');
  const insertChunk = db.prepare(
    'INSERT INTO chunks (file_id, chunk_index, line_start, line_end, content) VALUES (?, ?, ?, ?, ?)'
  );
  const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, line, column) VALUES (?, ?, ?, ?, ?)');

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let symbolCount = 0;

  const transaction = db.transaction(() => {
    const seenPaths = new Set<string>();

    for (const fullPath of filePaths) {
      if (isSensitive(fullPath)) continue;

      const relPath = path.relative(resolvedRoot, fullPath) || fullPath;
      const normalizedPath = relPath.replace(/\\/g, '/');
      seenPaths.add(normalizedPath);

      let stat;
      try {
        stat = { size: 0, mtimeMs: 0 };
        const s = require('fs').statSync(fullPath);
        stat.size = s.size;
        stat.mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }

      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;

      const existing = selectFile.get(normalizedPath) as any;
      const fileHash = quickHash(stat.size, stat.mtimeMs);

      if (existing && existing.hash === fileHash && existing.size === stat.size) {
        unchanged++;
        continue;
      }

      let content: string;
      try {
        content = require('fs').readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      if (!content || content.length === 0) continue;

      const contentHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 16);
      const ext = path.extname(fullPath).toLowerCase();
      const language = getLanguage(ext);
      const chunks = splitChunks(content);
      const syms = extractSymbols(content, ext);

      if (existing) {
        updateFile.run(stat.size, stat.mtimeMs, contentHash, language, existing.id);
        deleteChunks.run(existing.id);
        deleteSymbols.run(existing.id);
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          insertChunk.run(existing.id, i, c.lineStart, c.lineEnd, c.content);
        }
        for (const sym of syms) {
          insertSymbol.run(existing.id, sym.name, sym.kind, sym.line, sym.column);
          symbolCount++;
        }
        updated++;
      } else {
        const info = insertFile.run(normalizedPath, stat.size, stat.mtimeMs, contentHash, language);
        const fileId = info.lastInsertRowid;
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          insertChunk.run(fileId, i, c.lineStart, c.lineEnd, c.content);
        }
        for (const sym of syms) {
          insertSymbol.run(fileId, sym.name, sym.kind, sym.line, sym.column);
          symbolCount++;
        }
        added++;
      }
    }

    // Remove files that no longer exist
    const allFiles = db.prepare('SELECT id, path FROM files').all() as any[];
    for (const file of allFiles) {
      if (!seenPaths.has(file.path)) {
        deleteChunks.run(file.id);
        deleteSymbols.run(file.id);
        deleteFile.run(file.path);
      }
    }
  });

  transaction();

  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");

  const totalFiles = (db.prepare('SELECT COUNT(*) as count FROM files').get() as any).count;
  const removed = filePaths.length > 0 ? Math.max(0, unchanged + added + updated - totalFiles) : 0;

  return { totalFiles, added, updated, unchanged, removed, symbols: symbolCount };
}

/**
 * Full-text search across workspace content.
 * @param {string} query - Search query (supports FTS5 syntax)
 * @param {object} [options]
 * @param {string} [options.root] - Filter by workspace root
 * @param {string} [options.pattern] - Filter by file path pattern (substring match)
 * @param {number} [options.limit] - Max results (default 8)
 */
export function searchWorkspace(
  query: string,
  options: {
    root?: string;
    pattern?: string;
    limit?: number;
  } = {}
): Array<{
  file: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  snippet: Array<{ line: number; text: string }>;
  score: number;
}> {
  if (!db) return [];

  const limit = Math.min(Math.max(options.limit || 8, 1), 20);
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const conditions: string[] = [];
  const params: any[] = [];

  if (options.root) {
    const normalizedRoot = options.root.replace(/\\/g, '/');
    conditions.push("f.path LIKE ? || '%'");
    params.push(normalizedRoot);
  }

  if (options.pattern) {
    conditions.push('f.path LIKE ?');
    params.push(`%${options.pattern}%`);
  }

  const whereClause = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `
    SELECT
      c.id as chunk_id,
      c.file_id,
      c.chunk_index,
      c.line_start,
      c.line_end,
      c.content,
      f.path as file_path,
      bm25(chunks_fts, 1.0) as rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN files f ON f.id = c.file_id
    WHERE chunks_fts MATCH ? ${whereClause}
    ORDER BY rank
    LIMIT ?
  `
    )
    .all(ftsQuery, ...params, limit) as any[];

  return rows.map((row: any) => {
    const lines = String(row.content || '').split('\n');
    const snippet = lines.map((text: string, i: number) => ({
      line: row.line_start + i,
      text,
    }));
    return {
      file: row.file_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      content: row.content,
      snippet,
      score: -row.rank,
    };
  });
}

/**
 * Find symbol definitions in the workspace.
 * @param {string} name - Symbol name to find
 * @param {object} [options]
 * @param {string} [options.kind] - Filter by symbol kind (function/class/variable/export)
 * @param {string} [options.root] - Filter by workspace root
 * @param {number} [options.limit] - Max results (default 10)
 */
export function findSymbol(
  name: string,
  options: {
    kind?: string;
    root?: string;
    limit?: number;
  } = {}
): Array<{
  file: string;
  name: string;
  kind: string;
  line: number;
  column: number;
  context: Array<{ lineStart: number; lineEnd: number; content: string }>;
}> {
  if (!db) return [];

  const limit = Math.min(Math.max(options.limit || 10, 1), 50);

  const conditions: string[] = ['s.name = ?'];
  const params: any[] = [name];

  if (options.kind) {
    conditions.push('s.kind = ?');
    params.push(options.kind);
  }

  if (options.root) {
    const normalizedRoot = options.root.replace(/\\/g, '/');
    conditions.push("f.path LIKE ? || '%'");
    params.push(normalizedRoot);
  }

  const whereClause = conditions.join(' AND ');

  const rows = db
    .prepare(
      `
    SELECT
      s.name,
      s.kind,
      s.line,
      s.column,
      f.path as file_path,
      s.file_id
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE ${whereClause}
    ORDER BY s.line
    LIMIT ?
  `
    )
    .all(...params, limit) as any[];

  return rows.map((row: any) => {
    const contextChunks = db
      .prepare(
        `
      SELECT line_start, line_end, content
      FROM chunks
      WHERE file_id = ? AND line_start <= ? AND line_end >= ?
      ORDER BY chunk_index
    `
      )
      .all(row.file_id, row.line, row.line) as any[];

    return {
      file: row.file_path,
      name: row.name,
      kind: row.kind,
      line: row.line,
      column: row.column,
      context: contextChunks.map((c: any) => ({
        lineStart: c.line_start,
        lineEnd: c.line_end,
        content: c.content,
      })),
    };
  });
}

/**
 * Get workspace index statistics.
 */
export function getWorkspaceStats(): {
  fileCount: number;
  chunkCount: number;
  symbolCount: number;
} {
  if (!db) return { fileCount: 0, chunkCount: 0, symbolCount: 0 };

  const fileCount = (db.prepare('SELECT COUNT(*) as count FROM files').get() as any).count || 0;
  const chunkCount = (db.prepare('SELECT COUNT(*) as count FROM chunks').get() as any).count || 0;
  const symbolCount = (db.prepare('SELECT COUNT(*) as count FROM symbols').get() as any).count || 0;

  return { fileCount, chunkCount, symbolCount };
}

/**
 * Clear and recreate the workspace index.
 */
export async function clearWorkspaceIndex(): Promise<void> {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }

  const dbPath = getDefaultDbPath();
  try {
    await fs.rm(dbPath, { force: true });
    await fs.rm(dbPath + '-wal', { force: true });
    await fs.rm(dbPath + '-shm', { force: true });
  } catch {}
}

// --- Internal helpers ---

function getDefaultDbPath(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'data', 'workspace.db');
  } catch {
    return path.join(process.cwd(), '.deepchat-workspace.db');
  }
}

function splitChunks(content: string): Array<{ lineStart: number; lineEnd: number; content: string }> {
  const lines = content.split('\n');
  const chunks: Array<{ lineStart: number; lineEnd: number; content: string }> = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    chunks.push({
      lineStart: i + 1,
      lineEnd: end,
      content: lines.slice(i, end).join('\n'),
    });
  }
  return chunks;
}

function extractSymbols(
  content: string,
  ext: string
): Array<{ name: string; kind: string; line: number; column: number }> {
  const lang = getLanguage(ext);
  if (!SYMBOL_EXTENSIONS.has(ext)) return [];

  const lines = content.split('\n');
  const symbols: Array<{ name: string; kind: string; line: number; column: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === 'python') {
      const defMatch = line.match(/^\s*(?:async\s+)?def\s+([\w$]+)\s*\(/);
      if (defMatch) {
        symbols.push({ name: defMatch[1], kind: 'function', line: i + 1, column: line.indexOf(defMatch[1]) });
        continue;
      }
      const classMatch = line.match(/^\s*class\s+([\w$]+)\s*[\(:]?/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line: i + 1, column: line.indexOf(classMatch[1]) });
        continue;
      }
    } else {
      const funcMatch = line.match(
        /(?:export\s+)?(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function|\([\w$,\s]*\)\s*=>|[\w$]+\s*=>))/
      );
      if (funcMatch) {
        const name = funcMatch[1] || funcMatch[2];
        if (name) {
          const isExport = /^\s*export\b/.test(line);
          symbols.push({ name, kind: isExport ? 'export' : 'function', line: i + 1, column: line.indexOf(name) });
          continue;
        }
      }
      const classMatch = line.match(/(?:export\s+)?class\s+([\w$]+)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          line: i + 1,
          column: line.indexOf(classMatch[1]),
        });
        continue;
      }
      const varMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/);
      if (varMatch) {
        const isExport = /^\s*export\b/.test(line);
        symbols.push({
          name: varMatch[1],
          kind: isExport ? 'export' : 'variable',
          line: i + 1,
          column: line.indexOf(varMatch[1]),
        });
      }
    }
  }
  return symbols;
}

function getLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sh': 'shell',
    '.sql': 'sql',
  };
  return map[ext] || 'text';
}

function quickHash(size: number, mtime: number): string {
  return `${size}:${Math.round(mtime)}`;
}

function isSensitive(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/(token|secret|password|api[_-]?key|credential|private[_-]?key)/i.test(base)) return true;
  const parts = filePath.replace(/\\/g, '/').split('/');
  const sensitiveDirs = new Set(['.ssh', '.aws', '.azure', '.gnupg']);
  if (parts.some((p) => sensitiveDirs.has(p.toLowerCase()))) return true;
  return false;
}

async function walkDir(root: string, current: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;
  let entries: any[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, fullPath, files, maxFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (INDEXED_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
}

function buildFtsQuery(query: string): string {
  const cleaned = String(query || '').trim();
  if (!cleaned) return '';
  const terms = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
