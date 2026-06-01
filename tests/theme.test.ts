import { describe, it, expect, beforeEach } from 'vitest';
import { initTheme, toggleTheme } from '../src/modules/theme.ts';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('initTheme sets light workbench theme by default', () => {
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('initTheme restores saved theme', () => {
    localStorage.setItem('dc_theme', 'light');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme switches dark to light', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const result = toggleTheme();
    expect(result).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('dc_theme')).toBe('light');
  });

  it('toggleTheme switches light to dark', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const result = toggleTheme();
    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('dc_theme')).toBe('dark');
  });
});
