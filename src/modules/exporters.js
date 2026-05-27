import { renderMarkdown } from './renderer.js';
import { buildToolEvidencePayload, buildToolRuns } from './tool-runs.js';
import { escapeHtml, formatTime, showToast } from './utils.js';

export function exportConversation(conversation, format = 'markdown') {
  if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
    showToast('没有可导出的消息');
    return;
  }

  if (format === 'html') {
    downloadBlob(
      new Blob([buildConversationHtml(conversation)], { type: 'text/html;charset=utf-8' }),
      `${safeFileName(conversation.title)}.html`
    );
    showToast('对话已导出为 HTML');
    return;
  }

  if (format === 'pdf') {
    printConversationAsPdf(conversation);
    return;
  }

  if (format === 'favorites') {
    const markdown = buildConversationMarkdown(conversation, { onlyFavorites: true });
    if (!markdown) {
      showToast('当前对话没有收藏回答');
      return;
    }
    downloadBlob(
      new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
      `${safeFileName(conversation.title)}-favorites.md`
    );
    showToast('已导出收藏回答');
    return;
  }

  if (format === 'tool-evidence') {
    const evidence = buildToolEvidence(conversation);
    downloadBlob(
      new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json;charset=utf-8' }),
      `${safeFileName(conversation.title)}-tool-evidence.json`
    );
    showToast('已导出工具证据 JSON');
    return;
  }

  if (format === 'assets') {
    const html = buildAssetManifestHtml(conversation);
    downloadBlob(
      new Blob([html], { type: 'text/html;charset=utf-8' }),
      `${safeFileName(conversation.title)}-assets.html`
    );
    showToast('已导出资源索引 HTML');
    return;
  }

  const markdown = buildConversationMarkdown(conversation);
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${safeFileName(conversation.title)}.md`);
  showToast('对话已导出为 Markdown');
}

export function buildConversationMarkdown(conversation, options = {}) {
  const messages = options.onlyFavorites
    ? conversation.messages.filter((message) => message.role === 'assistant' && message.favorite)
    : conversation.messages;
  if (messages.length === 0) return '';

  let markdown = `# ${conversation.title}\n\n`;
  markdown += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;

  for (const message of messages) {
    const role = message.role === 'user' ? '你' : 'DeepChat';
    markdown += `### ${role}  _${formatTime(message.timestamp)}_\n\n${message.content || ''}\n\n`;
    if (message.attachments?.length) {
      markdown += `#### 附件\n\n`;
      for (const attachment of message.attachments) {
        markdown += `- ${attachment.name || '附件'} (${attachment.mimeType || 'unknown'}, ${attachment.size ? formatBytes(attachment.size) : 'unknown size'})\n`;
      }
      markdown += `\n`;
    }
    if (message.error) markdown += `> 生成失败：${message.error}\n\n`;
    markdown += buildMessageAuditMarkdown(message);
    if (message.sourceWarning) markdown += `> 注意：本轮调用了联网搜索，但最终回答没有引用搜索来源 URL。\n\n`;
    markdown += `---\n\n`;
  }
  return markdown;
}

function buildMessageAuditMarkdown(message = {}) {
  let markdown = '';
  const runs = getMessageToolEvidenceRuns(message);
  if (runs?.length) {
    markdown += `#### 工具调用\n\n`;
    for (const tool of runs) {
      const evidence = tool.evidence?.type === 'deepchat.toolEvidence' ? tool.evidence : buildToolEvidencePayload(tool);
      const citationStatus = buildEvidenceCitationStatus(evidence, message.content || '');
      markdown += `- ${evidence.name || 'unknown'}：${getToolStatusText(evidence.status)} · 证据${formatCitationStatusText(citationStatus)}\n`;
      if (evidence.query) markdown += `  - query: ${evidence.query}\n`;
      if (evidence.durationMs) markdown += `  - 耗时: ${evidence.durationMs}ms\n`;
      if (evidence.contextCompacted) {
        markdown += `  - 上下文压缩: ${evidence.rawOutputTokens || 0} → ${evidence.contextOutputTokens || 0} tokens\n`;
      }
      for (const ref of citationStatus.refs.slice(0, 6)) {
        markdown += `  - ${ref.cited ? '已引用' : '未引用'}: ${ref.label || ref.value}\n`;
      }
    }
    markdown += `\n`;
  }
  return markdown + buildMessageUsageMarkdown(message);
}

