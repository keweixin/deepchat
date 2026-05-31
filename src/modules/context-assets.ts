export interface ContextAsset {
  id: string;
  kind: 'text' | 'image';
  name: string;
  mimeType: string;
  size: number;
  text?: string;
  dataUrl?: string | ArrayBuffer | null;
  includeInNextTurn: boolean;
  createdAt: string;
}

export function createTextContextAsset(input: {
  name: string;
  text: string;
  size: number;
  mimeType?: string;
  includeInNextTurn?: boolean;
  id?: string;
  createdAt?: string;
}): ContextAsset {
  return {
    id: input.id || `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'text',
    name: input.name,
    mimeType: input.mimeType || 'text/plain',
    size: input.size,
    text: input.text,
    includeInNextTurn: input.includeInNextTurn !== false,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function selectContextAssetsForTurn(assets: ContextAsset[] = []): ContextAsset[] {
  return assets.filter((asset) => asset.includeInNextTurn);
}

export function buildContextAssetPromptBlock(
  assets: ContextAsset[] = [],
  options: { maxCharsPerAsset?: number } = {}
): string {
  const maxChars = Math.max(200, options.maxCharsPerAsset ?? 6000);
  const blocks = selectContextAssetsForTurn(assets)
    .filter((asset) => asset.kind === 'text')
    .map((asset) => {
      const text = String(asset.text || asset.dataUrl || '');
      const clipped =
        text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]` : text;
      return [
        `[附件文件: ${asset.name || '文本附件'}]`,
        `id: ${asset.id}`,
        `mime: ${asset.mimeType || 'text/plain'} · size: ${asset.size || text.length} bytes`,
        '```',
        clipped,
        '```',
      ].join('\n');
    });
  if (!blocks.length) return '';
  return `<uploaded_attachments>\n${blocks.join('\n\n')}\n</uploaded_attachments>`;
}
