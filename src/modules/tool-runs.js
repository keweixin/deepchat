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
    approvalPolicy: event.approvalPolicy || '',
    autoApproved: event.autoApproved === true,
    nextAction: event.nextAction || '',
    status: event.autoApproved ? 'approved' : 'pending',
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
  if (event.approvalPolicy) tool.approvalPolicy = event.approvalPolicy;
  if (event.autoApproved !== undefined) tool.autoApproved = event.autoApproved === true;
  if (event.nextAction) tool.nextAction = event.nextAction;
  if (event.contextOutput !== undefined) tool.contextOutput = event.contextOutput;
  if (event.rawOutputTokens !== undefined) tool.rawOutputTokens = event.rawOutputTokens;
  if (event.contextOutputTokens !== undefined) tool.contextOutputTokens = event.contextOutputTokens;
  if (event.contextCompacted !== undefined) tool.contextCompacted = event.contextCompacted;
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
    localCitations: extractLocalCitations(tool.output || '', getToolName(tool)),
    workspaceResults: extractWorkspaceSearchResults(tool.output || '', getToolName(tool)),
    workspaceSymbol: extractWorkspaceSymbolResult(tool.output || '', getToolName(tool)),
    runResult: extractRunCodeResult(tool.output || '', getToolName(tool)),
    query: getToolQuery(tool),
    security: tool.security || null,
    approvalPolicy: tool.approvalPolicy || '',
    autoApproved: tool.autoApproved === true,
    nextAction: tool.nextAction || '',
    parseError: tool.parseError || '',
    contextOutput: tool.contextOutput || '',
    rawOutputTokens: normalizeNumber(tool.rawOutputTokens),
    contextOutputTokens: normalizeNumber(tool.contextOutputTokens),
    contextCompacted: Boolean(tool.contextCompacted),
    expiresAt: tool.expiresAt || '',
    evidence: buildToolEvidencePayload(tool),
  }));
}

