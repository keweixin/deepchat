/**
 * Release Utils — Version management and CHANGELOG helpers
 */

export const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  build: string;
}

export function parseSemver(version: string): Semver | null {
  const match = String(version).match(SEMVER_REGEX);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || '',
    build: match[5] || '',
  };
}

export function compareSemver(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return String(a).localeCompare(String(b));

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }

  // Prerelease: no prerelease > any prerelease
  if (!va.prerelease && vb.prerelease) return 1;
  if (va.prerelease && !vb.prerelease) return -1;
  if (va.prerelease && vb.prerelease) {
    return va.prerelease.localeCompare(vb.prerelease);
  }

  return 0;
}

export function bumpVersion(version: string, type: 'major' | 'minor' | 'patch' = 'patch'): string {
  const v = parseSemver(version);
  if (!v) return version;
  if (type === 'major') return `${v.major + 1}.0.0`;
  if (type === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

export interface ChangelogOpts {
  version?: string;
  date?: string;
  sections?: Record<string, string[]>;
}

export function generateChangelogEntry(opts: ChangelogOpts = {}): string {
  const { version = '1.0.0', date = new Date().toISOString().slice(0, 10), sections = {} } = opts;

  const parts = [`## [${version}] - ${date}\n`];

  if (sections.added?.length) {
    parts.push('### Added\n');
    for (const item of sections.added) parts.push(`- ${item}\n`);
  }
  if (sections.changed?.length) {
    parts.push('### Changed\n');
    for (const item of sections.changed) parts.push(`- ${item}\n`);
  }
  if (sections.fixed?.length) {
    parts.push('### Fixed\n');
    for (const item of sections.fixed) parts.push(`- ${item}\n`);
  }
  if (sections.removed?.length) {
    parts.push('### Removed\n');
    for (const item of sections.removed) parts.push(`- ${item}\n`);
  }
  if (sections.security?.length) {
    parts.push('### Security\n');
    for (const item of sections.security) parts.push(`- ${item}\n`);
  }

  return parts.join('\n');
}

export interface ReleaseNotesOpts {
  version: string;
  changes?: string[];
  contributors?: string[];
  assets?: string[];
}

export function buildReleaseNotes(opts: ReleaseNotesOpts = { version: '' }): string {
  const { version, changes = [], contributors = [], assets = [] } = opts;

  const lines = [`# DeepChat v${version} Release Notes`, '', '## Highlights', ...changes.map((c) => `- ${c}`), ''];

  if (contributors.length) {
    lines.push('## Contributors', ...contributors.map((c) => `- ${c}`), '');
  }

  if (assets.length) {
    lines.push('## Assets', ...assets.map((a) => `- ${a}`), '');
  }

  lines.push(
    '## Checklist',
    '- [ ] Tests pass',
    '- [ ] Build succeeds',
    '- [ ] CHANGELOG updated',
    '- [ ] Version bumped',
    ''
  );

  return lines.join('\n');
}

export function isValidVersion(version: string): boolean {
  return SEMVER_REGEX.test(String(version));
}
