/**
 * Chat Answer Actions — Pure data-transformation functions for answer
 * action menus, agent plan actions, and HTML export.
 *
 * These were extracted from chat.js to reduce its size and improve testability.
 * All functions here are pure (no DOM, no chat state).
 */

import { escapeHtml } from './shared-utils.js';
import { normalizeTokenUsage } from './token-budget.js';

const ANSWER_ACTION_CONTEXT_LIMIT = 6000;

export function buildAnswerActionMenuGroups() {
  return {
    rewrite: [
      { action: 'table', label: '转表格', title: '把这条回答整理成表格' },
      { action: 'polish', label: '精排', title: '把这条回答改写成组件化精排版' },
      { action: 'code', label: '转代码', title: '把这条回答整理成可复制的代码或 patch' },
      { action: 'todo', label: 'TODO', title: '把这条回答转成可执行 TODO 清单' },
      { action: 'report', label: '报告', title: '把这条回答整理成报告版' },
    ],
    export: [
      { action: 'markdown', label: 'Markdown', title: '导出这条回答为 Markdown' },
      { action: 'html', label: 'HTML', title: '导出这条回答为可离线查看的 HTML' },
      { action: 'artifact', label: 'Artifact', title: '把这条回答保存为可下载的 Artifact' },
    ],
  };
}

export function buildAnswerActionPrompt(action: string, content = '', message: Record<string, any> | null = null) {
  const source = compactAnswerActionContext(content);
  if (!source) return '';
  const instructions: Record<string, string> = {
    shorter: '请基于下面这段上一条回答，重新输出一个更短版本。保留关键结论和必要步骤，删除展开解释，不要引入新事实。',
    deeper:
      '请基于下面这段上一条回答，重新输出一个更详细版本。补充背景、原因、取舍、风险和下一步，但不要编造未验证事实。',
    table:
      '请基于下面这段上一条回答，整理成表格优先的版本。适合对比、清单、优先级或行动项的内容用 Markdown 表格表达，最后保留简短结论。',
    polish:
      '请基于下面这段上一条回答，改写成 DeepChat 组件化精排版。使用 :::summary 给 3-5 条核心结论；有风险用 :::warning；有推荐方案用 :::decision；有步骤用 :::steps；有来源或文件证据用 :::source；有行动项用 :::todo 或 :::next。正文保持 Markdown 层级清晰；不要引入上一条回答之外的新事实，也不要输出原始 HTML。',
    code: '请基于下面这段上一条回答，提炼成可复制的代码、配置或 patch 草案。优先输出带语言标记的 fenced code block；如果上一条回答包含文件路径或函数名，先列出目标文件和修改点；如果信息不足以生成可靠代码，明确列出缺少的输入，不要编造 API、依赖或未验证实现。',
    todo: '请基于下面这段上一条回答，提炼成可执行 TODO 清单。使用 :::todo 包裹最终清单，按 P0/P1/P2 分组，每项包含动作、验收标准、依赖或风险；不要引入上一条回答之外的新事实，也不要输出原始 HTML。',
    report:
      '请基于下面这段上一条回答，整理成报告版。使用 :::summary 给 3-5 条核心结论，使用 :::decision 给推荐方案，使用 :::source 汇总上一条回答已经给出的来源或证据，使用 :::todo 给行动清单，使用 :::next 给下一步；正文按"依据 / 风险 / 建议"组织，必要时用 Markdown 表格；不要引入上一条回答之外的新事实，也不要输出原始 HTML。',
  };
  const instruction = instructions[action];
  if (!instruction) return '';
  const evidence = buildAnswerActionEvidenceSummary(message);
  const evidenceBlock = evidence ? `\n\n<answer_evidence>\n${evidence}\n</answer_evidence>` : '';
  return `${instruction}${evidenceBlock}\n\n<previous_answer>\n${source}\n</previous_answer>`;
}

