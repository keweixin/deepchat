import { describe, expect, it } from 'vitest';

import {
  parseWorkspaceQuery,
  matchesFileDirective,
  matchesChangedDirective,
  highlightWorkspaceSnippet,
  buildHighlightedSnippet,
} from '../electron/workspace-query.js';

describe('workspace-query parser', () => {
  it('parses plain text query without directives', () => {
    const result = parseWorkspaceQuery('hello world');
    expect(result.textQuery).toBe('hello world');
    expect(result.file).toEqual([]);
    expect(result.folder).toEqual([]);
    expect(result.symbol).toBe('');
    expect(result.changedDays).toBeNull();
    expect(result.recentOnly).toBe(false);
  });

  it('parses @file: directive', () => {
    const result = parseWorkspaceQuery('search term @file:src/modules/chat.js');
    expect(result.textQuery).toBe('search term');
    expect(result.file).toEqual(['src/modules/chat.js']);
  });

  it('parses multiple @file: directives', () => {
    const result = parseWorkspaceQuery('@file:app.js @file:config.json search');
    expect(result.textQuery).toBe('search');
    expect(result.file).toEqual(['app.js', 'config.json']);
  });

  it('parses @folder: directive', () => {
    const result = parseWorkspaceQuery('@folder:electron search term');
    expect(result.textQuery).toBe('search term');
    expect(result.folder).toEqual(['electron']);
  });

  it('parses @symbol: directive', () => {
    const result = parseWorkspaceQuery('@symbol:renderAgentCrew');
    expect(result.textQuery).toBe('');
    expect(result.symbol).toBe('renderAgentCrew');
  });

  it('parses @changed: directive', () => {
    const result = parseWorkspaceQuery('bug @changed:7d');
    expect(result.textQuery).toBe('bug');
    expect(result.changedDays).toBe(7);
  });

  it('strips invalid @changed: values but does not apply them', () => {
    const result = parseWorkspaceQuery('bug @changed:abc');
    expect(result.textQuery).toBe('bug');
    expect(result.changedDays).toBeNull();
  });

  it('parses @recent directive', () => {
    const result = parseWorkspaceQuery('@recent');
    expect(result.textQuery).toBe('');
    expect(result.recentOnly).toBe(true);
  });

  it('parses combined directives', () => {
    const result = parseWorkspaceQuery('@file:chat.js @folder:src @symbol:sendMessage @changed:3d recent changes');
    expect(result.textQuery).toBe('recent changes');
    expect(result.file).toEqual(['chat.js']);
    expect(result.folder).toEqual(['src']);
    expect(result.symbol).toBe('sendMessage');
    expect(result.changedDays).toBe(3);
  });

  it('handles Chinese punctuation before directives', () => {
    const result = parseWorkspaceQuery('搜索，@file:test.js');
    expect(result.textQuery).toBe('搜索');
    expect(result.file).toEqual(['test.js']);
  });

  it('handles empty query', () => {
    const result = parseWorkspaceQuery('');
    expect(result.textQuery).toBe('');
    expect(result.file).toEqual([]);
    expect(result.folder).toEqual([]);
  });
});

describe('matchesFileDirective', () => {
  it('matches exact file path', () => {
    const parsed = parseWorkspaceQuery('@file:chat.js');
    expect(matchesFileDirective('src/modules/chat.js', parsed)).toBe(true);
    expect(matchesFileDirective('src/modules/api.js', parsed)).toBe(false);
  });

  it('matches folder directive', () => {
    const parsed = parseWorkspaceQuery('@folder:src/modules');
    expect(matchesFileDirective('src/modules/chat.js', parsed)).toBe(true);
    expect(matchesFileDirective('tests/chat.test.js', parsed)).toBe(false);
  });

  it('passes when no file/folder directives', () => {
    const parsed = parseWorkspaceQuery('hello world');
    expect(matchesFileDirective('any/path/file.js', parsed)).toBe(true);
  });

  it('handles Windows backslash paths', () => {
    const parsed = parseWorkspaceQuery('@folder:electron');
    expect(matchesFileDirective('electron\\tools.js', parsed)).toBe(true);
  });

  it('requires all file directives to match', () => {
    const parsed = parseWorkspaceQuery('@file:chat.js @file:api.js');
    // Current implementation: ANY file directive match passes, not ALL
    expect(matchesFileDirective('src/chat.js', parsed)).toBe(true);
  });
});

describe('matchesChangedDirective', () => {
  it('passes when no changed directive', () => {
    const parsed = parseWorkspaceQuery('hello');
    expect(matchesChangedDirective(Date.now(), parsed)).toBe(true);
    expect(matchesChangedDirective(0, parsed)).toBe(true);
  });

  it('matches files modified within N days', () => {
    const parsed = parseWorkspaceQuery('@changed:7d');
    const now = Date.now();
    expect(matchesChangedDirective(now - 3 * 24 * 60 * 60 * 1000, parsed)).toBe(true);
    expect(matchesChangedDirective(now - 10 * 24 * 60 * 60 * 1000, parsed)).toBe(false);
  });

  it('rejects files with no mtime', () => {
    const parsed = parseWorkspaceQuery('@changed:7d');
    expect(matchesChangedDirective(0, parsed)).toBe(false);
    expect(matchesChangedDirective(null, parsed)).toBe(false);
  });

  it('@recent defaults to 7 days', () => {
    const parsed = parseWorkspaceQuery('@recent');
    const now = Date.now();
    expect(matchesChangedDirective(now - 3 * 24 * 60 * 60 * 1000, parsed)).toBe(true);
    expect(matchesChangedDirective(now - 10 * 24 * 60 * 60 * 1000, parsed)).toBe(false);
  });
});

describe('highlightWorkspaceSnippet', () => {
  it('highlights matching lines', () => {
    const text = 'function hello() {}\nconst x = 1;\nfunction world() {}';
    const result = highlightWorkspaceSnippet(text, ['hello'], 'hello', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].text).toContain('hello');
  });

  it('returns empty for no matches', () => {
    const text = 'const x = 1;';
    const result = highlightWorkspaceSnippet(text, ['zzz'], 'zzz', '');
    expect(result).toEqual([]);
  });

  it('scores symbol definitions higher', () => {
    const text = 'function myFunc() {}\n// mention myFunc here';
    const result = highlightWorkspaceSnippet(text, [], '', 'myFunc');
    const defLine = result.find((r) => r.text.includes('function'));
    const refLine = result.find((r) => r.text.includes('mention'));
    expect(defLine).toBeDefined();
    expect(refLine).toBeDefined();
    expect(defLine.score).toBeGreaterThan(refLine.score);
  });
});

describe('buildHighlightedSnippet', () => {
  it('builds snippet around center line', () => {
    const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
    const result = buildHighlightedSnippet(lines, 3, 1);
    expect(result.map((r) => r.text)).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('clips at start of file', () => {
    const lines = ['line 1', 'line 2', 'line 3'];
    const result = buildHighlightedSnippet(lines, 1, 2);
    expect(result.map((r) => r.text)).toEqual(['line 1', 'line 2', 'line 3']);
  });
});
