import { normalizeBaseUrl, buildHeaders, normalizeError } from './provider-adapters.js';
import { resolveAuxiliaryModel, resolveAgentMaxRounds } from './stream-runner.js';
import { estimateTokens, estimateMessagesTokens, normalizeTokenUsage } from './usage-meter.js';
import { formatMessagesForSummary, hashMessages } from './context-manager.js';

const SUMMARY_TRIGGER_RATIO = 0.8;
const COMPACTION_SUMMARY_MARKER = '[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\n';
const SUMMARY_FUTURE_ROUNDS = 3;

type ChatMessage = {
  role: string;
  content?: string;
  [key: string]: any;
};

type ProviderSettings = Record<string, any> & {
  apiBase?: string;
  apiKey?: string;
  model?: string;
  providerId?: string;
  cacheOptimization?: boolean | string;
  contextFoldEconomicsEnabled?: boolean | string;
};

type ContextSummaryRequest = Record<string, any> & {
  requestId: string;
  contextSummary?: string;
  contextSummaryMeta?: Record<string, any> | null;
};

type ContextBudgetBundle = {
  messages: ChatMessage[];
  meta: Record<string, any> & {
    droppedMessages?: ChatMessage[];
    budgetRatio?: number;
  };
};

type EmitFn = (requestId: string, type: string, payload: Record<string, any>) => void;
type SummarizeContextFn = (
  settings: ProviderSettings,
  existingSummary: string,
  droppedMessages: ChatMessage[],
  signal?: AbortSignal
) => Promise<string>;

async function maybeBuildContextSummary(
  request: ContextSummaryRequest,
  settings: ProviderSettings,
  contextBundle: ContextBudgetBundle,
  prefixTokens: number,
  signal: AbortSignal | undefined,
  emit: EmitFn,
  summarizeContextFn?: SummarizeContextFn
) {
  const existingSummary = String(request.contextSummary || '').trim();
  const droppedMessages = contextBundle.meta.droppedMessages || [];
  const summarySourceMessages =
    droppedMessages.length > 0
      ? droppedMessages
      : contextBundle.messages.slice(0, Math.max(0, contextBundle.messages.length - 1));
  const economicsEnabled =
    settings.contextFoldEconomicsEnabled !== false && settings.contextFoldEconomicsEnabled !== 'false';
  const budgetRatio = Number(contextBundle.meta.budgetRatio || 0);
  const shouldSummarize =
    droppedMessages.length > 0 ||
    (economicsEnabled && budgetRatio >= SUMMARY_TRIGGER_RATIO) ||
    (settings.cacheOptimization === false && budgetRatio >= SUMMARY_TRIGGER_RATIO);
  if (!shouldSummarize) return existingSummary ? { summary: existingSummary, generated: false } : null;
  if (summarySourceMessages.length === 0)
    return existingSummary ? { summary: existingSummary, generated: false } : null;
  const summaryHash = hashMessages(summarySourceMessages);
  const priorMeta =
    request.contextSummaryMeta && typeof request.contextSummaryMeta === 'object' ? request.contextSummaryMeta : {};
  const foldDecision = buildContextFoldDecision({
    settings,
    contextBundle,
    existingSummary,
    summaryHash,
    priorMeta,
    summarySourceMessages,
  });
  if (foldDecision.action === 'skip') {
    return existingSummary
      ? { summary: existingSummary, generated: false, meta: { foldDecision, cacheHit: true, stale: true } }
      : null;
  }
  if (existingSummary && priorMeta.hash === summaryHash) {
    return {
      summary: existingSummary,
      generated: false,
      meta: { hash: summaryHash, sourceMessageCount: summarySourceMessages.length, cacheHit: true, foldDecision },
    };
  }

  const summaryModel = resolveAuxiliaryModel(settings);
  emit(request.requestId, 'agentStage', {
    stage: 'summary',
    round: 0,
    maxRounds: resolveAgentMaxRounds(settings),
    foldDecision,
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
      ] as any[]) + prefixTokens;
    return {
      summary,
      generated: true,
      meta: {
        hash: summaryHash,
        sourceMessageCount: summarySourceMessages.length,
        cacheHit: false,
        auxiliaryModel: summaryModel,
        requestedModel: settings.model,
        foldDecision,
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
          foldDecision,
        },
      };
    return null;
  }
}

