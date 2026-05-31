import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTextAttachmentsToPrompt,
  buildTextAttachmentContext,
  clearPendingAttachmentPreview,
  handleDroppedFiles,
  insertTextAttachmentIntoInput,
  type ComposerAttachment,
} from '../src/modules/composer-attachments.js';

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsText() {
    this.result = 'file body';
    this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
  }

  readAsDataURL(file: File) {
    this.result = `data:${file.type};base64,abc`;
    this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
  }
}

function setupComposerDom() {
  document.body.innerHTML = `
    <div class="composer-shell">
      <div class="input-container"></div>
      <textarea id="message-input"></textarea>
      <button id="send-btn" disabled>send</button>
    </div>
  `;
  return {
    input: document.getElementById('message-input') as HTMLTextAreaElement,
    sendButton: document.getElementById('send-btn') as HTMLButtonElement,
  };
}

describe('composer attachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('formats text attachments as bounded uploaded context', () => {
    expect(buildTextAttachmentContext('README.md', 'hello')).toBe('[附件文件: README.md]\n```\nhello\n```');

    const prompt = appendTextAttachmentsToPrompt('请总结', [
      { id: '1', name: 'a.md', mimeType: 'text/markdown', size: 5, dataUrl: 'Alpha' },
      { id: '2', name: 'photo.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,abc' },
    ]);

    expect(prompt).toContain('<uploaded_attachments>');
    expect(prompt).toContain('[附件文件: a.md]');
    expect(prompt).toContain('id: 1');
    expect(prompt).toContain('Alpha');
    expect(prompt).not.toContain('photo.png');
  });

  it('bounds long text attachments before adding them to the prompt', () => {
    const prompt = appendTextAttachmentsToPrompt('请总结', [
      { id: 'long', name: 'long.txt', mimeType: 'text/plain', dataUrl: 'A'.repeat(7000), size: 7000 },
    ]);

    expect(prompt).toContain('truncated 1000 chars');
    expect(prompt.length).toBeLessThan(6600);
  });

  it('inserts a text attachment only when the user chooses insert', () => {
    const { input } = setupComposerDom();
    input.value = 'before after';
    input.setSelectionRange(6, 6);
    const resize = vi.fn();
    const inputEvent = vi.fn();
    input.addEventListener('input', inputEvent);

    insertTextAttachmentIntoInput(input, 'notes.txt', 'details', resize);

    expect(input.value).toContain('before\n\n[附件文件: notes.txt]');
    expect(input.value).toContain('details');
    expect(input.value).toContain(' after');
    expect(resize).toHaveBeenCalledWith(input);
    expect(inputEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps dropped text files as attachment cards instead of mutating the textarea', () => {
    vi.stubGlobal('FileReader', MockFileReader as unknown as typeof FileReader);
    const { input, sendButton } = setupComposerDom();
    let pending: ComposerAttachment[] = [];
    const toast = vi.fn();

    handleDroppedFiles([new File(['real body'], 'notes.md', { type: 'text/markdown' })], input, {
      getPendingAttachments: () => pending,
      setPendingAttachments: (attachments) => {
        pending = attachments;
      },
      showToast: toast,
      createId: () => 'attachment-1',
    });

    expect(input.value).toBe('');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'attachment-1',
      kind: 'text',
      name: 'notes.md',
      dataUrl: 'file body',
      text: 'file body',
      includeInNextTurn: true,
    });
    expect(document.querySelectorAll('.attachment-item.type-text')).toHaveLength(1);
    expect(sendButton.disabled).toBe(false);
    expect(toast).toHaveBeenCalledWith('已添加 1 个附件', 1500);
  });

  it('removes attachment preview containers during cleanup', () => {
    setupComposerDom();
    const preview = document.createElement('div');
    preview.className = 'attachment-preview';
    document.body.appendChild(preview);

    clearPendingAttachmentPreview();

    expect(document.querySelector('.attachment-preview')).toBeNull();
  });
});
