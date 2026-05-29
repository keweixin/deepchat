import { describe, it, expect } from 'vitest';
import { createZipArchive } from '../src/modules/zip-builder.js';

describe('zip-builder', () => {
  it('creates a valid ZIP archive with correct signature', () => {
    const data = createZipArchive([{ name: 'test.txt', content: 'hello world' }]);
    expect(data).toBeInstanceOf(Uint8Array);
    // Check for local file header signature (PK\x03\x04)
    expect(data[0]).toBe(0x50); // P
    expect(data[1]).toBe(0x4b); // K
    expect(data[2]).toBe(0x03);
    expect(data[3]).toBe(0x04);
  });

  it('creates ZIP with multiple files', () => {
    const files = [
      { name: 'a.txt', content: 'file A' },
      { name: 'b.json', content: '{"key":"value"}' },
      { name: 'c.html', content: '<h1>Hello</h1>' },
    ];
    const data = createZipArchive(files);

    // Should contain all filenames
    const text = new TextDecoder().decode(data);
    expect(text).toContain('a.txt');
    expect(text).toContain('b.json');
    expect(text).toContain('c.html');

    // Check end-of-central-directory record (last 22 bytes)
    const eocd = data.slice(-22);
    expect(eocd[0]).toBe(0x50); // PK
    expect(eocd[1]).toBe(0x4b);
    expect(eocd[2]).toBe(0x05);
    expect(eocd[3]).toBe(0x06);
  });

  it('creates ZIP with correct file count in EOCD', () => {
    const files = [
      { name: 'one.txt', content: '1' },
      { name: 'two.txt', content: '2' },
      { name: 'three.txt', content: '3' },
    ];
    const data = createZipArchive(files);
    const eocd = new DataView(data.buffer, data.byteOffset + data.length - 22);
    // Number of entries on this disk (offset 8)
    expect(eocd.getUint16(8, true)).toBe(3);
    // Total number of entries (offset 10)
    expect(eocd.getUint16(10, true)).toBe(3);
  });

  it('handles empty content', () => {
    const data = createZipArchive([{ name: 'empty.txt', content: '' }]);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });

  it('handles Chinese filenames', () => {
    const data = createZipArchive([{ name: '代码.js', content: 'const x = 1;' }]);
    const text = new TextDecoder().decode(data);
    expect(text).toContain('代码.js');
  });
});
