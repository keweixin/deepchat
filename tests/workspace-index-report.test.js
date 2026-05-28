/**
 * Workspace Index Report Tests
 */

import { describe, it, expect } from 'vitest';
import {
  COVERAGE_LEVELS,
  getCoverageLevel,
  buildIndexReport,
  renderIndexStatusHtml,
  shouldIndexFile,
} from '../src/modules/workspace-index-report.js';

describe('getCoverageLevel', () => {
  it('returns high for 90% coverage', () => {
    expect(getCoverageLevel(90, 100).label).toBe('高');
  });

  it('returns medium for 60% coverage', () => {
    expect(getCoverageLevel(60, 100).label).toBe('中');
  });

  it('returns low for 30% coverage', () => {
    expect(getCoverageLevel(30, 100).label).toBe('低');
  });

  it('returns low for zero total', () => {
    expect(getCoverageLevel(0, 0).label).toBe('低');
  });
});

describe('buildIndexReport', () => {
  it('builds report with defaults', () => {
    const report = buildIndexReport();
    expect(report.indexedFiles).toBe(0);
    expect(report.totalFiles).toBe(0);
    expect(report.coverageLevel).toBe(COVERAGE_LEVELS.low);
  });

  it('calculates coverage correctly', () => {
    const report = buildIndexReport({ indexedFiles: 850, skippedFiles: 150 });
    expect(report.totalFiles).toBe(1000);
    expect(report.coverageLevel.label).toBe('高');
    expect(report.summary).toContain('850');
  });

  it('includes errors', () => {
    const report = buildIndexReport({ errors: ['path too long'] });
    expect(report.errors).toContain('path too long');
  });

  it('shows indexing state', () => {
    const report = buildIndexReport({ isIndexing: true });
    expect(report.isIndexing).toBe(true);
  });
});

describe('renderIndexStatusHtml', () => {
  it('renders HTML for report', () => {
    const html = renderIndexStatusHtml(buildIndexReport({ indexedFiles: 100, skippedFiles: 20 }));
    expect(html).toContain('workspace-index-status');
    expect(html).toContain('100');
    expect(html).toContain('20');
  });

  it('renders errors section when present', () => {
    const html = renderIndexStatusHtml(buildIndexReport({ errors: ['fail'] }));
    expect(html).toContain('index-status-errors');
  });

  it('renders last updated time', () => {
    const html = renderIndexStatusHtml(buildIndexReport({ lastUpdated: Date.now() }));
    expect(html).toContain('更新于');
  });

  it('returns empty string for null', () => {
    expect(renderIndexStatusHtml(null)).toBe('');
  });
});

describe('shouldIndexFile', () => {
  it('approves normal text file', () => {
    expect(shouldIndexFile({ size: 1000, isBinary: false }).ok).toBe(true);
  });

  it('rejects oversized file', () => {
    const result = shouldIndexFile({ size: 10 * 1024 * 1024, isBinary: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('oversized');
  });

  it('rejects binary file', () => {
    const result = shouldIndexFile({ size: 1000, isBinary: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binary');
  });

  it('rejects file matching skip pattern', () => {
    const result = shouldIndexFile(
      { size: 100, isBinary: false, path: 'node_modules/x.js' },
      {
        skipPatterns: [/node_modules/],
      }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pattern');
  });
});
