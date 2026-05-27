import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT,
  PROVIDER_PRESETS,
  appendContextHintsToUserContent,
  applyContextMentionsToMessages,
  buildContextBudgetBundle,
  buildContextWithBudget,
  buildTavilySearchRequest,
  detectAgentIntent,
  extractContextMentions,
  getEffectiveSystemPrompt,
  getConversationUsageSummary,
  getModelCapabilities,
  getProviderPreset,
  getSettings,
  initApiSettings,
  isSkillRunnable,
  mergeTokenUsage,
  normalizeTokenUsage,
  saveSettings,
  supportsVisionModel,
} from '../src/modules/api.js';

describe('browser settings fallback', () => {
  beforeEach(async () => {
    delete window.deepchat;
    localStorage.clear();
    await initApiSettings();
  });

  it('keeps API secrets out of localStorage in browser preview mode', async () => {
    const settings = await saveSettings({
      apiKey: 'sk-local-secret',
      tavilyApiKey: 'tvly-local-secret',
      model: 'demo-model',
    });

    expect(settings.apiKey).toBe('sk-local-secret');
    expect(getSettings().tavilyApiKey).toBe('tvly-local-secret');
    expect(localStorage.getItem('dc_apiKey')).toBeNull();
    expect(localStorage.getItem('dc_tavilyApiKey')).toBeNull();
    expect(localStorage.getItem('dc_model')).toBe('demo-model');
  });

  it('does not advertise search tools in browser preview mode without a Tavily key', async () => {
    const settings = await saveSettings({
      activeSkill: 'web_search',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });

    expect(isSkillRunnable('web_search', settings)).toBe(false);
    expect(getEffectiveSystemPrompt(settings)).not.toContain('当前客户端具备联网搜索能力');
  });

  it('enables web search in browser preview mode when a Tavily key is present for this session', async () => {
    const settings = await saveSettings({
      activeSkill: 'web_search',
      tavilyApiKey: 'tvly-session-key',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });

    expect(isSkillRunnable('web_search', settings)).toBe(true);
    expect(getEffectiveSystemPrompt(settings)).toContain('当前客户端具备联网搜索能力');
  });

  it('builds auditable fresh news Tavily requests in browser mode', () => {
    const request = buildTavilySearchRequest('帮我搜索一下最新的ai新闻一个就行', { tavilyMaxResults: 5 });

    expect(request.payload.query).toMatch(/latest AI news/);
    expect(request.payload.topic).toBe('news');
    expect(request.payload.time_range).toBe('week');
    expect(request.payload.days).toBe(7);
    expect(request.payload.max_results).toBe(1);
  });

  it('strips explicit tool directives from Tavily search queries', () => {
    const request = buildTavilySearchRequest('@web:"DeepSeek cache pricing" 一个就行', { tavilyMaxResults: 5 });

    expect(request.payload.query).toBe('DeepSeek cache pricing');
    expect(request.payload.max_results).toBe(1);
  });

  it('adds enabled external skills to the effective prompt', async () => {
    const settings = await saveSettings({
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      externalSkills: [{
        id: 'skill_test',
        name: 'Test Skill',
        description: 'demo',
        content: 'Always format demo output as a checklist.',
        enabled: true,
      }],
    });

    expect(getEffectiveSystemPrompt(settings)).toContain('Test Skill');
    expect(getEffectiveSystemPrompt(settings)).toContain('Always format demo output as a checklist.');
  });

  it('marks vision-capable models so image attachments are not silently accepted by text-only models', async () => {
    let settings = await saveSettings({ model: 'deepseek-v4-flash' });
    expect(supportsVisionModel(settings)).toBe(false);

    settings = await saveSettings({ model: 'gpt-4o' });
    expect(supportsVisionModel(settings)).toBe(true);
    expect(getModelCapabilities(settings)).toMatchObject({ vision: true, streaming: true });
  });

  it('resolves provider registry presets and model capability matrix', async () => {
    expect(PROVIDER_PRESETS.map((provider) => provider.id)).toEqual(expect.arrayContaining(['deepseek', 'openai', 'openrouter', 'ollama', 'lmstudio']));

    let settings = await saveSettings({
      providerId: 'deepseek',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    expect(getProviderPreset(settings).id).toBe('deepseek');
    expect(getModelCapabilities(settings)).toMatchObject({
      providerId: 'deepseek',
      tools: true,
      thinking: true,
      promptCacheUsage: true,
      streamUsage: true,
    });

    settings = await saveSettings({
      providerId: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
    });
    expect(getProviderPreset(settings).authType).toBe('none');
    expect(getModelCapabilities(settings)).toMatchObject({
      providerId: 'ollama',
      tools: false,
      promptCacheUsage: false,
      local: true,
    });
  });

  it('normalizes DeepSeek cache hit and miss usage fields', () => {
    const usage = normalizeTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 5 },
    });

    expect(usage).toMatchObject({
      input: 100,
      output: 20,
      total: 120,
      reasoning: 5,
      cacheHit: 60,
      cacheMiss: 40,
      cacheHitRate: 0.6,
      source: 'provider',
    });
  });

  it('normalizes OpenAI cached token usage fields', () => {
    const usage = normalizeTokenUsage({
      prompt_tokens: 80,
      completion_tokens: 10,
      total_tokens: 90,
      prompt_tokens_details: { cached_tokens: 32 },
      completion_tokens_details: { reasoning_tokens: 4 },
    });

    expect(usage).toMatchObject({
      input: 80,
      output: 10,
      total: 90,
      reasoning: 4,
      cacheHit: 32,
      cacheMiss: 48,
      cacheHitRate: 0.4,
      source: 'provider',
    });
  });

  it('falls back to estimated token usage when provider usage is absent', () => {
    expect(normalizeTokenUsage(null, { input: 12, output: 8 })).toMatchObject({
      input: 12,
      output: 8,
      total: 20,
      cacheHit: 0,
      cacheMiss: 12,
      cacheHitRate: 0,
      source: 'estimated',
    });
  });

  it('merges token usage across agent rounds', () => {
    const merged = mergeTokenUsage([
      { input: 100, output: 20, total: 120, reasoning: 4, cacheHit: 50, cacheMiss: 50, source: 'provider' },
      { input: 40, output: 10, total: 50, reasoning: 2, cacheHit: 10, cacheMiss: 30, source: 'provider' },
    ]);

    expect(merged).toMatchObject({
      input: 140,
      output: 30,
      total: 170,
      reasoning: 6,
      cacheHit: 60,
      cacheMiss: 80,
      cacheHitRate: 60 / 140,
      source: 'provider',
      rounds: 2,
    });
  });

  it('trims context by token budget while keeping the latest user message', () => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'a'.repeat(200) },
      { role: 'user', content: 'latest question' },
    ];

    const trimmed = buildContextWithBudget(messages, {
      maxMessages: 20,
      maxInputTokens: 14,
    });

    expect(trimmed).toEqual([{ role: 'user', content: 'latest question' }]);
  });

  it('returns context budget metadata with dropped message counts', () => {
    const bundle = buildContextBudgetBundle([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'a'.repeat(200) },
      { role: 'user', content: 'latest question' },
    ], { maxMessages: 20, maxInputTokens: 14 });

    expect(bundle.messages).toEqual([{ role: 'user', content: 'latest question' }]);
    expect(bundle.meta).toMatchObject({
      trimmed: true,
      retainedMessages: 1,
      droppedCount: 2,
    });
  });

  it('detects smart agent intent and missing prerequisites', () => {
    const intent = detectAgentIntent('帮我搜索今天的 AI 新闻并引用来源', {
      tavilyApiKey: '',
      workspaceRoots: [],
      mcpServers: [],
    });

    expect(intent.toolMode).toBe('none');
    expect(intent.selectedTools).not.toContain('web_search');
    expect(intent.candidateTools).toContain('web_search');
    expect(intent.missingPrerequisites).toContain('Tavily API Key');
  });

  it('honors explicit @web, @run, and @changed directives before keyword guessing', () => {
    const web = detectAgentIntent('@web:"release notes"', { tavilyApiKey: 'tvly-test', workspaceRoots: [] });
    const run = detectAgentIntent('@run 验证这段逻辑', { runCodeEnabled: true, workspaceRoots: [] });
    const changed = detectAgentIntent('@changed 最近改了什么', { workspaceRoots: ['E:/repo'] });

    expect(web.toolMode).toBe('web_search');
    expect(web.selectedTools).toContain('web_search');
    expect(web.explicitDirectives).toContain('web');
    expect(web.reason).toContain('explicit_web');
    expect(run.toolMode).toBe('code_runner');
    expect(run.selectedTools).toContain('run_code');
    expect(run.explicitDirectives).toContain('code');
    expect(changed.toolMode).toBe('file_reader');
    expect(changed.selectedTools).toEqual(expect.arrayContaining(['list_files', 'search_workspace', 'read_file']));
    expect(changed.reason).toContain('explicit_changed_context');
  });

  it('extracts @file/@folder context mentions outside code blocks', () => {
    const mentions = extractContextMentions([
      '请看 @file:src/modules/api.js 和 @folder:"src/modules"',
      '```txt',
      '@file:should-not-read.env',
      '```',
      '重复 @file:src/modules/api.js',
    ].join('\n'));

    expect(mentions).toEqual([
      { type: 'file', path: 'src/modules/api.js', label: '文件 src/modules/api.js' },
      { type: 'folder', path: 'src/modules', label: '目录 src/modules' },
    ]);
  });

  it('adds selected context hints only to the latest user message', () => {
    const messages = applyContextMentionsToMessages([
      { role: 'user', content: '旧问题 @file:README.md' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '检查 @folder:src' },
    ], { workspaceRoots: ['E:/repo'] });

    expect(messages[0].content).toBe('旧问题 @file:README.md');
    expect(messages[2].content).toContain('<selected_context>');
    expect(messages[2].content).toContain('folder: src');
    expect(messages[2].content).toContain('list_files');
  });

  it('does not claim selected context was already read', () => {
    const content = appendContextHintsToUserContent('分析 @file:README.md', [
      { type: 'file', path: 'README.md' },
    ], { workspaceRoots: [] });

    expect(content).toContain('不要声称已经读取');
    expect(content).toContain('缺少工作区配置');
    expect(content).toContain('read_file');
  });

  it('ignores generated memory blocks when detecting context mentions and intent', () => {
    const content = [
      '普通聊天',
      '<related_memory>',
      '@file:.env package.json workspace',
      '</related_memory>',
      '<task_checkpoint>',
      '@web:"不要把长期任务状态误判成显式工具指令"',
      '</task_checkpoint>',
    ].join('\n');

    expect(extractContextMentions(content)).toEqual([]);
    expect(detectAgentIntent(content, { workspaceRoots: ['E:/repo'], tavilyApiKey: '' }).toolMode).toBe('none');
  });

  it('adds DeepSeek cost metadata when model pricing is known', () => {
    const usage = normalizeTokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    }, { model: 'deepseek-v4-flash' });

    expect(usage.cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(usage.cost.estimatedSavingsUsd).toBeGreaterThan(0);
  });

  it('summarizes token usage for a conversation', () => {
    const summary = getConversationUsageSummary({
      messages: [
        { role: 'assistant', tokens: { input: 10, output: 2, total: 12, cacheHit: 5, cacheMiss: 5 } },
        { role: 'assistant', tokens: { input: 20, output: 4, total: 24, cacheHit: 5, cacheMiss: 15 } },
      ],
    });

    expect(summary).toMatchObject({
      input: 30,
      output: 6,
      total: 36,
      cacheHit: 10,
      cacheMiss: 20,
      cacheHitRate: 10 / 30,
    });
  });

  it('does not leave assistant as the first retained context message', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];

    const trimmed = buildContextWithBudget(messages, {
      maxMessages: 2,
      maxInputTokens: 100,
    });

    expect(trimmed[0].role).toBe('user');
    expect(trimmed.at(-1)).toEqual({ role: 'user', content: 'third' });
  });
});
