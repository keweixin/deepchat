/**
 * Release Utils Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parseSemver,
  compareSemver,
  bumpVersion,
  generateChangelogEntry,
  buildReleaseNotes,
  isValidVersion,
} from '../src/modules/release-utils.js';

describe('parseSemver', () => {
  it('parses simple version', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '', build: '' });
  });

  it('parses prerelease', () => {
    expect(parseSemver('1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: 'beta.1', build: '' });
  });

  it('parses build metadata', () => {
    expect(parseSemver('1.0.0+20240101')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: '', build: '20240101' });
  });

  it('returns null for invalid', () => {
    expect(parseSemver('v1.0')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('1.0.0 < 2.0.0', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('1.1.0 > 1.0.0', () => {
    expect(compareSemver('1.1.0', '1.0.0')).toBe(1);
  });

  it('1.0.0 == 1.0.0', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('1.0.0 > 1.0.0-beta', () => {
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBe(1);
  });
});

describe('bumpVersion', () => {
  it('bumps patch', () => {
    expect(bumpVersion('1.2.3')).toBe('1.2.4');
  });

  it('bumps minor', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  it('bumps major', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });
});

describe('generateChangelogEntry', () => {
  it('generates entry with sections', () => {
    const entry = generateChangelogEntry({
      version: '1.4.0',
      date: '2026-05-27',
      sections: {
        added: ['Feature A'],
        fixed: ['Bug B'],
      },
    });
    expect(entry).toContain('## [1.4.0] - 2026-05-27');
    expect(entry).toContain('### Added');
    expect(entry).toContain('- Feature A');
    expect(entry).toContain('### Fixed');
  });
});

describe('buildReleaseNotes', () => {
  it('builds notes with changes', () => {
    const notes = buildReleaseNotes({ version: '1.4.0', changes: ['New feature'] });
    expect(notes).toContain('DeepChat v1.4.0');
    expect(notes).toContain('New feature');
  });
});

describe('isValidVersion', () => {
  it('accepts valid semver', () => {
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('0.0.1')).toBe(true);
  });

  it('rejects invalid', () => {
    expect(isValidVersion('v1.0')).toBe(false);
    expect(isValidVersion('1.0')).toBe(false);
  });
});
