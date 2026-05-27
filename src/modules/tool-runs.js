const TOOL_STATUS_META = {
  pending: { label: '等待确认', tone: 'pending', icon: '…' },
  approved: { label: '已确认', tone: 'running', icon: '▶' },
  running: { label: '运行中', tone: 'running', icon: '▶' },
  denied: { label: '已拒绝', tone: 'blocked', icon: '!' },
  completed: { label: '已完成', tone: 'success', icon: '✓' },
  failed: { label: '失败', tone: 'danger', icon: '!' },
};

export function createToolRecord(event = {}, now = new Date()) {
  return {
    id: event.toolCallId || event.id || `tool_${now.getTime()}`,
    name: event.name || event.function?.name || 'unknown_tool',
    args: event.args || parseFunctionArgs(event.function?.arguments),
    rawArguments: event.rawArguments || event.function?.arguments || '',
    parseError: event.parseError || '',
    risk: event.risk || '',
    security: event.security || null,
    status: 'pending',
    requestedAt: now.toISOString(),
    expiresAt: event.expiresAt || '',
  };
}

export function applyToolDecision(tool, approved, now = new Date()) {
  if (!tool) return null;
  tool.status = approved ? 'approved' : 'denied';
  if (!approved) {
    tool.ok = false;
    tool.completedAt = now.toISOString();
    tool.output = `用户拒绝执行工具 ${getToolName(tool)}。`;
  }
  return tool;
}

export function applyToolResult(toolCalls = [], event = {}, now = new Date()) {
  const id = event.toolCallId || event.id;
  let tool = toolCalls.find((item) => item.id === id);
  if (!tool) {
    tool = {
      id: id || `tool_${now.getTime()}`,
      name: event.name || 'unknown_tool',
      args: event.args || {},
      risk: event.risk || '',
      status: 'approved',
      requestedAt: event.requestedAt || now.toISOString(),
    };
    toolCalls.push(tool);
  }
  tool.name = event.name || tool.name;
  if (event.args) tool.args = event.args;
  if (event.rawArguments) tool.rawArguments = event.rawArguments;
  if (event.parseError) tool.parseError = event.parseError;
  if (event.security) tool.security = event.security;
  if (event.expiresAt) tool.expiresAt = event.expiresAt;
  if (event.risk) tool.risk = event.risk;
  tool.status = event.ok ? 'completed' : (tool.status === 'denied' ? 'denied' : 'failed');
  tool.output = event.output;
  tool.ok = event.ok;
  tool.completedAt = event.completedAt || now.toISOString();
  tool.sources = event.sources || extractToolSources(event.output);
  return tool;
}

export function buildToolRuns(toolCalls = []) {
  return (toolCalls || []).map((tool) => ({
    id: tool.id,
    name: getToolName(tool),
    args: getToolArgs(tool),
    risk: tool.risk || '',
    status: tool.status || 'pending',
    ok: tool.ok,
    requestedAt: tool.requestedAt || '',
    completedAt: tool.completedAt || '',
    durationMs: getToolDurationMs(tool),
    outputPreview: tool.output ? String(tool.output).slice(0, 1200) : '',
    sources: tool.sources || extractToolSources(tool.output || ''),
    query: getToolQuery(tool),
    security: tool.security || null,
    parseError: tool.parseError || '',
    contextOutput: tool.contextOutput || '',
    expiresAt: tool.expiresAt || '',
    evidence: buildToolEvidencePayload(tool),
  }));
}

export function buildToolEvidencePayload(tool = {}) {
  const outputText = tool.output ? String(tool.output) : '';
  const sources = tool.sources || extractToolSources(outputText);
  const id = tool.id || '';
  return {
    type: 'deepchat.toolEvidence',
    version: 1,
    id,
    name: getToolName(tool),
    status: tool.status || 'pending',
    ok: typeof tool.ok === 'boolean' ? tool.ok : null,
    risk: tool.risk || '',
    riskLevel: tool.security?.riskLevel || '',
    args: getToolArgs(tool),
    query: getToolQuery(tool),
    requestedAt: tool.requestedAt || '',
    completedAt: tool.completedAt || '',
    durationMs: getToolDurationMs(tool),
    expiresAt: tool.expiresAt || '',
    security: tool.security || null,
    parseError: tool.parseError || '',
    sources,
    outputPreview: outputText.slice(0, 1200),
    contextOutput: tool.contextOutput || '',
    rawOutputRef: outputText ? `tool-output:${id || getToolName(tool)}` : '',
  };
}

export function getToolStatusMeta(status) {
  return TOOL_STATUS_META[status] || { label: status || '已记录', tone: 'neutral', icon: '•' };
}

export function getToolStatusText(status) {
  return getToolStatusMeta(status).label;
}

export function getToolName(tool) {
  return tool?.name || tool?.function?.name || 'unknown_tool';
}

export function getToolArgs(tool) {
  if (tool?.args) return tool.args;
  return parseFunctionArgs(tool?.function?.arguments);
}

export function formatToolArgs(tool) {
  return JSON.stringify(getToolArgs(tool), null, 2);
}

export function getToolQuery(tool) {
  const args = getToolArgs(tool);
  return String(args?.query || '').trim();
}

export function getToolDurationMs(tool) {
  if (!tool?.requestedAt || !tool?.completedAt) return null;
  const start = Date.parse(tool.requestedAt);
  const end = Date.parse(tool.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function extractToolSources(outputText) {
  const lines = String(outputText || '').split('\n');
  const sources = [];
  let current = null;
  for (const line of lines) {
    const titleMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (titleMatch) {
      current = { title: titleMatch[2].trim(), url: '', publishedDate: '' };
      sources.push(current);
      continue;
    }
    if (!current) continue;
    const urlMatch = line.match(/^\s*URL:\s*(.+)$/);
    if (urlMatch) current.url = urlMatch[1].trim();
    const dateMatch = line.match(/^\s*Published:\s*(.+)$/);
    if (dateMatch) current.publishedDate = dateMatch[1].trim();
  }
  return sources.filter((source) => source.title && source.url);
}

export function getSearchGrounding(message = {}, content = '') {
  const runs = getSearchRuns(message);
  const sources = runs.flatMap((run) => run.sources || []);
  const urls = sources.map((source) => source.url).filter(Boolean);
  const cited = urls.length > 0 && urls.some((url) => String(content || '').includes(url));
  return {
    hasSearch: runs.length > 0,
    hasSources: urls.length > 0,
    cited,
    warning: runs.length > 0 && (!urls.length || !cited),
    queries: runs.map((run) => run.query || run.args?.query || '').filter(Boolean),
    sources,
    runs,
  };
}

export function hasSearchWithoutCitedSource(message, content) {
  return getSearchGrounding(message, content).warning;
}

function getSearchRuns(message) {
  const runs = message.toolRuns?.length ? message.toolRuns : buildToolRuns(message.toolCalls || []);
  return runs.filter((run) => run.name === 'web_search' && run.status === 'completed');
}

function parseFunctionArgs(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
