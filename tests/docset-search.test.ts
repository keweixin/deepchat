import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { listDocsets, searchDocsets, validateDocsetRoot } from '../electron/docset-search.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

describe('local Docset search provider', () => {
  it('imports a .docset fixture and returns pure text evidence', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-docset-'));
    const root = path.join(tmp, 'Example.docset');
    try {
      await createDocsetFixture(root, {
        name: 'Array.prototype.map',
        type: 'Function',
        docPath: 'JavaScript/Array/map.html',
        html: '<html><body><script>alert(1)</script><h1>Array map</h1><p>Creates a new array from callback results.</p></body></html>',
      });

      const info = validateDocsetRoot(root);
      const listed = listDocsets({ docsetRoots: [root] });
      const payload = searchDocsets('map', { docsetSearchEnabled: true, docsetRoots: [root] }, { maxResults: 5 });

      expect(info.name).toBe('Example');
      expect(listed[0]).toMatchObject({ name: 'Example', entryCount: 1 });
      expect(payload.provider).toBe('local_docset');
      expect(payload.results[0]).toMatchObject({
        docset: 'Example',
        title: 'Array.prototype.map',
        path: 'JavaScript/Array/map.html',
      });
      expect(payload.results[0].content).toContain('Creates a new array');
      expect(payload.results[0].content).not.toContain('alert(1)');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-docset roots and doc paths outside Documents', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-docset-invalid-'));
    const root = path.join(tmp, 'Bad.docset');
    try {
      await createDocsetFixture(root, {
        name: 'Escape',
        type: 'Guide',
        docPath: '../escape.html',
        html: '<p>should not read</p>',
      });

      expect(() => validateDocsetRoot(tmp)).toThrow('不是有效 docset');
      const payload = searchDocsets('escape', { docsetSearchEnabled: true, docsetRoots: [root] }, { maxResults: 5 });
      expect(payload.results).toHaveLength(0);
      expect(payload.warnings.join('\n')).toContain('Docset 文档路径越界');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

async function createDocsetFixture(root: string, entry: { name: string; type: string; docPath: string; html: string }) {
  const resources = path.join(root, 'Contents', 'Resources');
  const docs = path.join(resources, 'Documents');
  await fs.mkdir(docs, { recursive: true });
  await fs.mkdir(path.dirname(path.join(docs, entry.docPath)), { recursive: true });
  await fs.writeFile(path.join(docs, entry.docPath), entry.html, 'utf8');
  const db = new DatabaseSync(path.join(resources, 'docSet.dsidx'));
  try {
    db.exec('CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT)');
    db.prepare('INSERT INTO searchIndex(name, type, path) VALUES (?, ?, ?)').run(entry.name, entry.type, entry.docPath);
  } finally {
    db.close();
  }
}
