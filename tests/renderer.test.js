import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderMarkdown, postProcess } from '../src/modules/renderer.js';

describe('renderer security and widgets', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('renders raw HTML as text instead of interactive UI', () => {
    const html = renderMarkdown('<button style="color:red" onclick="alert(1)">click</button><input style="color:red" onfocus="alert(1)">');
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).toContain('&lt;button');
    expect(html).toContain('&lt;input');
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('input')).toBeNull();
    expect(root.querySelector('[onclick]')).toBeNull();
    expect(root.querySelector('[onfocus]')).toBeNull();
    expect(root.querySelector('[style]')).toBeNull();
  });

  it('renders a widget JSON block and supports negative bar values', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`\`\`\`widget
{ "type": "bar-chart", "data": [{ "label": "Loss", "value": -5 }, { "label": "Gain", "value": 10 }] }
\`\`\``);

    await postProcess(root);

    expect(root.querySelector('.dc-widget')).toBeTruthy();
    expect(root.querySelector('.dc-chart-zero')).toBeTruthy();
    const bars = [...root.querySelectorAll('.dc-chart-mark')];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(Number(bar.getAttribute('height'))).toBeGreaterThan(0);
      expect(Number.isFinite(Number(bar.getAttribute('y')))).toBe(true);
    }
  });

  it('renders markdown images as zoomable media blocks', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('![总览图](https://example.com/map.png)');
    document.body.appendChild(root);

    await postProcess(root);

    const frame = root.querySelector('.markdown-media-frame');
    const image = root.querySelector('img.is-zoomable-media');
    expect(frame).toBeTruthy();
    expect(image).toBeTruthy();
    expect(image.getAttribute('role')).toBe('button');

    image.click();

    const viewer = document.querySelector('.media-viewer');
    expect(viewer).toBeTruthy();
    expect(viewer.hidden).toBe(false);
    expect(viewer.querySelector('.media-viewer-title').textContent).toContain('总览图');
  });

  it('only highlights explicit conclusion-style paragraphs', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('这是一个普通开场段落，长度足够但不应该被套成固定卡片。\n\n结论：这里才是需要强调的摘要。');

    await postProcess(root);

    const paragraphs = root.querySelectorAll('p');
    expect(paragraphs[0].classList.contains('answer-lead')).toBe(false);
    expect(paragraphs[1].classList.contains('answer-note')).toBe(true);
    expect(paragraphs[1].classList.contains('answer-callout')).toBe(true);
    expect(paragraphs[1].dataset.calloutType).toBe('conclusion');
  });

  it('classifies short answers without forcing a summary block', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('可以，短问题直接给结论，不需要套固定小标题。');

    await postProcess(root);

    expect(root.classList.contains('answer-short')).toBe(true);
    expect(root.classList.contains('answer-long')).toBe(false);
    expect(root.querySelector('.answer-summary')).toBeNull();
  });

  it('classifies troubleshooting, report, and source-heavy answers', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`## 原因

报错说明：接口请求失败。

## 如何验证

按步骤复现并检查日志。`);
    await postProcess(root);
    expect(root.classList.contains('answer-troubleshoot')).toBe(true);

    const reportRoot = document.createElement('div');
    reportRoot.innerHTML = renderMarkdown(`这是一段摘要，说明本次分析结论。

## 依据

这里列出判断依据。

## 风险

这里列出风险。

## 建议

这里列出建议。`);
    await postProcess(reportRoot);
    expect(reportRoot.classList.contains('answer-report')).toBe(true);

    const sourceRoot = document.createElement('div');
    sourceRoot.innerHTML = renderMarkdown('来源：[A](https://example.com/a) 和 [B](https://example.com/b)。');
    await postProcess(sourceRoot);
    expect(sourceRoot.classList.contains('answer-sourced')).toBe(true);
  });

  it('turns the first concise paragraph of a long answer into a summary', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`这次问题的核心是渲染层缺少语义分层，需要让样式跟随内容类型变化。

## 原因
当前段落、列表、表格和代码块都使用同一套节奏。

## 改法
识别摘要、步骤、风险和表格类型，再使用更克制的视觉层次。

## 验证
通过单元测试和浏览器冒烟确认没有破坏安全边界。`);

    await postProcess(root);

    expect(root.classList.contains('answer-long')).toBe(true);
    expect(root.querySelector('p').classList.contains('answer-summary')).toBe(true);
  });

  it('maps semantic callout labels to stable types', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`风险：不要允许模型输出任意 HTML。

来源：基于当前项目源码检查。

下一步：补测试后再改样式。

不适用：不要把所有段落都卡片化。`);

    await postProcess(root);

    const callouts = [...root.querySelectorAll('.answer-callout')];
    expect(callouts.map((node) => node.dataset.calloutType)).toEqual(['risk', 'source', 'next', 'avoid']);
  });

  it('detects procedural ordered lists and checklist lists', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`## 操作步骤

1. 定位渲染入口
2. 添加语义分类
3. 验证浏览器效果

- [x] Markdown 安全
- [ ] 移动端检查`);

    await postProcess(root);

    expect(root.classList.contains('answer-tutorial')).toBe(true);
    expect(root.querySelector('ol').classList.contains('answer-steps')).toBe(true);
    expect(root.querySelector('ul').classList.contains('answer-checklist')).toBe(true);
  });

  it('classifies compare and key-value tables', async () => {
    const compareRoot = document.createElement('div');
    compareRoot.innerHTML = renderMarkdown(`| 维度 | 方案 A | 方案 B |
| --- | --- | --- |
| 适用 | 快速实现 | 长期维护 |`);

    await postProcess(compareRoot);

    const compareTable = compareRoot.querySelector('.markdown-table-wrap');
    expect(compareRoot.classList.contains('answer-compare')).toBe(true);
    expect(compareTable.dataset.tableKind).toBe('compare');

    const kvRoot = document.createElement('div');
    kvRoot.innerHTML = renderMarkdown(`| 参数 | 值 |
| --- | --- |
| 模型 | deepseek-v4-flash |
| 温度 | 0.7 |`);

    await postProcess(kvRoot);

    expect(kvRoot.querySelector('.markdown-table-wrap').dataset.tableKind).toBe('kv');
  });

  it('does not classify Mermaid flowchart descriptions as tutorials without steps', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`下面用流程图表达渲染路径。

\`\`\`mermaid
flowchart LR
  A[Markdown] --> B[DOMPurify]
\`\`\``);

    await postProcess(root);

    expect(root.classList.contains('answer-visual')).toBe(true);
    expect(root.classList.contains('answer-tutorial')).toBe(false);
  });

  it('dispatches code run requests instead of evaluating code in the renderer', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('```js\nconsole.log("ok")\n```');
    document.body.appendChild(root);

    let detail;
    document.addEventListener('deepchat:run-code-block', (event) => {
      detail = event.detail;
    }, { once: true });

    await postProcess(root);
    root.querySelector('.code-run-btn').click();

    expect(detail.code).toContain('console.log');
    expect(detail.language).toBe('javascript');
  });

  it('keeps renderer source free of direct eval/new Function execution', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/renderer.js'), 'utf8');
    const chatSource = fs.readFileSync(path.join(process.cwd(), 'src/modules/chat.js'), 'utf8');

    expect(source).not.toMatch(/eval\(|new Function|executeJavaScript/);
    expect(chatSource).not.toMatch(/eval\(|new Function|executeJavaScript/);
  });

  it('adds CSV export controls to rendered markdown tables', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(`| 参数 | 值 |
| --- | --- |
| 模型 | deepchat |`);

    await postProcess(root);

    expect(root.querySelector('.table-export-btn')).toBeTruthy();
  });
});