export function buildAnswerActionEvidenceSummary(message: Record<string, any> | null = null) {
  if (!message || typeof message !== 'object') return '';
  const lines: string[] = [];
  const runs = Array.isArray(message.toolRuns) ? message.toolRuns.filter(Boolean) : [];
  if (runs.length) {
    lines.push('工具证据：');
    runs.slice(0, 6).forEach((run: Record<string, any>, index: number) => {
      const pieces = [
        `${index + 1}. ${run.name || 'unknown_tool'}`,
        run.status ? `status=${run.status}` : '',
        run.query ? `query=${run.query}` : '',
        run.args?.path ? `path=${run.args.path}` : '',
        run.args?.symbol ? `symbol=${run.args.symbol}` : '',
        run.durationMs !== null && run.durationMs !== undefined ? `duration=${run.durationMs}ms` : '',
      ].filter(Boolean);
      lines.push(pieces.join(' · '));
      const sources = (run.sources || [])
        .slice(0, 3)
        .map((source: Record<string, any>) => source.url || source.title)
        .filter(Boolean);
      if (sources.length) lines.push(`   sources: ${sources.join(' | ')}`);
      const citations = (run.localCitations || [])
        .slice(0, 4)
        .map((citation: Record<string, any>) => citation.label || citation.file)
        .filter(Boolean);
      if (citations.length) lines.push(`   files: ${citations.join(' | ')}`);
      if (run.contextCompacted)
        lines.push(`   context: compacted ${run.rawOutputTokens || 0}->${run.contextOutputTokens || 0} tokens`);
      if (run.parseError) lines.push(`   parseError: ${run.parseError}`);
    });
  }
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  const profile = {
    ...(message.tokens?.cacheProfile && typeof message.tokens.cacheProfile === 'object'
      ? message.tokens.cacheProfile
      : {}),
    ...(message.cacheProfile && typeof message.cacheProfile === 'object' ? message.cacheProfile : {}),
  };
  if (usage || profile?.prefixFingerprint) {
    const cacheHit = usage?.cacheHit ?? profile?.cacheHit;
    const cacheMiss = usage?.cacheMiss ?? profile?.cacheMiss;
    const cacheRate = usage?.cacheHitRate ?? profile?.cacheHitRate;
    lines.push('Token/Cache：');
    lines.push(
      [
        usage ? `input=${usage.input}` : '',
        usage ? `output=${usage.output}` : '',
        usage?.reasoning ? `reasoning=${usage.reasoning}` : '',
        cacheHit !== undefined ? `cacheHit=${cacheHit}` : '',
        cacheMiss !== undefined ? `cacheMiss=${cacheMiss}` : '',
        cacheRate !== undefined ? `cacheRate=${Math.round(Number(cacheRate || 0) * 100)}%` : '',
        profile?.prefixFingerprint ? `prefix=${profile.prefixFingerprint}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    );
  }
  if (message.contextBudget) {
    const budget = message.contextBudget;
    lines.push('上下文预算：');
    lines.push(
      [
        budget.maxInputTokens ? `maxInput=${budget.maxInputTokens}` : '',
        budget.estimatedTokens ? `estimated=${budget.estimatedTokens}` : '',
        budget.droppedMessages ? `dropped=${budget.droppedMessages}` : '',
        budget.summaryInserted ? 'summary=used' : '',
        budget.truncated ? 'history=truncated' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    );
  }
  return lines.join('\n').trim().slice(0, 2400);
}

export function buildAgentPlanExecutionSummaryParts(plan: Record<string, unknown> = {}) {
  const selectedTools = Array.isArray(plan.selectedTools)
    ? plan.selectedTools.map((tool) => String(tool || '').trim()).filter(Boolean)
    : [];
  const missing = Array.isArray(plan.missingPrerequisites) ? plan.missingPrerequisites.filter(Boolean) : [];
  const highRiskTools = selectedTools.filter((tool) => /run_code|write|delete|mcp/i.test(tool));
  const readOnlyTools = selectedTools.filter((tool) => /read|search|list|web/i.test(tool));
  const autoReadonly = (Array.isArray(plan.approvalPolicy) ? plan.approvalPolicy : []).some((item) =>
    /自动执行|自动通过|只读自动/.test(String(item || ''))
  );
  const risk = missing.length
    ? '需配置'
    : highRiskTools.length
      ? autoReadonly && readOnlyTools.length
        ? '只读自动 · 高风险确认'
        : '高风险确认'
      : readOnlyTools.length
        ? autoReadonly
          ? '只读自动'
          : '低风险读取'
        : '普通回答';
  const boundary = autoReadonly && readOnlyTools.length ? '只读自动/高风险确认边界' : '执行前会显示确认边界';
  return {
    parts: [
      `风险：${risk}`,
      plan.maxRounds ? `最多 ${plan.maxRounds} 轮` : '',
      selectedTools.length ? `工具 ${selectedTools.length} 个` : '',
      highRiskTools.length ? `高风险 ${highRiskTools.length} 个` : '',
      Array.isArray(plan.searchPlan) && plan.searchPlan.length ? `搜索 ${plan.searchPlan.length} 组` : '',
      missing.length ? `缺配置 ${missing.length} 项` : '',
      boundary,
    ].filter(Boolean),
    hasWarning: Boolean(highRiskTools.length || missing.length),
  };
}

export function buildAgentPlanActionPrompt(action: string, plan: Record<string, any> = {}) {
  const summary = serializeAgentPlanForPrompt(plan);
  if (!summary) return '';
  const instructions: Record<string, string> = {
    execute_all:
      '请按下面的 DeepChat Agent 计划继续执行。低风险读取/搜索工具按计划推进；运行代码、MCP 外部操作和任何写入动作仍必须等待我的确认。每一步完成后保留证据，最终回答说明用了哪些工具和来源。',
    single_step:
      '请只执行下面 DeepChat Agent 计划中的下一步。执行后先停下来汇报证据、结果和下一步建议，不要连续推进后续步骤。',
    revise:
      '请先修改下面的 DeepChat Agent 计划。要求：减少无关工具调用，明确每一步需要的证据，标出哪些步骤需要我确认。先输出新计划，不要立刻执行工具。',
  };
  const instruction = instructions[action];
  if (!instruction) return '';
  return `${instruction}\n\n<agent_plan>\n${summary}\n</agent_plan>`;
}

export function buildAgentPlanActionComposerOverrides(action: string) {
  if (action === 'revise') {
    return {
      enhance: false,
      activeSkill: 'none',
    };
  }
  return {
    enhance: false,
    activeSkill: 'agent_auto',
    agentExecutionMode: action === 'single_step' ? 'single_step' : 'execute_all',
  };
}

function serializeAgentPlanForPrompt(plan: Record<string, unknown> = {}) {
  if (!plan || typeof plan !== 'object') return '';
  const executionSummary = buildAgentPlanExecutionSummaryParts(plan).parts.join(' · ');
  const lines = [`模式：${plan.mode || 'unknown'}`, `最多轮数：${plan.maxRounds || ''}`, `原因：${plan.reason || ''}`];
  if (executionSummary) lines.push(`风险摘要：${executionSummary}`);
  const pushList = (label: string, values: unknown, mapper = (value: any) => value) => {
    const list = (Array.isArray(values) ? values : [])
      .map(mapper)
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!list.length) return;
    lines.push('', `${label}：`);
    list.slice(0, 10).forEach((value, index) => lines.push(`${index + 1}. ${value}`));
  };
  pushList('步骤', plan.steps);
  pushList(
    '搜索计划',
    plan.searchPlan,
    (item: Record<string, any>) => `${item.purpose || '搜索'}：${item.query}${item.reason ? `（${item.reason}）` : ''}`
  );
  pushList('预计工具', plan.selectedTools);
  pushList('候选工具', plan.candidateTools);
  pushList('缺少配置', plan.missingPrerequisites);
  pushList('审批策略', plan.approvalPolicy);
  pushList('提示', plan.warnings);
  return lines.join('\n').trim();
}

export function compactAnswerActionContext(content = '') {
  const text = String(content || '')
    .replace(/<\/previous_answer>/gi, '<\\/previous_answer>')
    .trim();
  if (text.length <= ANSWER_ACTION_CONTEXT_LIMIT) return text;
  const head = text.slice(0, Math.floor(ANSWER_ACTION_CONTEXT_LIMIT * 0.62)).trimEnd();
  const tail = text.slice(-Math.floor(ANSWER_ACTION_CONTEXT_LIMIT * 0.28)).trimStart();
  return `${head}\n\n[中间内容已省略，避免后续指令过长]\n\n${tail}`;
}

export function buildAssistantHtmlExport(contentHtml = '', options: Record<string, unknown> = {}) {
  const title = String(options.title || 'DeepChat Answer').trim() || 'DeepChat Answer';
  const generatedAt = String(options.generatedAt || new Date().toISOString());
  const html = String(contentHtml || '').trim() || '<p>空回答</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; --card: #ffffff; --border: #e2e8f0; --accent: #0f766e; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --fg: #e5e7eb; --muted: #94a3b8; --card: #111827; --border: #263244; --accent: #2dd4bf; } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 15.5px/1.78 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 40px auto; padding: 0 22px 56px; }
    header { margin-bottom: 22px; color: var(--muted); font-size: 13px; }
    article { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 26px; box-shadow: 0 16px 48px rgba(15, 23, 42, 0.08); }
    h1, h2, h3 { line-height: 1.35; color: var(--fg); }
    h2 { margin-top: 2rem; padding-bottom: .35rem; border-bottom: 1px solid var(--border); }
    a { color: var(--accent); }
    pre, code { font-family: "Cascadia Code", "Fira Code", Consolas, monospace; }
    pre { overflow: auto; padding: 14px; border-radius: 10px; background: color-mix(in srgb, var(--fg), transparent 92%); }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
    blockquote, .answer-component, .answer-summary, .answer-callout { border-left: 4px solid var(--accent); margin: 16px 0; padding: 12px 14px; background: color-mix(in srgb, var(--accent), transparent 92%); border-radius: 10px; }
    img, svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <main>
    <header>${escapeHtml(title)} · ${escapeHtml(generatedAt)}</header>
    <article>${html}</article>
  </main>
</body>
</html>`;
}