export function buildToolEvidencePayload(tool = {}) {
  const outputText = tool.output ? String(tool.output) : '';
  const sources = tool.sources || extractToolSources(outputText);
  const localCitations = extractLocalCitations(outputText, getToolName(tool));
  const workspaceResults = tool.workspaceResults || extractWorkspaceSearchResults(outputText, getToolName(tool));
  const workspaceSymbol = tool.workspaceSymbol || extractWorkspaceSymbolResult(outputText, getToolName(tool));
  const runResult = tool.runResult || extractRunCodeResult(outputText, getToolName(tool));
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
    approvalPolicy: tool.approvalPolicy || '',
    autoApproved: tool.autoApproved === true,
    nextAction: tool.nextAction || '',
    parseError: tool.parseError || '',
    sources,
    localCitations,
    workspaceResults,
    workspaceSymbol,
    runResult,
    outputPreview: outputText.slice(0, 1200),
    contextOutput: tool.contextOutput || '',
    rawOutputTokens: normalizeNumber(tool.rawOutputTokens),
    contextOutputTokens: normalizeNumber(tool.contextOutputTokens),
    contextCompacted: Boolean(tool.contextCompacted),
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

export function getLocalFileGrounding(message = {}, content = '') {
  const runs = getLocalFileRuns(message);
  const citations = runs.flatMap((run) => run.localCitations || []);
  const cited = citations.length > 0 && citations.some((citation) => isLocalCitationMentioned(content, citation));
  return {
    hasLocalFiles: runs.length > 0,
    hasCitations: citations.length > 0,
    cited,
    warning: runs.length > 0 && citations.length > 0 && !cited,
    citations,
    runs,
  };
}

export function hasLocalFilesWithoutCitedSource(message, content) {
  return getLocalFileGrounding(message, content).warning;
}

function getSearchRuns(message) {
  const runs = message.toolRuns?.length ? message.toolRuns : buildToolRuns(message.toolCalls || []);
  return runs.filter((run) => run.name === 'web_search' && run.status === 'completed');
}

function getLocalFileRuns(message) {
  const runs = message.toolRuns?.length ? message.toolRuns : buildToolRuns(message.toolCalls || []);
  return runs.filter((run) => ['search_workspace', 'read_symbol', 'read_file'].includes(run.name) && run.status === 'completed');
}

export function extractLocalCitations(outputText = '', toolName = '') {
  const lines = String(outputText || '').split('\n');
  const citations = [];
  if (toolName === 'search_workspace') {
    for (const line of lines) {
      const match = line.match(/^\s*\d+\.\s+(.+?):(\d+)(?:-(\d+))?\s*$/);
      if (!match) continue;
      citations.push(buildLocalCitation(match[1], match[2], match[3]));
    }
  }
  if (toolName === 'read_file') {
    const fileLine = lines.find((line) => /^\s*文件：/.test(line));
    const rangeLine = lines.find((line) => /^\s*行范围：/.test(line));
    const file = fileLine ? fileLine.replace(/^\s*文件：/, '').trim() : '';
    const rangeMatch = rangeLine?.match(/行范围：\s*(\d+)(?:-(\d+))?/);
    if (file && rangeMatch) citations.push(buildLocalCitation(file, rangeMatch[1], rangeMatch[2]));
    else if (file) citations.push(buildLocalCitation(file, 0, 0));
  }
  if (toolName === 'read_symbol') {
    const resultLine = lines.find((line) => /^\s*结果：/.test(line));
    const match = resultLine?.match(/结果：\s*(.+?):(\d+)(?:-(\d+))?\s*$/);
    if (match) citations.push(buildLocalCitation(match[1], match[2], match[3]));
  }
  return dedupeLocalCitations(citations);
}

export function extractWorkspaceSearchResults(outputText = '', toolName = '') {
  if (toolName !== 'search_workspace') return [];
  const payload = extractStructuredJsonAfterMarker(outputText, 'Structured Results:');
  if (!payload || payload.type !== 'deepchat.workspaceSearchResults' || !Array.isArray(payload.results)) return [];
  return payload.results
    .map((result) => ({
      index: normalizeNumber(result.index),
      file: String(result.file || '').trim(),
      startLine: normalizeNumber(result.startLine),
      endLine: normalizeNumber(result.endLine),
      score: normalizeNumber(result.score),
      kind: String(result.kind || 'text').trim() || 'text',
      symbol: String(result.symbol || '').trim(),
      truncated: Boolean(result.truncated),
      snippet: Array.isArray(result.snippet)
        ? result.snippet.map((item) => ({
          line: normalizeNumber(item.line),
          text: String(item.text || ''),
        })).filter((item) => item.line > 0 || item.text)
        : [],
    }))
    .filter((result) => result.file);
}

export function extractWorkspaceSymbolResult(outputText = '', toolName = '') {
  if (toolName !== 'read_symbol') return null;
  const payload = extractStructuredJsonAfterMarker(outputText, 'Structured Symbol:');
  if (!payload || payload.type !== 'deepchat.workspaceSymbolResult') return null;
  const result = normalizeWorkspaceSymbolHit(payload.result);
  return {
    type: payload.type,
    version: normalizeNumber(payload.version) || 1,
    symbol: String(payload.symbol || '').trim(),
    root: String(payload.root || '').trim(),
    directory: String(payload.directory || '').trim(),
    pattern: String(payload.pattern || '').trim(),
    index: payload.index && typeof payload.index === 'object' ? {
      cache: String(payload.index.cache || '').trim(),
      fileCount: normalizeNumber(payload.index.fileCount),
      chunkCount: normalizeNumber(payload.index.chunkCount),
      snapshotHash: String(payload.index.snapshotHash || '').trim(),
      hash: String(payload.index.hash || '').trim(),
    } : null,
    result,
    alternatives: Array.isArray(payload.alternatives)
      ? payload.alternatives.map(normalizeWorkspaceSymbolHit).filter(Boolean)
      : [],
  };
}

export function extractRunCodeResult(outputText = '', toolName = '') {
  if (toolName !== 'run_code') return null;
  const payload = extractStructuredJsonAfterMarker(outputText, 'Structured Run:');
  if (!payload || payload.type !== 'deepchat.runCodeResult') return null;
  return {
    type: payload.type,
    version: normalizeNumber(payload.version) || 1,
    language: String(payload.language || '').trim(),
    codeLength: normalizeNumber(payload.codeLength),
    stdinBytes: normalizeNumber(payload.stdinBytes),
    durationMs: normalizeNumber(payload.durationMs),
    exitCode: payload.exitCode === null || payload.exitCode === undefined ? null : normalizeNumber(payload.exitCode),
    timedOut: Boolean(payload.timedOut),
    ok: Boolean(payload.ok),
    stdoutBytes: normalizeNumber(payload.stdoutBytes),
    stderrBytes: normalizeNumber(payload.stderrBytes),
    stdoutPreview: String(payload.stdoutPreview || ''),
    stderrPreview: String(payload.stderrPreview || ''),
    failureHint: String(payload.failureHint || ''),
  };
}

function normalizeWorkspaceSymbolHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const file = String(hit.file || '').trim();
  if (!file) return null;
  return {
    file,
    startLine: normalizeNumber(hit.startLine),
    endLine: normalizeNumber(hit.endLine),
    definitionLine: normalizeNumber(hit.definitionLine),
    score: normalizeNumber(hit.score),
    kind: String(hit.kind || 'symbol').trim() || 'symbol',
    signature: String(hit.signature || '').trim(),
    truncated: Boolean(hit.truncated),
    snippet: Array.isArray(hit.snippet)
      ? hit.snippet.map((item) => ({
        line: normalizeNumber(item.line),
        text: String(item.text || ''),
      })).filter((item) => item.line > 0 || item.text)
      : [],
  };
}

