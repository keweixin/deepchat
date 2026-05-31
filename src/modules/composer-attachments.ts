export const DEFAULT_MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const DEFAULT_MAX_COMPOSER_ATTACHMENTS = 8;

export type ComposerAttachment = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string | ArrayBuffer | null;
};

export type DroppedFileHandlerOptions = {
  getPendingAttachments: () => ComposerAttachment[];
  setPendingAttachments: (attachments: ComposerAttachment[]) => void;
  maxAttachments?: number;
  maxTextAttachmentBytes?: number;
  showToast?: (message: string, duration?: number) => void;
  autoResize?: (input: HTMLTextAreaElement) => void;
  toggleMarkdownPreview?: (text: string) => void;
  documentRef?: Document;
  createId?: () => string;
};

export function isImageFile(file: Pick<File, 'type'>): boolean {
  return String(file?.type || '').startsWith('image/');
}

export function isImageAttachment(attachment: ComposerAttachment): boolean {
  return String(attachment?.mimeType || '').startsWith('image/');
}

export function getTextAttachments(attachments: ComposerAttachment[] = []): ComposerAttachment[] {
  return attachments.filter((item) => !isImageAttachment(item));
}

export function buildTextAttachmentContext(name: string | undefined, text: unknown): string {
  return `[附件文件: ${name || '文本附件'}]\n\`\`\`\n${String(text || '')}\n\`\`\``;
}

export function buildUploadedAttachmentsContext(attachments: ComposerAttachment[] = []): string {
  return getTextAttachments(attachments)
    .map((item) => buildTextAttachmentContext(item.name, item.dataUrl))
    .join('\n\n');
}

export function appendTextAttachmentsToPrompt(prompt: string, attachments: ComposerAttachment[] = []): string {
  const textContext = buildUploadedAttachmentsContext(attachments);
  if (!textContext) return prompt;
  return `${prompt}\n\n<uploaded_attachments>\n${textContext}\n</uploaded_attachments>`;
}

export function insertTextAttachmentIntoInput(
  input: HTMLTextAreaElement,
  name: string | undefined,
  text: unknown,
  autoResize?: (input: HTMLTextAreaElement) => void
) {
  const block = `\n\n${buildTextAttachmentContext(name, text)}`;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${block}${input.value.slice(end)}`;
  const cursor = start + block.length;
  input.setSelectionRange(cursor, cursor);
  autoResize?.(input);
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function clearPendingAttachmentPreview(documentRef: Document = document) {
  documentRef.querySelector('.attachment-preview')?.remove();
}

export function handleDroppedFiles(files: File[], input: HTMLTextAreaElement, options: DroppedFileHandlerOptions) {
  const documentRef = options.documentRef || document;
  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_COMPOSER_ATTACHMENTS;
  const maxTextBytes = options.maxTextAttachmentBytes ?? DEFAULT_MAX_TEXT_ATTACHMENT_BYTES;
  const remainingSlots = Math.max(0, maxAttachments - options.getPendingAttachments().length);
  const acceptedFiles = files.slice(0, remainingSlots);
  if (acceptedFiles.length < files.length) {
    options.showToast?.(`最多保留 ${maxAttachments} 个附件，多余的文件已忽略。`, 2400);
  }

  acceptedFiles.forEach((file) => {
    const image = isImageFile(file);
    if (!image && file.size > maxTextBytes) {
      options.showToast?.(`${file.name} 超过 ${Math.round(maxTextBytes / 1024)}KB，已跳过。`, 2600);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const preview = ensureAttachmentPreview(documentRef);
      const attachment = createAttachment(file, reader.result, options.createId);
      const item = createAttachmentItem({
        attachment,
        image,
        input,
        documentRef,
        readerResult: reader.result,
        options,
      });

      options.setPendingAttachments([...options.getPendingAttachments(), attachment]);
      preview.appendChild(item);
      syncSendButton(documentRef, input, options.getPendingAttachments());
    };

    if (image) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });

  if (acceptedFiles.length > 0) {
    options.showToast?.(`已添加 ${acceptedFiles.length} 个附件`, 1500);
  }
}

function ensureAttachmentPreview(documentRef: Document): HTMLElement {
  let preview = documentRef.querySelector('.attachment-preview') as HTMLElement | null;
  if (!preview) {
    preview = documentRef.createElement('div');
    preview.className = 'attachment-preview';
    const inputArea = documentRef.querySelector('.input-container');
    inputArea?.parentNode?.insertBefore(preview, inputArea);
  }
  return preview;
}

function createAttachment(
  file: File,
  dataUrl: FileReader['result'],
  createId: (() => string) | undefined
): ComposerAttachment {
  return {
    id: createId?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    mimeType: file.type || 'text/plain',
    size: file.size,
    dataUrl,
  };
}

function createAttachmentItem(params: {
  attachment: ComposerAttachment;
  image: boolean;
  input: HTMLTextAreaElement;
  documentRef: Document;
  readerResult: FileReader['result'];
  options: DroppedFileHandlerOptions;
}): HTMLElement {
  const { attachment, image, input, documentRef, readerResult, options } = params;
  const item = documentRef.createElement('div');
  item.className = `attachment-item${image ? ' type-image' : ' type-text'}`;
  item.dataset.attachmentId = attachment.id;

  if (image) {
    const img = documentRef.createElement('img');
    img.src = String(readerResult || '');
    img.alt = attachment.name || '图片附件';
    item.appendChild(img);
  } else {
    const icon = documentRef.createElement('div');
    icon.className = 'attachment-text-icon';
    icon.textContent = '📄';
    item.appendChild(icon);
  }

  const name = documentRef.createElement('span');
  name.className = 'attachment-name';
  name.textContent = attachment.name || '附件';
  item.appendChild(name);

  if (!image) {
    item.appendChild(createTextPreviewButton(documentRef, attachment, readerResult, options));
    item.appendChild(createTextInsertButton(documentRef, attachment, readerResult, input, item, options));
  }

  item.appendChild(createRemoveButton(documentRef, attachment, input, item, options));
  return item;
}

function createTextPreviewButton(
  documentRef: Document,
  attachment: ComposerAttachment,
  readerResult: FileReader['result'],
  options: DroppedFileHandlerOptions
): HTMLButtonElement {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = 'attachment-preview-action';
  button.title = '预览文本附件';
  button.setAttribute('aria-label', `预览 ${attachment.name || '文本附件'}`);
  button.textContent = '预览';
  button.addEventListener('click', () => {
    options.toggleMarkdownPreview?.(
      `文件：${attachment.name || '文本附件'}\n\n\`\`\`text\n${String(readerResult || '')}\n\`\`\``
    );
  });
  return button;
}

