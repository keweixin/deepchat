import { estimateMessagesTokens, estimateTokens, mergeTokenUsage, normalizeTokenUsage } from './usage-meter.js';
import { attachPrefixProfile } from './chat-service-helpers.js';

type EmitFn = (requestId: string, type: string, payload?: Record<string, any>) => void;

type StopResponseOptions = {
  emit: EmitFn;
  requestId: string;
  content: string;
  warning: string;
  stopReason: string;
  maxToolRounds: number;
  contextMeta: Record<string, any>;
  systemPrompt: string;
  apiMessages: Record<string, any>[];
  settings: Record<string, any>;
  prefix: Record<string, any>;
  warnings: string[];
};

type StopResponseBase = Omit<StopResponseOptions, 'content' | 'warning' | 'stopReason'>;

export function emitProviderToolsUnsupportedStop(base: StopResponseBase, warning: string) {
  base.warnings.push(warning);
  emitAgentStopResponse({
    ...base,
    warning,
    stopReason: 'provider_tools_unsupported',
    content: [
      '当前模型不能执行工具型任务。',
      '',
      warning,
      '',
      '可以这样处理：',
      '- 切换到支持 tool_calls 的模型后重试。',
      '- 或改用日常/标准聊天模式，只让模型回答文字，不读取文件、不运行代码、不调用 MCP。',
    ].join('\n'),
  });
}

export function emitMcpZeroToolsStop(base: StopResponseBase) {
  const warning =
    'MCP 模式没有发现可调用工具。请先在 MCP 设置里测试 server，确认 initialize 和 listTools 成功后再发送。';
  base.warnings.push(warning);
  emitAgentStopResponse({
    ...base,
    warning,
    stopReason: 'mcp_zero_tools',
    content: [
      'MCP 目前不可用于本轮任务。',
      '',
      warning,
      '',
      '可以这样处理：',
      '- 打开 MCP 设置，测试对应 server。',
      '- 如果连接成功但工具数为 0，请检查该 MCP server 的 listTools 输出。',
      '- 或切换到“日常/标准聊天”继续文字问答。',
    ].join('\n'),
  });
}

export function emitAgentStopResponse(options: StopResponseOptions) {
  const {
    emit,
    requestId,
    content,
    warning,
    stopReason,
    maxToolRounds,
    contextMeta,
    systemPrompt,
    apiMessages,
    settings,
    prefix,
    warnings,
  } = options;

  emit(requestId, 'agentStage', {
    stage: 'warning',
    round: 0,
    maxRounds: maxToolRounds,
    warning,
    selectedTools: [],
    stopReason,
  });
  emit(requestId, 'token', { token: content });
  emit(requestId, 'contextBudget', contextMeta);
  emit(requestId, 'agentStage', {
    stage: 'stop',
    round: 0,
    maxRounds: maxToolRounds,
    stopReason,
    warning,
  });

  const usage = mergeTokenUsage(
    [
      normalizeTokenUsage(null, {
        input: estimateMessagesTokens([{ role: 'system', content: systemPrompt }, ...apiMessages]),
        output: estimateTokens(content),
        model: settings.model,
        byPurpose: { main: estimateTokens(content) },
      }),
    ],
    { warnings }
  );
  attachPrefixProfile(usage, prefix, settings);
  emit(requestId, 'tokenCount', usage);
  emit(requestId, 'done', { aborted: false, stopReason });
}
