// @ts-nocheck
const { normalizeBaseUrl, buildHeaders, normalizeError } = require('./provider-adapters');
const { resolveAuxiliaryModel, resolveAgentMaxRounds } = require('./stream-runner.ts');
const { estimateTokens, estimateMessagesTokens, normalizeTokenUsage } = require('./usage-meter');
const { formatMessagesForSummary, hashMessages } = require('./context-manager');

const SUMMARY_TRIGGER_RATIO = 0.8;
const COMPACTION_SUMMARY_MARKER = '[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\n';

async function maybeBuildContextSummary(
  request,
  settings,
  contextBundle,
  prefixTokens,
  signal,
  emit,
  summarizeContextFn
) {
  const existingSummary = String(request.contextSummary || '').trim();
  const droppedMessages = contextBundle.meta.droppedMessages || [];
  const summarySourceMessages =
    droppedMessages.length > 0
      ? droppedMessages
      : contextBundle.messages.slice(0, Math.max(0, contextBundle.messages.length - 1));
  const shouldSummarize = droppedMessages.length > 0 || contextBundle.meta.budgetRatio >= SUMMARY_TRIGGER_RATIO;
  if (!shouldSummarize) return existingSummary ? { summary: existingSummary, generated: false } : null;
  if (summarySourceMessages.length === 0)
    return existingSummary ? { summary: existingSummary, generated: false } : null;
  const summaryHash = hashMessages(summarySourceMessages);
  const priorMeta =
    request.contextSummaryMeta && typeof request.contextSummaryMeta === 'object' ? request.contextSummaryMeta : {};
  if (existingSummary && priorMeta.hash === summaryHash) {
    return {
      summary: existingSummary,
      generated: false,
      meta: { hash: summaryHash, sourceMessageCount: summarySourceMessages.length, cacheHit: true },
    };
  }

  const summaryModel = resolveAuxiliaryModel(settings);
  emit(request.requestId, 'agentStage', {
    stage: 'summary',
    round: 0,
    maxRounds: resolveAgentMaxRounds(settings),
    warning: summaryModel !== settings.model ? `摘要辅助调用使用 ${summaryModel} 以降低成本。` : undefined,
  });
  try {
    const summarize = summarizeContextFn || summarizeContext;
    const summary = await summarize(
      { ...settings, model: summaryModel },
      existingSummary,
      summarySourceMessages,
      signal
    );
    const input =
      estimateMessagesTokens([
        { role: 'system', content: 'Summarize conversation context.' },
        { role: 'user', content: `${existingSummary}\n${formatMessagesForSummary(summarySourceMessages)}` },
      ]) + prefixTokens;
    return {
      summary,
      generated: true,
      meta: {
        hash: summaryHash,
        sourceMessageCount: summarySourceMessages.length,
        cacheHit: false,
        auxiliaryModel: summaryModel,
        requestedModel: settings.model,
      },
      usage: normalizeTokenUsage(null, {
        input,
        output: estimateTokens(summary),
        model: summaryModel,
        byPurpose: { summary: input + estimateTokens(summary) },
      }),
    };
  } catch (err) {
    console.error('[ContextSummary] Failed:', normalizeError(err));
    if (existingSummary)
      return {
        summary: existingSummary,
        generated: false,
        meta: {
          hash: priorMeta.hash || summaryHash,
          sourceMessageCount: priorMeta.sourceMessageCount || 0,
          cacheHit: true,
          stale: true,
        },
      };
    return null;
  }
}

async function summarizeContext(settings, existingSummary, droppedMessages, signal) {
  const prompt = [
    '请把下面较早的对话压缩成 DeepChat 后续回答可用的短记忆。',
    '保留用户目标、关键约束、已确认事实、文件/工具结果、未完成事项。',
    '不要添加新事实。控制在 220 个中文字以内。',
    existingSummary ? `已有记忆：\n${existingSummary}` : '',
    '较早对话：',
    formatMessagesForSummary(droppedMessages),
  ]
    .filter(Boolean)
    .join('\n\n');
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: '你负责压缩对话记忆，只输出摘要正文。' },
      { role: 'user', content: prompt },
    ],
    stream: false,
    temperature: 0.2,
    max_tokens: 500,
  };
  const response = await fetch(`${normalizeBaseUrl(settings.apiBase)}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error('summary failed');
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || '';
  return String(content).trim().slice(0, 1200);
}

module.exports = {
  SUMMARY_TRIGGER_RATIO,
  COMPACTION_SUMMARY_MARKER,
  maybeBuildContextSummary,
  summarizeContext,
};
