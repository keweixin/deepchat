import { describe, expect, it } from 'vitest';
import { renderMarkdown, postProcess } from '../src/modules/renderer.js';
import {
  collectReadingAnchors,
  getAnchorSignature,
  initReadingNavigator,
  refreshReadingNavigator,
} from '../src/modules/reading-navigator.js';

describe('reading navigator anchors', () => {
  it('extracts only the largest heading level from rich assistant content', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`这是一段足够长的摘要说明，用来触发长回答的阅读摘要样式。

## 操作步骤

### 子步骤

1. 定位渲染入口
2. 绑定右侧导航

风险：不要让模型输出任意 HTML 控件。

| 维度 | 方案 A | 方案 B |
| --- | --- | --- |
| 成本 | 低 | 中 |

\`\`\`js
console.log('ok')
\`\`\``);

    await postProcess(root);

    const anchors = collectReadingAnchors(root);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].type).toBe('heading');
    expect(anchors[0].level).toBe(2);
    expect(anchors[0].label).toBe('操作步骤');
  });

  it('keeps stable signatures after ids are assigned', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`## 原因

## 修复

### 细节

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``);

    await postProcess(root);

    const first = collectReadingAnchors(root);
    const second = collectReadingAnchors(root);

    expect(first).toHaveLength(2);
    expect(getAnchorSignature(first)).toBe(getAnchorSignature(second));
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
  });

  it('supports h1 as the largest heading level', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`# 总标题

## 子标题`);

    await postProcess(root);

    const anchors = collectReadingAnchors(root);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].level).toBe(1);
    expect(anchors[0].label).toBe('总标题');
  });

  it('returns no anchors for plain short answers', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('可以，直接这么做。');

    await postProcess(root);

    expect(collectReadingAnchors(root)).toEqual([]);
  });

  it('hides stale navigation when the current conversation has no headings', async () => {
    document.body.innerHTML = `
      <main id="main-content">
        <div id="chat-messages" style="height: 400px; overflow: auto;"></div>
      </main>
    `;
    const messages = document.querySelector('#chat-messages');
    initReadingNavigator();

    messages.innerHTML = `<div class="message assistant"><div class="message-content">${renderMarkdown('## 第一节\n\n内容\n\n## 第二节\n\n内容')}</div></div>`;
    await postProcess(messages.querySelector('.message-content'));
    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelector('.reading-navigator').hidden).toBe(false);
    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(2);

    messages.innerHTML = '';
    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelector('.reading-navigator').hidden).toBe(true);
    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(0);
  });

  it('shows the navigator even when there is only one top-level heading', async () => {
    document.body.innerHTML = `
      <main id="main-content">
        <div id="chat-messages" style="height: 400px; overflow: auto;"></div>
      </main>
    `;
    const messages = document.querySelector('#chat-messages');
    initReadingNavigator();

    messages.innerHTML = `<div class="message assistant"><div class="message-content">${renderMarkdown('## 唯一标题\n\n内容')}</div></div>`;
    await postProcess(messages.querySelector('.message-content'));
    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelector('.reading-navigator').hidden).toBe(false);
    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(1);
    expect(document.querySelector('.reading-nav-counter').textContent).toBe('1 个标题');
  });

  it('does not rebuild the outline during scroll-only updates', async () => {
    document.body.innerHTML = `
      <main id="main-content">
        <div id="chat-messages" style="height: 400px; overflow: auto;"></div>
      </main>
    `;
    const messages = document.querySelector('#chat-messages');
    initReadingNavigator();

    messages.innerHTML = `<div class="message assistant"><div class="message-content">${renderMarkdown('## 第一节\n\n内容')}</div></div>`;
    await postProcess(messages.querySelector('.message-content'));
    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(1);

    messages.querySelector('.message-content').insertAdjacentHTML('beforeend', renderMarkdown('## 第二节\n\n内容'));
    messages.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(1);

    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.querySelectorAll('.reading-nav-item')).toHaveLength(2);
  });

  it('keeps a compact expandable navigator on small viewports', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true }) as MediaQueryList;
    document.body.innerHTML = `
      <main id="main-content">
        <div id="chat-messages" style="height: 400px; overflow: auto;"></div>
      </main>
    `;
    const messages = document.querySelector('#chat-messages');
    initReadingNavigator();

    messages.innerHTML = `<div class="message assistant"><div class="message-content">${renderMarkdown('## 第一节\n\n内容')}</div></div>`;
    await postProcess(messages.querySelector('.message-content'));
    refreshReadingNavigator();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const nav = document.querySelector('.reading-navigator');
    expect(nav.hidden).toBe(false);
    nav.querySelector('.reading-nav-collapse').click();
    expect(nav.classList.contains('is-mobile-open')).toBe(true);

    window.matchMedia = originalMatchMedia;
  });
});