function buildMessageUsageMarkdown(message = {}) {
  const usage = normalizeExportUsage(message.tokens || null);
  const hasUsage = usage.total > 0 || usage.input > 0 || usage.output > 0;
  const hasBudget = Boolean(message.contextBudget);
  if (!hasUsage && !hasBudget) return '';
  const parts = [];
  if (hasUsage) {
    parts.push(`输入 ${usage.input}`);
    parts.push(`输出 ${usage.output}`);
    parts.push(`总计 ${usage.total}`);
    if (usage.reasoning) parts.push(`思考 ${usage.reasoning}`);
    if (usage.cacheHit || usage.cacheMiss) parts.push(`cache ${Math.round((usage.cacheHitRate || 0) * 100)}%`);
    parts.push(
      usage.source === 'provider' ? '服务商真实 usage' : usage.source === 'mixed' ? '真实/估算混合' : '本地估算'
    );
  }
  if (message.contextBudget?.prefixFingerprint) parts.push(`prefix ${message.contextBudget.prefixFingerprint}`);
  if (message.contextBudget?.trimmed) parts.push(`裁剪 ${message.contextBudget.droppedCount || 0} 条历史`);
  if (message.contextBudget?.summaryUsed) parts.push('已使用长期摘要');
  return `#### Token / Cache\n\n- ${parts.join(' · ')}\n\n`;
}

export function buildConversationHtml(conversation) {
  const body = conversation.messages
    .map((message) => {
      const role = message.role === 'user' ? '你' : 'DeepChat';
      const audit = buildMessageAuditMarkdown(message);
      const auditHtml = audit ? `<aside class="audit">${renderMarkdown(audit)}</aside>` : '';
      return `<section class="msg ${message.role}"><h2>${escapeHtml(role)} · ${escapeHtml(formatTime(message.timestamp))}</h2><div>${renderMarkdown(message.content || '')}</div>${auditHtml}</section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(conversation.title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.7;max-width:860px;margin:40px auto;padding:0 24px;color:#111827}.msg{border-top:1px solid #e5e7eb;padding:20px 0}.msg h2{font-size:14px;color:#6b7280}pre{overflow:auto;background:#111827;color:#f9fafb;padding:14px;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d5db;padding:8px}.asset{max-width:100%;border:1px solid #e5e7eb;border-radius:8px}.audit{margin-top:16px;padding:12px 14px;border:1px solid #d1d5db;border-radius:8px;background:#f8fafc}.audit h4{margin:0 0 8px;font-size:13px;color:#374151}.audit ul{margin:8px 0 0 20px}</style></head><body><h1>${escapeHtml(conversation.title)}</h1>${body}</body></html>`;
}

export function buildToolEvidence(conversation) {
  const toolRuns = [];
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const [messageIndex, message] of (conversation.messages || []).entries()) {
    for (const run of getMessageToolEvidenceRuns(message)) {
      const evidence = run.evidence?.type === 'deepchat.toolEvidence' ? run.evidence : buildToolEvidencePayload(run);
      toolRuns.push({
        messageIndex,
        messageRole: message.role || '',
        messageTime: message.timestamp || null,
        ...evidence,
        citationStatus: buildEvidenceCitationStatus(evidence, message.content || ''),
      });
    }
  }
  const cacheEvidence = buildCacheEvidence(messages);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    conversation: {
      id: conversation.id,
      title: conversation.title,
      tags: conversation.tags || [],
      folderId: conversation.folderId || '',
    },
    usageTotals: normalizeExportUsage(conversation.usageTotals || aggregateMessageUsage(messages)),
    cacheEvidence,
    toolRuns,
  };
}

function getMessageToolEvidenceRuns(message = {}) {
  if (Array.isArray(message.toolRuns) && message.toolRuns.length) return message.toolRuns;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length) return buildToolRuns(message.toolCalls);
  return [];
}

