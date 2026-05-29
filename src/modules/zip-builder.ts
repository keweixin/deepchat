/**
 * Minimal ZIP file builder (STORE method, no compression).
 *
 * Creates valid ZIP archives in the browser without external dependencies.
 * Suitable for text-based artifacts where compression is not critical.
 */

interface ZipEntry {
  name: string;
  data: Uint8Array;
  date: Date;
}

/**
 * Create a ZIP archive from a list of named file contents.
 * Uses STORE method (no compression) for maximum compatibility.
 *
 * @param files - Array of {name, content} objects
 * @returns Uint8Array containing the ZIP archive
 */
export function createZipArchive(files: Array<{ name: string; content: string }>): Uint8Array {
  const entries: ZipEntry[] = files.map((f) => ({
    name: f.name,
    data: new TextEncoder().encode(f.content),
    date: new Date(),
  }));

  const parts: Uint8Array[] = [];
  const centralDirParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const dosTime = encodeDosTime(entry.date);
    const dosDate = encodeDosDate(entry.date);

    // CRC-32
    const crc = crc32(entry.data);

    // Local file header (30 + nameBytes.length)
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lhView = new DataView(localHeader);
    lhView.setUint32(0, 0x04034b50, true); // Local file header signature
    lhView.setUint16(4, 20, true); // Version needed to extract
    lhView.setUint16(6, 0, true); // General purpose bit flag
    lhView.setUint16(8, 0, true); // Compression method (STORE)
    lhView.setUint16(10, dosTime, true); // Last mod file time
    lhView.setUint16(12, dosDate, true); // Last mod file date
    lhView.setUint32(14, crc, true); // CRC-32
    lhView.setUint32(18, entry.data.length, true); // Compressed size
    lhView.setUint32(22, entry.data.length, true); // Uncompressed size
    lhView.setUint16(26, nameBytes.length, true); // File name length
    lhView.setUint16(28, 0, true); // Extra field length
    new Uint8Array(localHeader).set(nameBytes, 30);

    parts.push(new Uint8Array(localHeader));
    parts.push(entry.data);

    // Central directory entry (46 + nameBytes.length)
    const centralEntry = new ArrayBuffer(46 + nameBytes.length);
    const ceView = new DataView(centralEntry);
    ceView.setUint32(0, 0x02014b50, true); // Central directory signature
    ceView.setUint16(4, 20, true); // Version made by
    ceView.setUint16(6, 20, true); // Version needed to extract
    ceView.setUint16(8, 0, true); // General purpose bit flag
    ceView.setUint16(10, 0, true); // Compression method (STORE)
    ceView.setUint16(12, dosTime, true); // Last mod file time
    ceView.setUint16(14, dosDate, true); // Last mod file date
    ceView.setUint32(16, crc, true); // CRC-32
    ceView.setUint32(20, entry.data.length, true); // Compressed size
    ceView.setUint32(24, entry.data.length, true); // Uncompressed size
    ceView.setUint16(28, nameBytes.length, true); // File name length
    ceView.setUint16(30, 0, true); // Extra field length
    ceView.setUint16(32, 0, true); // File comment length
    ceView.setUint16(34, 0, true); // Disk number start
    ceView.setUint16(36, 0, true); // Internal file attributes
    ceView.setUint32(38, 0, true); // External file attributes
    ceView.setUint32(42, offset, true); // Relative offset of local header
    new Uint8Array(centralEntry).set(nameBytes, 46);

    centralDirParts.push(new Uint8Array(centralEntry));
    offset += localHeader.byteLength + entry.data.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const part of centralDirParts) {
    centralDirSize += part.length;
  }

  // End of central directory record (22 bytes)
  const endRecord = new ArrayBuffer(22);
  const erView = new DataView(endRecord);
  erView.setUint32(0, 0x06054b50, true); // End of central dir signature
  erView.setUint16(4, 0, true); // Number of this disk
  erView.setUint16(6, 0, true); // Disk where central dir starts
  erView.setUint16(8, entries.length, true); // Number of entries on this disk
  erView.setUint16(10, entries.length, true); // Total number of entries
  erView.setUint32(12, centralDirSize, true); // Central dir size
  erView.setUint32(16, centralDirOffset, true); // Central dir offset
  erView.setUint16(20, 0, true); // Comment length

  // Concatenate all parts
  const totalSize = offset + centralDirSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  for (const part of centralDirParts) {
    result.set(part, pos);
    pos += part.length;
  }
  result.set(new Uint8Array(endRecord), pos);

  return result;
}

/**
 * Trigger a browser download of a ZIP archive.
 */
export function downloadZipArchive(files: Array<{ name: string; content: string }>, zipName: string): void {
  const data = createZipArchive(files);
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  const blob = new Blob([ab], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = zipName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ─── Internal helpers ─── */

/** CRC-32 lookup table (computed once). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/** Compute CRC-32 checksum. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode Date to DOS time (HH:MM:SS/2). */
function encodeDosTime(date: Date): number {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
}

/** Encode Date to DOS date (YYYY-MM-DD). */
function encodeDosDate(date: Date): number {
  return (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
}