function buildContextFoldDecision({
  settings = {},
  contextBundle = {},
  existingSummary = '',
  summaryHash = '',
  priorMeta = {},
  summarySourceMessages = [],
}: {
  settings?: ProviderSettings;
  contextBundle?: Partial<ContextBudgetBundle>;
  existingSummary?: string;
  summaryHash?: string;
  priorMeta?: Record<string, any>;
  summarySourceMessages?: ChatMessage[];
}) {
  const typedSettings = settings as any;
  const typedPriorMeta = priorMeta as any;
  const meta = (contextBundle as any).meta || {};
  const droppedMessages = Array.isArray(meta.droppedMessages) ? meta.droppedMessages : [];
  const budgetRatio = Number(meta.budgetRatio || 0);
  const sourceTokens = estimateMessagesTokens(summarySourceMessages);
  const droppedTokens = droppedMessages.length > 0 ? estimateMessagesTokens(droppedMessages) : 0;
  const estimatedSummaryTokens = Math.min(700, Math.max(180, Math.round(sourceTokens * 0.12)));
  const estimatedFutureSavingsTokens = Math.max(0, droppedTokens - estimatedSummaryTokens) * SUMMARY_FUTURE_ROUNDS;
  const estimatedCostUsd = estimateAuxiliarySummaryCost(settings, sourceTokens + estimatedSummaryTokens);
  const estimatedSavingsUsd = estimateInputTokenSavings(settings, estimatedFutureSavingsTokens);
  const matchingSummary = Boolean(existingSummary && typedPriorMeta.hash === summaryHash);

  if (matchingSummary) {
    return {
      action: 'reuse',
      reason: 'summary_hash_hit',
      budgetRatio,
      sourceTokens,
      droppedTokens,
      estimatedCostUsd: 0,
      estimatedSavingsUsd,
      cacheHit: true,
    };
  }

  if (typedSettings.contextFoldEconomicsEnabled === false || typedSettings.contextFoldEconomicsEnabled === 'false') {
    return {
      action: droppedMessages.length > 0 || budgetRatio >= SUMMARY_TRIGGER_RATIO ? 'generate' : 'skip',
      reason: 'economics_disabled_threshold',
      budgetRatio,
      sourceTokens,
      droppedTokens,
      estimatedCostUsd,
      estimatedSavingsUsd,
    };
  }

  if (budgetRatio >= 0.95) {
    return {
      action: 'emergency',
      reason: 'input_budget_emergency',
      budgetRatio,
      sourceTokens,
      droppedTokens,
      estimatedCostUsd,
      estimatedSavingsUsd,
    };
  }

  if (droppedMessages.length > 0) {
    return {
      action: 'generate',
      reason:
        estimatedSavingsUsd >= estimatedCostUsd * 0.6 || droppedTokens > 1200
          ? 'dropped_context_roi'
          : 'dropped_context_required',
      budgetRatio,
      sourceTokens,
      droppedTokens,
      estimatedCostUsd,
      estimatedSavingsUsd,
    };
  }

  if (budgetRatio >= SUMMARY_TRIGGER_RATIO && sourceTokens > 1800) {
    return {
      action: 'generate',
      reason: 'budget_pressure_preemptive',
      budgetRatio,
      sourceTokens,
      droppedTokens,
      estimatedCostUsd,
      estimatedSavingsUsd,
    };
  }

  return {
    action: 'skip',
    reason: 'budget_pressure_low',
    budgetRatio,
    sourceTokens,
    droppedTokens,
    estimatedCostUsd,
    estimatedSavingsUsd,
  };
}

function estimateAuxiliarySummaryCost(settings: ProviderSettings, tokens: number): number {
  const provider = String(settings.providerId || settings.apiBase || '').toLowerCase();
  const pricePerMillion =
    provider.includes('deepseek') || String(settings.model || '').includes('deepseek') ? 0.05 : 0.2;
  return Number((((Number(tokens) || 0) * pricePerMillion) / 1_000_000).toFixed(8));
}

function estimateInputTokenSavings(settings: ProviderSettings, tokens: number): number {
  const provider = String(settings.providerId || settings.apiBase || '').toLowerCase();
  const pricePerMillion = provider.includes('deepseek') || String(settings.model || '').includes('deepseek') ? 0.28 : 1;
  return Number((((Number(tokens) || 0) * pricePerMillion) / 1_000_000).toFixed(8));
}

async function summarizeContext(
  settings: ProviderSettings,
  existingSummary: string,
  droppedMessages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
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

export {
  SUMMARY_TRIGGER_RATIO,
  COMPACTION_SUMMARY_MARKER,
  maybeBuildContextSummary,
  summarizeContext,
  buildContextFoldDecision,
};