function buildCacheEvidence(messages = []) {
  return messages
    .map((message, messageIndex) => {
      if (message?.role !== 'assistant') return null;
      const tokens = normalizeExportUsage(message.tokens || null);
      const hasUsage = tokens.total > 0 || tokens.input > 0 || tokens.output > 0;
      const hasCacheProfile = Boolean(message.cacheProfile || message.contextBudget?.prefixFingerprint);
      if (!hasUsage && !hasCacheProfile) return null;
      return {
        messageIndex,
        messageTime: message.timestamp || null,
        tokens,
        cacheProfile: {
          ...(message.cacheProfile || {}),
          prefixFingerprint:
            message.cacheProfile?.prefixFingerprint ||
            message.contextBudget?.prefixFingerprint ||
            tokens.prefixFingerprint ||
            '',
          prefixTokens:
            message.cacheProfile?.prefixTokens || message.contextBudget?.prefixTokens || tokens.prefixTokens || 0,
          prefixBytes:
            message.cacheProfile?.prefixBytes || message.contextBudget?.prefixBytes || tokens.prefixBytes || 0,
        },
        contextBudget: message.contextBudget || null,
      };
    })
    .filter(Boolean);
}

function buildEvidenceCitationStatus(evidence = {}, content = '') {
  const refs = collectEvidenceRefs(evidence);
  const checked = refs.map((ref) => ({
    ...ref,
    cited: isEvidenceRefMentioned(content, ref),
  }));
  const cited = checked.filter((ref) => ref.cited).length;
  const total = checked.length;
  return {
    state: total === 0 ? 'no-evidence' : cited === total ? 'is-cited' : cited > 0 ? 'partially-cited' : 'uncited',
    cited,
    total,
    refs: checked,
  };
}

function formatCitationStatusText(status = {}) {
  if (status.total === 0) return '无外部引用项';
  if (status.state === 'is-cited') return `已全部引用 (${status.cited}/${status.total})`;
  if (status.state === 'partially-cited') return `部分引用 (${status.cited}/${status.total})`;
  return `未引用 (${status.cited}/${status.total})`;
}

function collectEvidenceRefs(evidence = {}) {
  const refs = [];
  for (const source of Array.isArray(evidence.sources) ? evidence.sources : []) {
    const url = String(source?.url || '').trim();
    if (url) refs.push({ type: 'url', label: source.title || url, value: url });
  }
  for (const citation of Array.isArray(evidence.localCitations) ? evidence.localCitations : []) {
    const file = String(citation?.file || '').trim();
    if (!file) continue;
    refs.push({
      type: 'file',
      label: citation.label || file,
      value: citation.label || file,
      file,
      lineStart: citation.lineStart || 0,
      lineEnd: citation.lineEnd || citation.lineStart || 0,
    });
  }
  const symbol = evidence.workspaceSymbol;
  if (symbol?.result?.file) {
    const start = symbol.result.startLine || symbol.result.definitionLine || 0;
    const end = symbol.result.endLine || start;
    refs.push({
      type: 'symbol',
      label: `${symbol.symbol || 'symbol'} ${symbol.result.file}${start ? `:${start}${end && end !== start ? `-${end}` : ''}` : ''}`,
      value: symbol.result.file,
      file: symbol.result.file,
      lineStart: start,
      lineEnd: end,
    });
  }
  return dedupeEvidenceRefs(refs);
}

function isEvidenceRefMentioned(content = '', ref = {}) {
  const text = String(content || '').replace(/\\/g, '/');
  if (ref.type === 'url') return Boolean(ref.value && text.includes(ref.value));
  const file = String(ref.file || ref.value || '').replace(/\\/g, '/');
  const basename = file.split('/').filter(Boolean).at(-1) || file;
  const start = ref.lineStart ? String(ref.lineStart) : '';
  const end = ref.lineEnd && ref.lineEnd !== ref.lineStart ? String(ref.lineEnd) : '';
  return [
    ref.label,
    ref.value,
    file,
    basename,
    start ? `${file}:${start}` : '',
    start ? `${basename}:${start}` : '',
    start && end ? `${file}:${start}-${end}` : '',
    start && end ? `${basename}:${start}-${end}` : '',
  ]
    .filter(Boolean)
    .map((item) => String(item).replace(/\\/g, '/'))
    .some((label) => text.includes(label));
}

