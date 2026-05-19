import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT,
  buildTavilySearchRequest,
  getEffectiveSystemPrompt,
  getModelCapabilities,
  getSettings,
  initApiSettings,
  isSkillRunnable,
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
});
