import { describe, expect, it, beforeEach } from 'vitest';
import {
  initMemoryManager,
  isMemoryManagerInitialized,
  addSessionMemory,
  getSessionMemory,
  clearSessionMemory,
  getAllSessionMemory,
  addProjectMemory,
  getProjectMemory,
  getAllProjectMemory,
  addEvidenceMemory,
  getEvidenceMemory,
  getAllEvidenceMemory,
  getEvidenceMemoryCount,
  formatMemoryForContext,
} from '../electron/memory-manager.ts';

// In-memory stubs for readJson / writeJson
function createStorageStub() {
  const store: Record<string, unknown> = {};
  return {
    store,
    async readJson(fileName: string, fallback: unknown) {
      return store[fileName] !== undefined ? store[fileName] : fallback;
    },
    async writeJson(fileName: string, value: unknown) {
      store[fileName] = value;
    },
  };
}

describe('memory-manager', () => {
  let storage: ReturnType<typeof createStorageStub>;

  beforeEach(async () => {
    storage = createStorageStub();
    // Each test starts with a fresh manager
    await initMemoryManager(storage.readJson, storage.writeJson);
  });

  // ── Init ───────────────────────────────────────────────────────────────

  describe('initMemoryManager', () => {
    it('marks as initialized', () => {
      expect(isMemoryManagerInitialized()).toBe(true);
    });

    it('loads existing project memory from disk', async () => {
      const facts = [
        { id: '1', fact: 'Uses TypeScript', category: 'tech', conversationId: 'c1', createdAt: '', updatedAt: '' },
      ];
      storage.store['project-memory.json'] = facts;
      await initMemoryManager(storage.readJson, storage.writeJson);
      expect(getAllProjectMemory()).toHaveLength(1);
    });

    it('loads existing evidence memory from disk', async () => {
      const entries = [
        {
          id: '1',
          sourceTool: 'read_file',
          content: 'file content',
          timestamp: '',
          conversationId: 'c1',
          messageIndex: 0,
        },
      ];
      storage.store['evidence-memory.json'] = entries;
      await initMemoryManager(storage.readJson, storage.writeJson);
      expect(getAllEvidenceMemory()).toHaveLength(1);
    });

    it('handles corrupt JSON gracefully', async () => {
      storage.store['project-memory.json'] = undefined;
      // Should not throw
      await initMemoryManager(async () => {
        throw new Error('bad json');
      }, storage.writeJson);
      expect(getAllProjectMemory()).toEqual([]);
    });
  });

  // ── Session Memory ─────────────────────────────────────────────────────

  describe('session memory', () => {
    it('adds and retrieves a session entry', () => {
      addSessionMemory('activeTask', 'fix build');
      const entry = getSessionMemory('activeTask');
      expect(entry).toBeDefined();
      expect(entry.value).toBe('fix build');
      expect(entry.key).toBe('activeTask');
      expect(entry.updatedAt).toBeTruthy();
    });

    it('returns undefined for missing key', () => {
      expect(getSessionMemory('nonexistent')).toBeUndefined();
    });

    it('overwrites existing key', () => {
      addSessionMemory('task', 'v1');
      addSessionMemory('task', 'v2');
      expect(getSessionMemory('task').value).toBe('v2');
      expect(getAllSessionMemory()).toHaveLength(1);
    });

    it('clears all entries', () => {
      addSessionMemory('a', 1);
      addSessionMemory('b', 2);
      clearSessionMemory();
      expect(getAllSessionMemory()).toHaveLength(0);
    });

    it('stores non-string values', () => {
      addSessionMemory('config', { nested: true });
      expect(getSessionMemory('config').value).toEqual({ nested: true });
    });
  });

  // ── Project Memory ─────────────────────────────────────────────────────

  describe('project memory', () => {
    it('adds a fact and persists to storage', async () => {
      const entry = await addProjectMemory('Project uses Vite', 'tech', 'c1');
      expect(entry.fact).toBe('Project uses Vite');
      expect(entry.category).toBe('tech');
      expect(storage.store['project-memory.json']).toHaveLength(1);
    });

    it('searches facts by keyword', async () => {
      await addProjectMemory('Uses TypeScript for all modules', 'tech');
      await addProjectMemory('Deployed on AWS', 'infra');
      await addProjectMemory('Test framework is vitest', 'testing');

      const results = getProjectMemory('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].fact).toContain('TypeScript');
    });

    it('returns empty for no match', async () => {
      await addProjectMemory('Uses TypeScript', 'tech');
      const results = getProjectMemory('Python');
      expect(results).toEqual([]);
    });

    it('returns empty for empty query', async () => {
      await addProjectMemory('Something', 'general');
      expect(getProjectMemory('')).toEqual([]);
      expect(getProjectMemory('  ')).toEqual([]);
    });

    it('ranks more relevant results higher', async () => {
      await addProjectMemory('React frontend with TypeScript', 'tech');
      await addProjectMemory('Backend deployed on server', 'infra');
      const results = getProjectMemory('TypeScript');
      expect(results[0].fact).toContain('TypeScript');
    });
  });

  // ── Evidence Memory ────────────────────────────────────────────────────

  describe('evidence memory', () => {
    it('adds evidence and persists', async () => {
      const entry = await addEvidenceMemory('read_file', 'console.log("hello")', 'c1', 5);
      expect(entry.sourceTool).toBe('read_file');
      expect(entry.content).toBe('console.log("hello")');
      expect(entry.conversationId).toBe('c1');
      expect(entry.messageIndex).toBe(5);
      expect(storage.store['evidence-memory.json']).toHaveLength(1);
    });

    it('searches evidence by content keyword', async () => {
      await addEvidenceMemory('read_file', 'function buildContext() {}', 'c1', 0);
      await addEvidenceMemory('web_search', 'React documentation page', 'c1', 1);

      const results = getEvidenceMemory('buildContext');
      expect(results).toHaveLength(1);
      expect(results[0].sourceTool).toBe('read_file');
    });

    it('searches evidence by source tool name', async () => {
      await addEvidenceMemory('read_file', 'some content', 'c1', 0);
      await addEvidenceMemory('web_search', 'other content', 'c1', 1);

      const results = getEvidenceMemory('web_search');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await addEvidenceMemory('tool', `shared term item ${i}`, 'c1', i);
      }
      const results = getEvidenceMemory('shared term', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('performs LRU eviction at 1000 entries', async () => {
      // Seed with 999 entries
      for (let i = 0; i < 999; i++) {
        await addEvidenceMemory('tool', `entry ${i}`, 'c1', i);
      }
      expect(getEvidenceMemoryCount()).toBe(999);

      // Add one more — should stay at 1000
      await addEvidenceMemory('tool', 'entry 999', 'c1', 999);
      expect(getEvidenceMemoryCount()).toBe(1000);

      // Add one more — evicts oldest
      await addEvidenceMemory('tool', 'entry 1000', 'c1', 1000);
      expect(getEvidenceMemoryCount()).toBe(1000);

      // The oldest entry should be gone
      const all = getAllEvidenceMemory();
      expect(all[0].content).toBe('entry 1');
    });

    it('returns empty for no match', async () => {
      await addEvidenceMemory('read_file', 'hello world', 'c1', 0);
      expect(getEvidenceMemory('xyz_nonexistent')).toEqual([]);
    });
  });

  // ── formatMemoryForContext ─────────────────────────────────────────────

  describe('formatMemoryForContext', () => {
    it('returns empty text when no memories exist', () => {
      const result = formatMemoryForContext('anything');
      expect(result.text).toContain('<three_layer_memory>');
      expect(result.sessionCount).toBe(0);
      expect(result.projectCount).toBe(0);
      expect(result.evidenceCount).toBe(0);
    });

    it('includes session memory', () => {
      addSessionMemory('activeTask', 'implement memory');
      const result = formatMemoryForContext('implement');
      expect(result.text).toContain('Session Memory');
      expect(result.text).toContain('implement memory');
      expect(result.sessionCount).toBe(1);
    });

    it('includes project memory', async () => {
      await addProjectMemory('Project uses Vite for bundling', 'tech');
      const result = formatMemoryForContext('Vite');
      expect(result.text).toContain('Project Memory');
      expect(result.text).toContain('Vite');
      expect(result.projectCount).toBeGreaterThanOrEqual(1);
    });

    it('includes evidence memory', async () => {
      await addEvidenceMemory('read_file', 'const x = 42', 'c1', 0);
      const result = formatMemoryForContext('const x');
      expect(result.text).toContain('Evidence Memory');
      expect(result.text).toContain('const x');
      expect(result.evidenceCount).toBeGreaterThanOrEqual(1);
    });

    it('combines all three layers', async () => {
      addSessionMemory('task', 'build feature');
      await addProjectMemory('Uses ES modules', 'tech');
      await addEvidenceMemory('run_code', 'output: success with modules loaded', 'c1', 0);

      const result = formatMemoryForContext('modules');
      expect(result.text).toContain('Session Memory');
      expect(result.text).toContain('Project Memory');
      expect(result.text).toContain('Evidence Memory');
      expect(result.sessionCount).toBe(1);
    });

    it('truncates output to max chars', async () => {
      // Add many large facts to exceed limit
      for (let i = 0; i < 20; i++) {
        await addProjectMemory(`A very long fact number ${i} about the project `.repeat(10), 'tech');
      }
      const result = formatMemoryForContext('fact project');
      expect(result.text.length).toBeLessThanOrEqual(2024); // 2000 + small buffer for closing tag
    });

    it('contains XML wrapper tags', () => {
      const result = formatMemoryForContext('test');
      expect(result.text).toContain('<three_layer_memory>');
      expect(result.text).toContain('</three_layer_memory>');
    });
  });
});
