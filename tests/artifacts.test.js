import { describe, expect, it } from 'vitest';
import {
  buildArtifactDownloadName,
  createSandboxedHtmlDocument,
  extractHtmlArtifacts,
} from '../src/modules/artifacts.js';

describe('artifact helpers', () => {
  it('extracts bounded HTML code blocks as artifacts', () => {
    const artifacts = extractHtmlArtifacts([
      '普通说明',
      '```html',
      '<main><h1>Demo</h1><script>alert(1)</script></main>',
      '```',
      '```js',
      'console.log("ignored")',
      '```',
    ].join('\n'));

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
});