function extractStructuredJsonAfterMarker(outputText = '', marker = '') {
  const text = String(outputText || '');
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = text.indexOf('{', start + marker.length);
  if (jsonStart < 0) return null;
  const jsonText = extractBalancedJsonObject(text, jsonStart);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function extractBalancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return '';
}

function buildLocalCitation(file, startLine, endLine) {
  const normalizedFile = String(file || '').trim();
  const start = Number.parseInt(startLine, 10) || 0;
  const end = Number.parseInt(endLine || startLine, 10) || start;
  return {
    file: normalizedFile,
    lineStart: start,
    lineEnd: end,
    label: formatLocalCitationLabel(normalizedFile, start, end),
  };
}

function formatLocalCitationLabel(file, lineStart, lineEnd) {
  if (!lineStart) return file;
  return `${file}:${lineStart}${lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ''}`;
}

function dedupeLocalCitations(citations) {
  const seen = new Set();
  const out = [];
  for (const citation of citations) {
    const key = `${citation.file}:${citation.lineStart}:${citation.lineEnd}`;
    if (!citation.file || seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

function isLocalCitationMentioned(content, citation) {
  const text = String(content || '').replace(/\\/g, '/');
  const file = String(citation.file || '').replace(/\\/g, '/');
  const basename = file.split('/').filter(Boolean).at(-1) || file;
  const lineStart = citation.lineStart ? String(citation.lineStart) : '';
  const lineEnd = citation.lineEnd && citation.lineEnd !== citation.lineStart ? String(citation.lineEnd) : '';
  const labels = [
    citation.label,
    file,
    basename,
    lineStart ? `${file}:${lineStart}` : '',
    lineStart ? `${basename}:${lineStart}` : '',
    lineStart && lineEnd ? `${file}:${lineStart}-${lineEnd}` : '',
    lineStart && lineEnd ? `${basename}:${lineStart}-${lineEnd}` : '',
  ].filter(Boolean).map((item) => String(item).replace(/\\/g, '/'));
  return labels.some((label) => text.includes(label));
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

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}
