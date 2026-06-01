import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('composer layout', () => {
  it('keeps static buttons from accidentally submitting forms', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const buttonsWithoutType = html.match(/<button(?![^>]*\btype=)[^>]*>/g) || [];

    expect(buttonsWithoutType).toEqual([]);
  });

  it('keeps primary runtime-created chat buttons from defaulting to submit', () => {
    const main = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    const chat = fs.readFileSync(path.resolve('src/modules/chat.ts'), 'utf8');
    const sidebar = fs.readFileSync(path.resolve('src/modules/chat-sidebar.ts'), 'utf8');

    expect(main).toContain("scrollFab.type = 'button'");
    expect(sidebar).toContain('<button type="button" class="conv-menu-trigger');
    expect(chat).toContain("copyBtn.type = 'button'");
    expect(chat).toContain("editBtn.type = 'button'");
    expect(chat).toContain("delBtn.type = 'button'");
    expect(chat).toContain("regenBtn.type = 'button'");
    expect(chat).toContain("detailBtn.type = 'button'");
  });

  it('keeps hidden context preview out of visual and accessibility snapshots', () => {
    const css = fs.readFileSync(path.resolve('src/styles/chat-input.css'), 'utf8');

    expect(css).toContain('.composer-context-preview[hidden]');
    expect(css).toContain('.composer-context-preview[hidden]::before');
    expect(css).toContain('content: none');
  });

  it('keeps collapsed advanced composer controls hidden from accessibility snapshots', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const css = fs.readFileSync(path.resolve('src/styles/chat-input.css'), 'utf8');
    const main = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');

    expect(html).toContain('id="composer-advanced-options"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('hidden');
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('.composer-advanced-options[hidden]');
    expect(main).toContain('$advancedOptions.hidden = !expanded');
    expect(main).toContain("setAttribute('aria-hidden', expanded ? 'false' : 'true')");
  });

  it('keeps advanced send options inside the collapsible options group', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const advanced = html.match(/<div[^>]+id="composer-advanced-options"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';

    expect(html).toContain('id="composer-advanced-toggle"');
    expect(html).toContain('aria-controls="composer-advanced-options"');
    expect(advanced).toContain('composer-thinking-select');
    expect(advanced).toContain('composer-web-search-toggle');
    expect(advanced).toContain('composer-enhance-toggle');
    expect(advanced).not.toContain('composer-settings-shortcut');
    expect(html).not.toContain('id="composer-settings-shortcut"');
    // Tool drawer and template are now in the primary toolbar row
    expect(advanced).not.toContain('composer-tool-drawer-btn');
    expect(advanced).not.toContain('composer-template-btn');
  });

  it('exposes primary toolbar buttons in the first composer row', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const start = html.indexOf('<div class="composer-toolbar"');
    const end = html.indexOf('<div id="composer-advanced-options"', start);
    const toolbar = html.slice(start, end > start ? end : undefined);

    expect(toolbar).toContain('composer-mode-select');
    expect(toolbar).toContain('composer-chip-toggle');
    expect(toolbar).toContain('composer-tool-drawer-btn');
    expect(toolbar).toContain('composer-template-btn');
    expect(toolbar).toContain('composer-advanced-toggle');
    expect(toolbar).not.toContain('composer-mode-pills');
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

  it('keeps the composer context preview to a single scrollable row', () => {
    const css = fs.readFileSync(path.resolve('src/styles/chat-input.css'), 'utf8');
    const rule = css.slice(
      css.indexOf('.composer-context-preview {'),
      css.indexOf('.composer-context-preview::before {')
    );

    expect(rule).toContain('flex-wrap: nowrap');
    expect(rule).toContain('overflow-x: auto');
    expect(rule).toContain('max-height: 36px');
    expect(css).toContain('.composer-context-preview[hidden]');
    expect(css).toContain('display: none !important');
  });
});