function createTextInsertButton(
  documentRef: Document,
  attachment: ComposerAttachment,
  readerResult: FileReader['result'],
  input: HTMLTextAreaElement,
  item: HTMLElement,
  options: DroppedFileHandlerOptions
): HTMLButtonElement {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = 'attachment-preview-action';
  button.title = '插入到输入框';
  button.setAttribute('aria-label', `插入 ${attachment.name || '文本附件'} 到输入框`);
  button.textContent = '插入';
  button.addEventListener('click', () => {
    insertTextAttachmentIntoInput(input, attachment.name, readerResult, options.autoResize);
    removePendingAttachment(attachment.id, item, input, options, documentRef);
    options.showToast?.('已插入文本附件', 1400);
  });
  return button;
}

function createRemoveButton(
  documentRef: Document,
  attachment: ComposerAttachment,
  input: HTMLTextAreaElement,
  item: HTMLElement,
  options: DroppedFileHandlerOptions
): HTMLButtonElement {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = 'attachment-remove';
  button.title = '移除';
  button.setAttribute('aria-label', `移除 ${attachment.name || '附件'}`);
  button.textContent = '×';
  button.addEventListener('click', () => removePendingAttachment(attachment.id, item, input, options, documentRef));
  return button;
}

function removePendingAttachment(
  attachmentId: string,
  item: HTMLElement,
  input: HTMLTextAreaElement,
  options: DroppedFileHandlerOptions,
  documentRef: Document
) {
  options.setPendingAttachments(options.getPendingAttachments().filter((attachment) => attachment.id !== attachmentId));
  const preview = item.parentElement;
  item.remove();
  if (preview && preview.children.length === 0) preview.remove();
  syncSendButton(documentRef, input, options.getPendingAttachments());
}

function syncSendButton(documentRef: Document, input: HTMLTextAreaElement, attachments: ComposerAttachment[]) {
  const sendButton = documentRef.getElementById('send-btn') as HTMLButtonElement | null;
  if (sendButton) sendButton.disabled = !input.value.trim() && attachments.length === 0;
}
