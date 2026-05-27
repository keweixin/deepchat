import { describe, expect, it } from 'vitest';
import {
  buildArtifactDownloadName,
  createSandboxedHtmlDocument,
  extractArtifacts,
  extractHtmlArtifacts,
  getArtifactTypeLabel,
} from '../src/modules/artifacts.js';

describe('artifact helpers', () => {
  it('extracts bounded HTML code blocks as artifacts (legacy)', () => {
    const artifacts = extractHtmlArtifacts(
      [
        '普通说明',
        '```html',
        '<main><h1>Demo</h1><script>alert(1)</script></main>',
        '```',
        '```js',
        'console.log("ignored")',
        '```',
      ].join('\n')
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      type: 'html-preview',
      title: 'HTML 预览',
      scriptCount: 1,
      security: {
        sandbox: 'iframe sandbox',
        scripts: 'disabled',
      },
    });
    expect(artifacts[0].source).toContain('<main>');
  });

  it('wraps previews with a script-blocking CSP', () => {
    const doc = createSandboxedHtmlDocument('<button onclick="alert(1)">x</button><script>alert(2)</script>');

    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain('<button onclick="alert(1)">x</button>');
  });

  it('injects CSP into full HTML documents without nesting a second document', () => {
    const doc = createSandboxedHtmlDocument('<!doctype html><html><head><title>x</title></head><body>ok</body></html>');

    expect(doc.match(/<!doctype html/gi)).toHaveLength(1);
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc).toContain('Content-Security-Policy');
  });

  it('builds stable download names', () => {
    expect(buildArtifactDownloadName({ title: 'HTML 预览' }, 1)).toBe('html-预览-2.html');
  });

  describe('extractArtifacts (unified)', () => {
    it('extracts mermaid diagrams', () => {
      const artifacts = extractArtifacts('```mermaid\ngraph TD;\nA-->B;\n```');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]).toMatchObject({ type: 'mermaid', title: 'Mermaid 图表' });
    });

    it('extracts JSON data blocks', () => {
      const artifacts = extractArtifacts('```json\n{"key": "value"}\n```');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]).toMatchObject({ type: 'json-data', title: 'JSON 数据' });
      expect(artifacts[0].parsed).toEqual({ key: 'value' });
    });

    it('extracts CSV tables', () => {
      const artifacts = extractArtifacts('```csv\na,b,c\n1,2,3\n```');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]).toMatchObject({ type: 'table', format: 'csv' });
    });

    it('extracts markdown tables outside code fences', () => {
      const artifacts = extractArtifacts('| Name | Age |\n|------|-----|\n| Alice | 30 |\n');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]).toMatchObject({ type: 'table', format: 'markdown' });
    });

    it('extracts code files for supported languages', () => {
      const artifacts = extractArtifacts('```python\ndef hello():\n    print("hi")\n```');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]).toMatchObject({ type: 'code-file', language: 'python', ext: 'py' });
    });

    it('filters by requested types', () => {
      const source = ['```html\n<div></div>\n```', '```mermaid\ngraph TD;\nA-->B;\n```'].join('\n');
      const onlyHtml = extractArtifacts(source, { types: ['html-preview'] });
      expect(onlyHtml.every((a) => a.type === 'html-preview')).toBe(true);

      const onlyMermaid = extractArtifacts(source, { types: ['mermaid'] });
      expect(onlyMermaid.every((a) => a.type === 'mermaid')).toBe(true);
    });

    it('respects maxArtifacts limit', () => {
      const source = [
        '```json\n{"a":1}\n```',
        '```json\n{"b":2}\n```',
        '```json\n{"c":3}\n```',
        '```json\n{"d":4}\n```',
        '```json\n{"e":5}\n```',
      ].join('\n');
      const artifacts = extractArtifacts(source, { maxArtifacts: 3 });
      expect(artifacts.length).toBeLessThanOrEqual(3);
    });

    it('deduplicates identical sources', () => {
      const source = ['```json\n{"same":true}\n```', '```json\n{"same":true}\n```'].join('\n');
      const artifacts = extractArtifacts(source);
      expect(artifacts.length).toBe(1);
    });

    it('returns type labels', () => {
      expect(getArtifactTypeLabel('html-preview')).toBe('HTML 预览');
      expect(getArtifactTypeLabel('mermaid')).toBe('Mermaid 图表');
      expect(getArtifactTypeLabel('unknown')).toBe('Artifact');
    });

    it('builds download names with correct extensions', () => {
      expect(buildArtifactDownloadName({ type: 'mermaid', title: '流程图' })).toBe('流程图.mmd');
      expect(buildArtifactDownloadName({ type: 'json-data', title: 'Config' })).toBe('config.json');
      expect(buildArtifactDownloadName({ type: 'code-file', title: 'script', ext: 'py' })).toBe('script.py');
      expect(buildArtifactDownloadName({ type: 'table', title: 'data' })).toBe('data.csv');
    });
  });
});
