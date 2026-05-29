/**
 * Workspace Index Report — Index status and search coverage display
 */

export interface CoverageLevel {
  label: string;
  color: string;
  threshold: number;
}

export const COVERAGE_LEVELS: Readonly<Record<string, CoverageLevel>> = Object.freeze({
  high: { label: '高', color: '#10b981', threshold: 0.85 },
  medium: { label: '中', color: '#f59e0b', threshold: 0.5 },
  low: { label: '低', color: '#ef4444', threshold: 0 },
});

export function getCoverageLevel(indexed: number, total: number): CoverageLevel {
  if (total === 0) return COVERAGE_LEVELS.low;
  const ratio = indexed / total;
  if (ratio >= COVERAGE_LEVELS.high.threshold) return COVERAGE_LEVELS.high;
  if (ratio >= COVERAGE_LEVELS.medium.threshold) return COVERAGE_LEVELS.medium;
  return COVERAGE_LEVELS.low;
}

export interface IndexReport {
  indexedFiles: number;
  skippedFiles: number;
  sensitiveFiles: number;
  binaryFiles: number;
  oversizedFiles: number;
  totalFiles: number;
  coverageLevel: CoverageLevel;
  lastUpdated: number | null;
  isIndexing: boolean;
  errors: string[];
  summary: string;
}

export function buildIndexReport(
  opts: {
    indexedFiles?: number;
    skippedFiles?: number;
    sensitiveFiles?: number;
    binaryFiles?: number;
    oversizedFiles?: number;
    lastUpdated?: number | null;
    isIndexing?: boolean;
    errors?: string[];
  } = {}
): IndexReport {
  const {
    indexedFiles = 0,
    skippedFiles = 0,
    sensitiveFiles = 0,
    binaryFiles = 0,
    oversizedFiles = 0,
    lastUpdated = null,
    isIndexing = false,
    errors = [],
  } = opts;

  const total = indexedFiles + skippedFiles;
  const coverage = getCoverageLevel(indexedFiles, total);

  return {
    indexedFiles,
    skippedFiles,
    sensitiveFiles,
    binaryFiles,
    oversizedFiles,
    totalFiles: total,
    coverageLevel: coverage,
    lastUpdated,
    isIndexing,
    errors,
    summary: `已索引：${indexedFiles} 个文件  ·  跳过：${skippedFiles} 个文件  ·  覆盖率：${coverage.label}`,
  };
}

export function renderIndexStatusHtml(report: IndexReport | null): string {
  if (!report) return '';
  const { coverageLevel } = report;

  return `
    <div class="workspace-index-status">
      <div class="index-status-header">
        <span class="index-status-dot" style="background:${coverageLevel.color}"></span>
        <span class="index-status-label">索引覆盖率：${coverageLevel.label}</span>
        ${report.isIndexing ? '<span class="index-status-pulse">索引中…</span>' : ''}
      </div>
      <div class="index-status-grid">
        <div class="index-stat">
          <span class="index-stat-value">${report.indexedFiles}</span>
          <span class="index-stat-label">已索引</span>
        </div>
        <div class="index-stat">
          <span class="index-stat-value">${report.skippedFiles}</span>
          <span class="index-stat-label">已跳过</span>
        </div>
        ${
          report.sensitiveFiles
            ? `
        <div class="index-stat">
          <span class="index-stat-value">${report.sensitiveFiles}</span>
          <span class="index-stat-label">敏感文件</span>
        </div>
        `
            : ''
        }
        ${
          report.oversizedFiles
            ? `
        <div class="index-stat">
          <span class="index-stat-value">${report.oversizedFiles}</span>
          <span class="index-stat-label">超大文件</span>
        </div>
        `
            : ''
        }
      </div>
      ${
        report.errors.length
          ? `
      <div class="index-status-errors">
        ${report.errors.map((e) => `<div class="index-error">⚠ ${e}</div>`).join('')}
      </div>
      `
          : ''
      }
      ${
        report.lastUpdated
          ? `
      <div class="index-status-time">更新于 ${new Date(report.lastUpdated).toLocaleString()}</div>
      `
          : ''
      }
    </div>
  `;
}

export function renderIndexStatus(container: HTMLElement | null, report: IndexReport | null): void {
  if (!container) return;
  container.innerHTML = renderIndexStatusHtml(report);
}

export function shouldIndexFile(
  file: { size: number; isBinary?: boolean; path?: string; name?: string },
  opts: { maxSizeBytes?: number; skipBinary?: boolean; skipPatterns?: RegExp[] } = {}
): { ok: boolean; reason?: string } {
  const { maxSizeBytes = 5 * 1024 * 1024, skipBinary = true, skipPatterns = [] } = opts;

  if (file.size > maxSizeBytes) {
    return { ok: false, reason: 'oversized' };
  }

  if (skipBinary && file.isBinary) {
    return { ok: false, reason: 'binary' };
  }

  for (const pattern of skipPatterns) {
    if (pattern.test(file.path || file.name || '')) {
      return { ok: false, reason: 'pattern' };
    }
  }

  return { ok: true };
}
