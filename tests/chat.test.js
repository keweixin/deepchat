import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentPlanActionPrompt,
  buildAssistantHtmlExport,
  buildAnswerActionPrompt,
  getCompactMessagePreview,
  buildConversationUsageTelemetryDetails,
  buildRunCodeExplainPrompt,
  formatConversationUsageTelemetry,
  hasLocalFilesWithoutCitedSource,
  hasSearchWithoutCitedSource,
  renderAgentTimeline,
  renderAssistantAnswerHeader,
  renderAssistantArtifacts,
  renderAssistantEvidence,
  renderContextMentionStrip,
  renderConversationUsageTelemetryPanel,
  renderLatestEvidenceDrawer,
  renderToolCalls,
  shouldCompactHistoricalMessage,
  trimMessagesForRegeneration,
} from '../src/modules/chat.js';

describe('chat regeneration', () => {
  it('builds bounded follow-up prompts for answer action buttons', () => {
    const shorter = buildAnswerActionPrompt('shorter', '结论：先做组件化回答。\n\n原因：提升阅读体验。');
    const deeper = buildAnswerActionPrompt('deeper', '结论：先做组件化回答。');
    const table = buildAnswerActionPrompt('table', 'P0：证据面板\nP1：回答组件');
    const polish = buildAnswerActionPrompt('polish', '结论：组件化回答更清晰。');
    const code = buildAnswerActionPrompt('code', '修改 src/modules/chat.js，新增回答快捷动作。');
    const todo = buildAnswerActionPrompt('todo', 'P0：补证据面板\nP1：优化回答组件');
    const report = buildAnswerActionPrompt('report', '结论：先做组件化回答。\n风险：不要输出原始 HTML。');
    const long = buildAnswerActionPrompt('shorter', 'A'.repeat(9000));

    expect(shorter).toContain('更短版本');
    expect(shorter).toContain('<previous_answer>');
    expect(shorter).toContain('结论：先做组件化回答');
    expect(deeper).toContain('更详细版本');
    expect(table).toContain('Markdown 表格');
    expect(polish).toContain('组件化精排版');
    expect(polish).toContain(':::summary');
    expect(polish).toContain(':::warning');
    expect(polish).toContain(':::decision');
    expect(polish).toContain(':::steps');
    expect(polish).toContain(':::source');
    expect(polish).toContain(':::todo');
    expect(polish).toContain(':::next');
    expect(polish).toContain('不要输出原始 HTML');
    expect(polish).toContain('结论：组件化回答更清晰');
    expect(code).toContain('可复制的代码');
    expect(code).toContain('fenced code block');
    expect(code).toContain('目标文件');
    expect(code).toContain('不要编造 API');
    expect(code).toContain('src/modules/chat.js');
    expect(todo).toContain('TODO 清单');
    expect(todo).toContain(':::todo');
    expect(todo).toContain('验收标准');
    expect(todo).toContain('不要输出原始 HTML');
    expect(todo).toContain('P0：补证据面板');
    expect(report).toContain('报告版');
    expect(report).toContain(':::summary');
    expect(report).toContain(':::decision');
    expect(report).toContain(':::source');
    expect(report).toContain(':::todo');
    expect(report).toContain(':::next');
    expect(report).toContain('不要输出原始 HTML');
    expect(long.length).toBeLessThan(6500);
    expect(long).toContain('中间内容已省略');
    expect(buildAnswerActionPrompt('unknown', 'content')).toBe('');
  });

  it('builds portable HTML exports for polished assistant answers', () => {
    const html = buildAssistantHtmlExport(
      '<h2>核心结论</h2><div class="answer-component answer-component-summary">可以离线查看。</div>',
      { title: 'DeepChat 回答 #1', generatedAt: '2026-05-27T09:30:00.000Z' },
    );

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>DeepChat 回答 #1</title>');
    expect(html).toContain('2026-05-27T09:30:00.000Z');
    expect(html).toContain('answer-component-summary');
    expect(html).toContain('max-width: 860px');
  });

  it('builds bounded plan action prompts from agent plans', () => {
    const prompt = buildAgentPlanActionPrompt('single_step', {
      mode: 'workspace',
      maxRounds: 3,
      reason: '需要读取本地证据',
      steps: ['搜索项目结构', '读取 UI 文件'],
      searchPlan: [{ purpose: '定位', query: 'agent plan UI', reason: '确认入口' }],
      selectedTools: ['search_workspace', 'run_code'],
      candidateTools: ['read_symbol'],
      approvalPolicy: ['运行代码必须确认'],
      warnings: ['缺少 Tavily Key 时不要编造来源'],
    });

    expect(prompt).toContain('只执行');
    expect(prompt).toContain('<agent_plan>');
    expect(prompt).toContain('模式：workspace');
    expect(prompt).toContain('风险摘要：风险：高风险确认');
    expect(prompt).toContain('高风险 1 个');
    expect(prompt).toContain('1. 搜索项目结构');
    expect(prompt).toContain('定位：agent plan UI');
    expect(prompt).toContain('候选工具');
    expect(prompt).toContain('read_symbol');
    expect(prompt).toContain('运行代码必须确认');
    expect(prompt).toContain('提示');
    expect(prompt).toContain('缺少 Tavily Key 时不要编造来源');
    expect(buildAgentPlanActionPrompt('unknown', { mode: 'workspace' })).toBe('');
  });

  it('truncates from the selected assistant message instead of the last message', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'second answer' },
    ];

    expect(trimMessagesForRegeneration(messages, 1)).toEqual([
      { role: 'user', content: 'one' },
    ]);
  });

  it('does not truncate when the selected message is not an assistant response', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
    ];

    expect(trimMessagesForRegeneration(messages, 0)).toBe(messages);
  });

  it('flags searched answers that do not cite returned source urls', () => {
    const message = {
      toolRuns: [{
        name: 'web_search',
        status: 'completed',
        sources: [{ title: 'Source', url: 'https://example.com/news' }],
      }],
    };

    expect(hasSearchWithoutCitedSource(message, '根据搜索结果，新闻如下。')).toBe(true);
    expect(hasSearchWithoutCitedSource(message, '来源：https://example.com/news')).toBe(false);
  });

  it('flags local file answers that do not cite file line evidence', () => {
    const message = {
      toolRuns: [{
        name: 'search_workspace',
        status: 'completed',
        localCitations: [{ file: 'src/agent.md', lineStart: 2, lineEnd: 3, label: 'src/agent.md:2-3' }],
      }],
    };

    expect(hasLocalFilesWithoutCitedSource(message, '根据本地文件，缓存命中需要固定前缀。')).toBe(true);
    expect(hasLocalFilesWithoutCitedSource(message, '根据 src/agent.md:2-3，缓存命中需要固定前缀。')).toBe(false);
  });

  it('renders local file grounding evidence next to assistant messages', () => {
    const container = document.createElement('div');
    const message = {
      content: '根据本地文件，缓存命中需要固定前缀。',
      toolRuns: [{
        name: 'search_workspace',
        status: 'completed',
        localCitations: [{ file: 'src/agent.md', lineStart: 2, lineEnd: 3, label: 'src/agent.md:2-3' }],
      }],
    };

    renderAssistantEvidence(container, message);

    expect(container.textContent).toContain('本轮工具证据');
    expect(container.textContent).toContain('1 个工具');
    expect(container.textContent).toContain('未被回答引用');
    expect(container.textContent).toContain('引用明细');
    expect(container.textContent).toContain('未引用: src/agent.md:2-3');
    expect(container.textContent).toContain('本地文件证据未被明确引用');
    expect(container.textContent).toContain('src/agent.md:2-3');
  });

  it('renders detailed tool evidence panel with sources, symbols, and cache', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const message = {
      content: '根据 src/agent.md:2-3 和 https://example.com/news 可知。',
      tokens: {
        input: 100,
        output: 20,
        total: 120,
        cacheHit: 60,
        cacheMiss: 40,
        cacheHitRate: 0.6,
        source: 'provider',
      },
      cacheProfile: { prefixFingerprint: 'abc123' },
      toolRuns: [
        {
          id: 'web1',
          name: 'web_search',
          status: 'completed',
          ok: true,
          query: 'deepchat agent',
          sources: [{ title: 'Agent Notes', url: 'https://example.com/news' }],
          outputPreview: '联网搜索结果',
        },
        {
          id: 'sym1',
          name: 'read_symbol',
          status: 'completed',
          ok: true,
          args: { symbol: 'buildContextBudgetBundle' },
          localCitations: [{ file: 'src/agent.md', lineStart: 2, lineEnd: 3, label: 'src/agent.md:2-3' }],
          workspaceSymbol: {
            symbol: 'buildContextBudgetBundle',
            result: { file: 'src/agent.md', startLine: 2, endLine: 3 },
          },
          contextCompacted: true,
          rawOutputTokens: 900,
          contextOutputTokens: 120,
        },
      ],
    };

    renderAssistantEvidence(container, message);

    expect(container.textContent).toContain('本轮工具证据');
    expect(container.textContent).toContain('2 个工具');
    expect(container.textContent).toContain('Agent Notes');
    expect(container.textContent).toContain('buildContextBudgetBundle src/agent.md:2-3');
    expect(container.textContent).toContain('已被回答引用');
    expect(container.textContent).toContain('已引用: Agent Notes');
    expect(container.textContent).toContain('已引用: src/agent.md:2-3');
    expect(container.textContent).toContain('已压缩 900→120 tokens');
    expect(container.textContent).toContain('cache 60%');
    expect(container.textContent).toContain('prefix abc123');

    container.querySelector('.tool-evidence-actions .tool-copy-btn').click();
    await Promise.resolve();

    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'deepchat.messageEvidence',
      version: 1,
      tokens: { input: 100, output: 20, cacheHit: 60 },
    });
    expect(payload.toolRuns).toHaveLength(2);
    expect(payload.toolRuns[1].workspaceSymbol.result.file).toBe('src/agent.md');
    expect(payload.toolRuns[0].citationStatus).toMatchObject({ state: 'is-cited', cited: 1, total: 1 });
    expect(payload.toolRuns[1].citationStatus).toMatchObject({ state: 'is-cited', cited: 1, total: 1 });
    expect(payload.toolRuns[0].citationStatus.refs[0]).toMatchObject({ cited: true });
    expect(payload.toolRuns[1].citationStatus.refs[0]).toMatchObject({ cited: true });
  });

  it('shows per-source citation status for partially cited evidence', async () => {
    const container = document.createElement('div');
    const message = {
      content: '最终回答只引用 https://example.com/used。',
      toolRuns: [{
        id: 'web1',
        name: 'web_search',
        status: 'completed',
        ok: true,
        sources: [
          { title: 'Used Source', url: 'https://example.com/used' },
          { title: 'Missed Source', url: 'https://example.com/missed' },
        ],
      }],
    };

    renderAssistantEvidence(container, message);

    expect(container.textContent).toContain('部分证据已引用');
    expect(container.textContent).toContain('已引用: Used Source');
    expect(container.textContent).toContain('未引用: Missed Source');
  });

  it('renders local workspace citations in tool result cards', () => {
    const container = document.createElement('div');
    renderToolCalls(container, [{
      id: 'tool-search',
      name: 'search_workspace',
      status: 'completed',
      ok: true,
      args: { query: 'cache telemetry' },
      output: [
        '工作区搜索：cache telemetry',
        '结果数：1',
        '',
        '1. src/agent.md:2-3',
        '   摘录:',
        '   2: DeepSeek cache telemetry should explain hit and miss tokens.',
      ].join('\n'),
    }]);

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('本地引用 (1)');
    expect(container.textContent).toContain('src/agent.md:2-3');
    expect(container.textContent).toContain('输出摘要');
  });

  it('renders tool recovery suggestions in tool result cards', () => {
    const input = document.createElement('textarea');
    input.id = 'message-input';
    document.body.appendChild(input);
    const container = document.createElement('div');
    renderToolCalls(container, [{
      id: 'tool-fail',
      name: 'web_search',
      status: 'failed',
      ok: false,
      args: { query: 'DeepChat' },
      output: 'Tavily 搜索失败',
      nextAction: '检查 Tavily Key 后重试。',
    }]);

    expect(container.textContent).toContain('下一步');
    expect(container.textContent).toContain('检查 Tavily Key 后重试');
    expect(container.textContent).toContain('生成修复提示');

    container.querySelector('.tool-repair-btn').click();

    expect(input.value).toContain('请基于下面这次工具调用失败信息');
    expect(input.value).toContain('<failed_tool>');
    expect(input.value).toContain('工具：web_search');
    expect(input.value).toContain('Tavily 搜索失败');
    expect(input.value).toContain('等待我确认');

    input.remove();
  });

  it('renders assistant answer header with model, tools, usage, and cache', () => {
    const container = document.createElement('div');
    renderAssistantAnswerHeader(container, {
      content: '根据工具结果，下一步先修复 Tavily 配置。',
      model: 'deepseek-v4-flash',
      tokens: {
        input: 1000,
        output: 250,
        total: 1250,
        reasoning: 30,
        cacheHit: 750,
        cacheMiss: 250,
        source: 'provider',
      },
      contextBudget: {
        trimmed: true,
        droppedCount: 2,
        prefixFingerprint: 'abc123',
      },
      agentStages: [{ stage: 'plan', round: 0 }, { stage: 'tool_result', round: 2 }],
      toolRuns: [
        { name: 'read_file', status: 'completed', ok: true },
        { name: 'web_search', status: 'failed', ok: false },
      ],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('回答概览');
    expect(container.textContent).toContain('执行结果');
    expect(container.textContent).toContain('deepseek-v4-flash');
    expect(container.textContent).toContain('工具 2 · 1 失败');
    expect(container.textContent).toContain('Agent 2 轮');
    expect(container.textContent).toContain('实测 1.3k tok');
    expect(container.textContent).toContain('缓存 75%');
    expect(container.textContent).toContain('思考 30 tok');
    expect(container.textContent).toContain('裁剪 2 条历史');
    expect(container.querySelector('.answer-header').title).toContain('Prefix: abc123');
  });

  it('renders assistant HTML artifacts in a sandboxed preview', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const artifacts = renderAssistantArtifacts(container, {
      content: '```html\n<section><h1>仪表盘</h1><script>window.top.alert(1)</script></section>\n```',
    });

    expect(artifacts).toHaveLength(1);
    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('Artifacts');
    expect(container.textContent).toContain('脚本禁用');

    container.querySelector('.artifact-action-btn.primary').click();

    const overlay = document.querySelector('.artifact-preview-overlay');
    const iframe = overlay.querySelector('iframe');
    expect(overlay.textContent).toContain('沙箱预览');
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.srcdoc).toContain("script-src 'none'");

    overlay.querySelector('.artifact-preview-close').click();
    expect(document.querySelector('.artifact-preview-overlay')).toBeNull();
    container.remove();
  });

  it('renders bounded tool output summaries and copies evidence JSON', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderToolCalls(container, [{
      id: 'tool-code',
      name: 'run_code',
      status: 'completed',
      ok: true,
      args: { language: 'javascript', code: 'console.log("测试完成")' },
      requestedAt: '2026-05-27T12:00:00.000Z',
      completedAt: '2026-05-27T12:00:01.000Z',
      output: [
        '退出码：0',
        '耗时：8ms',
        'Structured Run:',
        JSON.stringify({
          type: 'deepchat.runCodeResult',
          version: 1,
          language: 'javascript',
          codeLength: 24,
          stdinBytes: 0,
          durationMs: 8,
          exitCode: 0,
          timedOut: false,
          ok: true,
          stdoutBytes: 12,
          stderrBytes: 0,
          stdoutPreview: '测试完成',
          stderrPreview: '',
          failureHint: '',
        }),
        'stdout:',
        '测试完成',
        '```js',
        'const secret = "long code";',
        '```',
      ].join('\n'),
    }]);

    expect(container.textContent).toContain('输出摘要');
    expect(container.textContent).toContain('代码实验');
    expect(container.textContent).toContain('语言 javascript');
    expect(container.textContent).toContain('STDOUT · 12 bytes');
    expect(container.textContent).toContain('退出码：0');
    expect(container.textContent).toContain('复制代码');
    expect(container.textContent).toContain('重新运行');
    expect(container.textContent).not.toContain('解释错误');

    container.querySelector('.tool-copy-row .tool-copy-btn').click();
    await Promise.resolve();

    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'deepchat.toolEvidence',
      id: 'tool-code',
      name: 'run_code',
      status: 'completed',
      ok: true,
      durationMs: 1000,
      rawOutputRef: 'tool-output:tool-code',
      runResult: { language: 'javascript', exitCode: 0, durationMs: 8 },
    });
    expect(payload.outputPreview).toContain('测试完成');

    container.querySelector('.action-copy-code').click();
    await Promise.resolve();
    expect(writeText.mock.calls.at(-1)[0]).toBe('console.log("测试完成")');

    const input = document.createElement('textarea');
    input.id = 'message-input';
    document.body.appendChild(input);
    container.querySelector('.action-rerun').click();
    expect(input.value).toContain('请重新运行下面这段代码');
    expect(input.value).toContain('运行前仍需我确认 run_code 工具调用');
    expect(input.value).toContain('console.log("测试完成")');
    input.remove();
  });

  it('builds run_code failure explanation prompts with bounded evidence', () => {
    const prompt = buildRunCodeExplainPrompt(
      { args: { language: 'python', code: 'raise RuntimeError("boom")' } },
      {
        language: 'python',
        ok: false,
        exitCode: 1,
        durationMs: 18,
        failureHint: '检查异常堆栈',
        stderrPreview: 'Traceback\nRuntimeError: boom',
        stdoutPreview: 'before crash',
      }
    );

    expect(prompt).toContain('为什么失败');
    expect(prompt).toContain('退出码：1');
    expect(prompt).toContain('检查异常堆栈');
    expect(prompt).toContain('Traceback');
    expect(prompt).toContain('raise RuntimeError');
    expect(prompt).toContain('不要自动执行工具');
  });

  it('labels selected symbol context as a symbol chip', () => {
    const strip = renderContextMentionStrip('解释 @symbol:buildContextBudgetBundle 和 @file:src/modules/api.js');

    expect(strip.textContent).toContain('符号 buildContextBudgetBundle');
    expect(strip.textContent).toContain('文件 src/modules/api.js');
  });

  it('renders agent stages and context budget metadata', () => {
    const container = document.createElement('div');
    renderAgentTimeline(container, {
      contextBudget: {
        maxInputTokens: 24000,
        estimatedInputTokens: 12000,
        prefixFingerprint: 'abc123',
        trimmed: true,
        droppedCount: 3,
        summaryUsed: true,
      },
      agentStages: [
        {
          stage: 'plan',
          intent: { toolMode: 'web_search' },
          round: 0,
          planSummary: {
            mode: 'web_search',
            confidence: 0.8,
            maxRounds: 3,
            steps: ['理解用户目标', '检索外部资料', '整理回答并说明来源'],
            selectedTools: ['web_search', 'run_code'],
            searchPlan: [
              {
                purpose: '官方资料',
                query: 'DeepSeek cache official documentation',
                reason: '先确认官方定义。',
              },
              {
                purpose: 'GitHub / Issue',
                query: 'DeepSeek cache GitHub issues implementation',
                reason: '查真实实现。',
              },
            ],
            approvalPolicy: ['读取/搜索类工具会先展示审批卡，确认后执行并保留证据。'],
          },
        },
        { stage: 'memory', warning: '检索到 2 条相关历史', round: 0 },
        { stage: 'tool_pending', toolName: 'web_search', round: 1 },
        { stage: 'final', round: 2 },
      ],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('规划工具：web_search');
    expect(container.textContent).toContain('任务计划');
    expect(container.textContent).toContain('风险：高风险确认');
    expect(container.textContent).toContain('工具 2 个');
    expect(container.textContent).toContain('高风险 1 个');
    expect(container.textContent).toContain('搜索 2 组');
    expect(container.textContent).toContain('执行前会显示确认边界');
    expect(container.textContent).toContain('上下文：12k / 24k tok');
    expect(container.textContent).toContain('已裁剪 3 条历史');
    expect(container.textContent).toContain('已使用长期记忆');
    expect(container.textContent).toContain('检索外部资料');
    expect(container.textContent).toContain('搜索计划');
    expect(container.textContent).toContain('DeepSeek cache official documentation');
    expect(container.textContent).toContain('预计工具');
    expect(container.textContent).toContain('审批策略');
    expect(container.textContent).toContain('执行全部');
    expect(container.textContent).toContain('单步执行');
    expect(container.textContent).toContain('修改计划');
    expect(container.textContent).toContain('取消生成');
    expect(container.textContent).toContain('prefix abc123');
    expect(container.textContent).toContain('裁剪 3 条');
    expect(container.textContent).toContain('检索历史');
    expect(container.textContent).toContain('等待确认');
  });

  it('fills the composer when revising an agent plan from the timeline', () => {
    const input = document.createElement('textarea');
    input.id = 'message-input';
    document.body.appendChild(input);
    const container = document.createElement('div');

    renderAgentTimeline(container, {
      agentStages: [{
        stage: 'plan',
        round: 0,
        planSummary: {
          mode: 'multi_tool',
          maxRounds: 3,
          steps: ['读取文件', '整理证据'],
          selectedTools: ['read_file'],
        },
      }],
    });
    container.querySelector('.agent-plan-action-btn.action-revise').click();

    expect(input.value).toContain('请先修改');
    expect(input.value).toContain('<agent_plan>');
    expect(input.value).toContain('读取文件');
    input.remove();
  });

  it('formats compact conversation usage telemetry for the chat header', () => {
    const telemetry = formatConversationUsageTelemetry({
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        cacheStabilityReasons: ['tool_schema_changed'],
      },
      messages: [
        {
          role: 'assistant',
          tokens: {
            input: 1200,
            output: 300,
            total: 1500,
            reasoning: 40,
            cacheHit: 900,
            cacheMiss: 300,
            rounds: 2,
            cost: {
              estimatedCostUsd: 0.0002,
              estimatedSavingsUsd: 0.0001,
            },
          },
        },
      ],
    });

    expect(telemetry.text).toContain('1.5k tok');
    expect(telemetry.text).toContain('缓存 75%');
    expect(telemetry.text).toContain('2 轮');
    expect(telemetry.title).toContain('本会话 Token / Cache 汇总');
    expect(telemetry.title).toContain('Prefix: abc123');
    expect(telemetry.title).toContain('工具 schema 变化');
  });

  it('builds detailed cache telemetry for the conversation panel', () => {
    const details = buildConversationUsageTelemetryDetails({
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        prefixBytes: 2048,
        systemHash: 'sys1',
        toolsHash: 'tools1',
        workspaceSignature: 'workspace1',
        cacheStabilityReasons: ['system_prompt_changed'],
        cacheStabilityDetails: {
          systemHash: { previous: 'old', current: 'sys1' },
        },
        cacheStabilityWarnings: ['下一轮缓存可能下降'],
      },
      messages: [{
        role: 'assistant',
        tokens: {
          input: 1000,
          output: 250,
          total: 1250,
          cacheHit: 700,
          cacheMiss: 300,
          source: 'provider',
          byPurpose: { main: 1250 },
          cost: {
            estimatedCostUsd: 0.0002,
            estimatedSavingsUsd: 0.00009,
            inputCacheHitCostUsd: 0.00001,
            inputCacheMissCostUsd: 0.00004,
            outputCostUsd: 0.00007,
          },
        },
      }],
    });

    expect(details.sourceLabel).toBe('服务商真实 usage');
    expect(details.hitRateLabel).toBe('70%');
    expect(details.profile.systemHash).toBe('sys1');
    expect(details.reasons).toEqual(['system_prompt_changed']);
    expect(details.detailText).toContain('systemHash');
    expect(details.warnings).toContain('下一轮缓存可能下降');
  });

  it('renders a readable cache telemetry panel', () => {
    const container = document.createElement('div');

    renderConversationUsageTelemetryPanel(container, {
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        systemHash: 'sys1',
        toolsHash: 'tools1',
        cacheStabilityReasons: ['workspace_or_mcp_changed'],
      },
      messages: [{
        role: 'assistant',
        tokens: {
          input: 1000,
          output: 200,
          total: 1200,
          cacheHit: 800,
          cacheMiss: 200,
          cost: {
            estimatedCostUsd: 0.0002,
            estimatedSavingsUsd: 0.0001,
          },
        },
      }],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('本会话 Token / Cache');
    expect(container.textContent).toContain('Cache hit');
    expect(container.textContent).toContain('800');
    expect(container.textContent).toContain('Prefix hash');
    expect(container.textContent).toContain('abc123');
    expect(container.textContent).toContain('工作区/MCP 变化');
  });

  it('renders the latest assistant evidence in a drawer payload', async () => {
    const container = document.createElement('aside');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderLatestEvidenceDrawer(container, {
      title: 'Agent 优化',
      messages: [
        { role: 'assistant', content: '旧回答', toolRuns: [{ name: 'web_search', status: 'completed' }] },
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: '根据 src/modules/chat.js:10-12 可知。',
          tokens: { input: 900, output: 100, total: 1000, cacheHit: 600, cacheMiss: 300 },
          agentStages: [{ stage: 'plan', round: 0, intent: { toolMode: 'multi_tool' } }],
          toolRuns: [{
            id: 'read1',
            name: 'read_file',
            status: 'completed',
            ok: true,
            args: { path: 'src/modules/chat.js' },
            localCitations: [{ file: 'src/modules/chat.js', lineStart: 10, lineEnd: 12, label: 'src/modules/chat.js:10-12' }],
            outputPreview: '读取聊天模块',
          }],
        },
      ],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('证据面板');
    expect(container.textContent).toContain('Agent 优化');
    expect(container.textContent).toContain('消息 #3');
    expect(container.textContent).toContain('Agent 过程');
    expect(container.textContent).toContain('multi_tool');
    expect(container.textContent).toContain('read_file');
    expect(container.textContent).toContain('src/modules/chat.js:10-12');
    expect(container.textContent).toContain('已被回答引用');
    expect(container.textContent).toContain('已引用: src/modules/chat.js:10-12');
    expect(container.textContent).toContain('Token / Cache');
    expect(container.textContent).toContain('hit 600');

    container.querySelector('.evidence-drawer-actions .tool-copy-btn').click();
    await Promise.resolve();

    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.type).toBe('deepchat.messageEvidence');
    expect(payload.toolRuns[0].name).toBe('read_file');
    expect(payload.toolRuns[0].citationStatus).toMatchObject({ state: 'is-cited', cited: 1, total: 1 });
    expect(payload.toolRuns[0].citationStatus.refs[0].cited).toBe(true);
    expect(payload.tokens.cacheHit).toBe(600);
  });

  it('hides conversation usage telemetry when there is no token usage', () => {
    expect(formatConversationUsageTelemetry({ messages: [] })).toBeNull();
    const container = document.createElement('div');
    expect(renderConversationUsageTelemetryPanel(container, { messages: [] })).toBeNull();
    expect(container.hidden).toBe(true);
  });

  it('compacts only old long assistant messages without execution evidence', () => {
    const longMessage = { role: 'assistant', content: 'x'.repeat(900) };

    expect(shouldCompactHistoricalMessage(100, 20, longMessage, 60)).toBe(true);
    expect(shouldCompactHistoricalMessage(100, 50, longMessage, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { role: 'user', content: longMessage.content }, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { ...longMessage, toolRuns: [{ name: 'web_search' }] }, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { ...longMessage, agentStages: [{ stage: 'plan' }] }, 60)).toBe(false);
  });

  it('normalizes compact previews without exposing full code blocks', () => {
    const preview = getCompactMessagePreview([
      '# 标题',
      '',
      '正文内容',
      '```js',
      'const secret = "long code";',
      '```',
      '结尾',
    ].join('\n'), 80);

    expect(preview).toContain('标题');
    expect(preview).toContain('[代码片段]');
    expect(preview).not.toContain('const secret');
  });
});
