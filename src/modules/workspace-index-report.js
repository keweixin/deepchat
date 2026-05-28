/**
 * Workspace Index Report — Index status and search coverage display
 *
 * Features:
 * - Indexed file count, skipped count, sensitive file count
 * - Search coverage level (high/medium/low)
 * - Last update timestamp
 * - Incremental index status (file hash + mtime)
 */

export const COVERAGE_LEVELS = Object.freeze({
  high: { label: '高', color: '#10b981', threshold: 0.85 },
  medium: { label: '中', color: '#f59e0b', threshold: 0.5 },
  low: { label: '低', color: '#ef4444', threshold: 0 },
});

/**
 * Calculate search coverage level based on index ratio
 * @param {number} indexed
 * @param {number} total
 * @returns {Object}
 */
export function getCoverageLevel(indexed, total) {
  if (total === 0) return COVERAGE_LEVELS.low;
  const ratio = indexed / total;
  if (ratio >= COVERAGE_LEVELS.high.threshold) return COVERAGE_LEVELS.high;
  if (ratio >= COVERAGE_LEVELS.medium.threshold) return COVERAGE_LEVELS.medium;
  return COVERAGE_LEVELS.low;
}

/**
 * Build index status report
 * @param {Object} opts
 * @returns {Object}
 */
export function buildIndexReport(opts = {}) {
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

/**
 * Render index status as HTML string
 * @param {Object} report
 * @returns {string}
 */
export function renderIndexStatusHtml(report) {
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

/**
 * Render index status into a DOM container
 * @param {HTMLElement|null} container
 * @param {Object} report
 */
export function renderIndexStatus(container, report) {
  if (!container) return;
  container.innerHTML = renderIndexStatusHtml(report);
}

/**
 * Check if a file should be indexed based on rules
 * @param {Object} file
 * @param {Object} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
export function shouldIndexFile(file, opts = {}) {
  const { maxSizeBytes = 5 * 1024 * 1024, skipBinary = true, skipPatterns = [] } = opts;

  if (file.size > maxSizeBytes) {
    return { ok: false, reason: 'oversized' };
  }

  if (skipBinary && file.isBinary) {
    return { ok: false, reason: 'binary' };
  }

  for (const pattern of skipPatterns) {
    if (pattern.test(file.path || file.name)) {
      return { ok: false, reason: 'pattern' };
    }
  }

  return { ok: true };
}
