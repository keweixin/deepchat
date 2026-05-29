/**
 * Artifact Versions — Version management for extracted artifacts
 *
 * Features:
 * - Save artifact versions with timestamp and change note
 * - Diff between versions
 * - Export specific version
 */

export const ARTIFACT_TYPES = Object.freeze(['markdown', 'code', 'mermaid', 'json', 'csv', 'html', 'diff', 'svg']);

/**
 * Create a version record for an artifact
 * @param {Object} artifact
 * @param {Object} [meta]
 * @returns {Object}
 */
export function createArtifactVersion(artifact: Record<string, any>, meta: Record<string, any> = {}) {
  return {
    id: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    content: artifact.content || '',
    type: artifact.type || 'code',
    language: artifact.language || '',
    title: artifact.title || 'Untitled',
    changeNote: meta.changeNote || '',
    sourceMessageId: meta.sourceMessageId || '',
  };
}

/**
 * Build a version history store
 * @returns {Object} store API
 */
export function createArtifactVersionStore() {
  const versions = new Map(); // artifactKey -> version[]

  function getKey(artifact: Record<string, any>) {
    return artifact.title || artifact.id || 'default';
  }

  function add(artifact: Record<string, any>, meta: Record<string, any> = {}) {
    const key = getKey(artifact);
    const version = createArtifactVersion(artifact, meta);
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push(version);
    return version;
  }

  function getHistory(key: string) {
    return versions.get(key) || [];
  }

  function getLatest(key: string) {
    const hist = versions.get(key);
    return hist ? hist[hist.length - 1] : null;
  }

  function getVersion(key: string, versionId: string) {
    const hist = versions.get(key);
    if (!hist) return null;
    return hist.find((v: Record<string, any>) => v.id === versionId) || null;
  }

  function getAllKeys() {
    return [...versions.keys()];
  }

  function remove(key: string, versionId: string) {
    const hist = versions.get(key);
    if (!hist) return false;
    const idx = hist.findIndex((v: Record<string, any>) => v.id === versionId);
    if (idx >= 0) {
      hist.splice(idx, 1);
      if (hist.length === 0) versions.delete(key);
      return true;
    }
    return false;
  }

  function clear() {
    versions.clear();
  }

  return { add, getHistory, getLatest, getVersion, getAllKeys, remove, clear };
}

/**
 * Compute a simple diff summary between two version contents
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {{added: number, removed: number, changed: boolean}}
 */
export function diffArtifactVersions(oldContent: string, newContent: string) {
  const oldLines = String(oldContent || '').split('\n');
  const newLines = String(newContent || '').split('\n');
  const removed = Math.max(0, oldLines.length - newLines.length);
  const added = Math.max(0, newLines.length - oldLines.length);
  const changed = oldContent !== newContent;
  return { added, removed, changed, oldLineCount: oldLines.length, newLineCount: newLines.length };
}

/**
 * Generate change note from diff
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {string}
 */
export function autoChangeNote(oldContent: string, newContent: string) {
  const { added, removed, changed } = diffArtifactVersions(oldContent, newContent);
  if (!changed) return '无变更';
  const parts = [];
  if (added > 0) parts.push(`+${added} 行`);
  if (removed > 0) parts.push(`-${removed} 行`);
  return parts.join('，') || '内容已修改';
}

/**
 * Export artifact version as downloadable blob
 * @param {Object} version
 * @returns {Blob}
 */
export function exportArtifactVersion(version: Record<string, any>) {
  const typeMap = {
    markdown: 'text/markdown',
    code: 'text/plain',
    mermaid: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    diff: 'text/plain',
    svg: 'image/svg+xml',
  };
  const mime = typeMap[version.type as keyof typeof typeMap] || 'text/plain';
  return new Blob([version.content], { type: mime });
}

/**
 * Build download filename for a version
 * @param {Object} version
 * @param {number} [index=0]
 * @returns {string}
 */
export function buildVersionDownloadName(version: Record<string, any>, index = 0) {
  const extMap = {
    markdown: 'md',
    code: 'txt',
    mermaid: 'mmd',
    json: 'json',
    csv: 'csv',
    html: 'html',
    diff: 'diff',
    svg: 'svg',
  };
  const ext = extMap[version.type as keyof typeof extMap] || 'txt';
  const safeTitle = String(version.title || 'artifact').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
  return `${safeTitle}_v${index + 1}_${new Date(version.timestamp).toISOString().slice(0, 10)}.${ext}`;
}
