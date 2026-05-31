/**
 * Artifact Versions Tests
 */

import { describe, it, expect } from 'vitest';
import {
  createArtifactVersion,
  createArtifactVersionStore,
  diffArtifactVersions,
  autoChangeNote,
  exportArtifactVersion,
  buildVersionDownloadName,
} from '../src/modules/artifact-versions.js';

describe('createArtifactVersion', () => {
  it('creates version with defaults', () => {
    const v = createArtifactVersion({ content: 'hello', type: 'code' });
    expect(v.id).toBeTruthy();
    expect(v.timestamp).toBeGreaterThan(0);
    expect(v.content).toBe('hello');
    expect(v.type).toBe('code');
  });

  it('includes meta fields', () => {
    const v = createArtifactVersion({ content: 'x' }, { changeNote: 'fix bug', sourceMessageId: 'msg_1' });
    expect(v.changeNote).toBe('fix bug');
    expect(v.sourceMessageId).toBe('msg_1');
  });
});

describe('createArtifactVersionStore', () => {
  it('adds and retrieves versions', () => {
    const store = createArtifactVersionStore();
    store.add({ title: 'test.md', content: 'v1', type: 'markdown' });
    store.add({ title: 'test.md', content: 'v2', type: 'markdown' });

    const history = store.getHistory('test.md');
    expect(history.length).toBe(2);
    expect(history[1].content).toBe('v2');
  });

  it('returns latest version', () => {
    const store = createArtifactVersionStore();
    store.add({ title: 'a', content: 'v1' });
    store.add({ title: 'a', content: 'v2' });
    expect(store.getLatest('a').content).toBe('v2');
  });

  it('returns null for missing key', () => {
    const store = createArtifactVersionStore();
    expect(store.getHistory('missing')).toEqual([]);
    expect(store.getLatest('missing')).toBeNull();
  });

  it('removes version by id', () => {
    const store = createArtifactVersionStore();
    const v = store.add({ title: 'a', content: 'x' });
    expect(store.remove('a', v.id)).toBe(true);
    expect(store.getHistory('a').length).toBe(0);
  });

  it('clears all versions', () => {
    const store = createArtifactVersionStore();
    store.add({ title: 'a', content: 'x' });
    store.clear();
    expect(store.getAllKeys().length).toBe(0);
  });
});

describe('diffArtifactVersions', () => {
  it('detects no change', () => {
    const d = diffArtifactVersions('a\nb', 'a\nb');
    expect(d.changed).toBe(false);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it('detects added lines', () => {
    const d = diffArtifactVersions('a', 'a\nb\nc');
    expect(d.changed).toBe(true);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });

  it('detects removed lines', () => {
    const d = diffArtifactVersions('a\nb\nc', 'a');
    expect(d.changed).toBe(true);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(2);
  });
});

describe('autoChangeNote', () => {
  it('returns no change for identical', () => {
    expect(autoChangeNote('x', 'x')).toBe('无变更');
  });

  it('describes added lines', () => {
    expect(autoChangeNote('a', 'a\nb')).toContain('+1 行');
  });

  it('describes removed lines', () => {
    expect(autoChangeNote('a\nb', 'a')).toContain('-1 行');
  });
});

describe('exportArtifactVersion', () => {
  it('exports markdown as text/markdown', () => {
    const blob = exportArtifactVersion({ content: '# hi', type: 'markdown' });
    expect(blob.type).toBe('text/markdown');
  });

  it('exports json as application/json', () => {
    const blob = exportArtifactVersion({ content: '{}', type: 'json' });
    expect(blob.type).toBe('application/json');
  });
});

describe('buildVersionDownloadName', () => {
  it('builds filename with extension', () => {
    const name = buildVersionDownloadName({ title: 'README', type: 'markdown', timestamp: Date.now() });
    expect(name).toMatch(/^README_v1_\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('sanitizes special chars in title', () => {
    const name = buildVersionDownloadName({ title: 'file/name', type: 'code', timestamp: Date.now() });
    expect(name).not.toContain('/');
  });
});
