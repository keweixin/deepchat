// @ts-nocheck
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('composer layout', () => {
  it('keeps advanced send options inside the collapsible options group', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const start = html.indexOf('<div id="composer-advanced-options"');
    const end = html.indexOf('<div class="composer-chip-row"', start);
    const advanced = html.slice(start, end);

    expect(html).toContain('id="composer-advanced-toggle"');
    expect(html).toContain('aria-controls="composer-advanced-options"');
    expect(advanced).toContain('composer-thinking-select');
    expect(advanced).toContain('composer-tool-drawer-btn');
    expect(advanced).toContain('composer-web-search-toggle');
    expect(advanced).toContain('composer-enhance-toggle');
    expect(advanced).toContain('composer-template-btn');
    expect(advanced).toContain('composer-settings-shortcut');
  });

  it('exposes high-frequency context chips in the first composer row', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const start = html.indexOf('<div class="composer-chip-row"');
    const end = html.indexOf('<div id="composer-context-preview"', start);
    const chipRow = html.slice(start, end);

    expect(chipRow).toContain('data-context-chip="file"');
    expect(chipRow).toContain('data-context-chip="folder"');
    expect(chipRow).toContain('data-context-chip="symbol"');
    expect(chipRow).toContain('data-context-chip="changed"');
    expect(chipRow).toContain('data-context-chip="web"');
    expect(chipRow).toContain('data-context-chip="run"');
  });
});