function dedupeEvidenceRefs(refs = []) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.value}:${ref.file || ''}:${ref.lineStart || ''}:${ref.lineEnd || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function aggregateMessageUsage(messages = []) {
  return messages.reduce(
    (acc, message) => {
      const usage = normalizeExportUsage(message?.tokens || null);
      acc.input += usage.input;
      acc.output += usage.output;
      acc.total += usage.total;
      acc.reasoning += usage.reasoning;
      acc.cacheHit += usage.cacheHit;
      acc.cacheMiss += usage.cacheMiss;
      if (usage.source) acc.sources.add(usage.source);
      return acc;
    },
    {
      input: 0,
      output: 0,
      total: 0,
      reasoning: 0,
      cacheHit: 0,
      cacheMiss: 0,
      sources: new Set(),
    }
  );
}

function normalizeExportUsage(usage = null) {
  const sourceSet = usage?.sources instanceof Set ? usage.sources : null;
  const source = sourceSet
    ? sourceSet.size === 0
      ? 'estimated'
      : sourceSet.size === 1
        ? [...sourceSet][0]
        : 'mixed'
    : usage?.source || 'estimated';
  const input = toSafeNumber(usage?.input);
  const output = toSafeNumber(usage?.output);
  const total = toSafeNumber(usage?.total) || input + output;
  const cacheHit = toSafeNumber(usage?.cacheHit);
  const cacheMiss = toSafeNumber(usage?.cacheMiss);
  return {
    input,
    output,
    total,
    reasoning: toSafeNumber(usage?.reasoning),
    cacheHit,
    cacheMiss,
    cacheHitRate: input > 0 ? cacheHit / input : cacheHit + cacheMiss > 0 ? cacheHit / (cacheHit + cacheMiss) : 0,
    source,
    rounds: toSafeNumber(usage?.rounds),
    prefixFingerprint: usage?.prefixFingerprint || '',
    prefixTokens: toSafeNumber(usage?.prefixTokens),
    prefixBytes: toSafeNumber(usage?.prefixBytes),
  };
}

function toSafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export function buildAssetManifestHtml(conversation) {
  const assets = collectAssets(conversation);
  const sections =
    assets.length === 0
      ? '<p>当前对话没有可导出的图片或 Mermaid 资源。</p>'
      : assets
          .map((asset, index) => {
            if (asset.type === 'image') {
              return `<section><h2>${index + 1}. ${escapeHtml(asset.name)}</h2><p>${escapeHtml(asset.mimeType || '')} ${escapeHtml(asset.size || '')}</p><img class="asset" src="${escapeHtml(asset.src)}" alt="${escapeHtml(asset.name)}"></section>`;
            }
            return `<section><h2>${index + 1}. Mermaid 图示</h2><pre><code>${escapeHtml(asset.code)}</code></pre></section>`;
          })
          .join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(conversation.title)} 资源</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;max-width:900px;margin:40px auto;padding:0 24px;line-height:1.7;color:#111827}section{border-top:1px solid #e5e7eb;padding:20px 0}.asset{max-width:100%;border:1px solid #d1d5db;border-radius:8px}pre{white-space:pre-wrap;background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e5e7eb}</style></head><body><h1>${escapeHtml(conversation.title)} 资源索引</h1>${sections}</body></html>`;
}

function collectAssets(conversation) {
  const assets = [];
  for (const message of conversation.messages || []) {
    for (const attachment of message.attachments || []) {
      if (!attachment?.dataUrl) continue;
      assets.push({
        type: 'image',
        name: attachment.name || '图片附件',
        mimeType: attachment.mimeType || '',
        size: attachment.size ? formatBytes(attachment.size) : '',
        src: attachment.dataUrl,
      });
    }
    for (const match of String(message.content || '').matchAll(/```mermaid\s*([\s\S]*?)```/gi)) {
      assets.push({ type: 'mermaid', code: match[1].trim() });
    }
  }
  return assets;
}

function printConversationAsPdf(conversation) {
  const frame = document.createElement('iframe');
  frame.className = 'export-print-frame';
  frame.srcdoc = buildConversationHtml(conversation);
  document.body.appendChild(frame);
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1200);
  };
  showToast('已打开打印窗口，可选择另存为 PDF');
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value) {
  return String(value || 'DeepChat').replace(/[/\\?%*:|"<>]/g, '_');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function getToolStatusText(status) {
  const map = {
    pending: '待确认',
    approved: '已确认',
    denied: '已拒绝',
    completed: '已完成',
    failed: '失败',
  };
  return map[status] || status || '未知';
}
