const TOOL_STATUS_META: Record<string, { label: string; tone: string; icon: string }> = {
  pending: { label: '等待确认', tone: 'pending', icon: '…' },
  approved: { label: '已确认', tone: 'running', icon: '▶' },
  running: { label: '运行中', tone: 'running', icon: '▶' },
  denied: { label: '已拒绝', tone: 'blocked', icon: '!' },
  completed: { label: '已完成', tone: 'success', icon: '✓' },
  failed: { label: '失败', tone: 'danger', icon: '!' },
};

export function createToolRecord(event: any = {}, now = new Date()): any {
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
    editPreview: event.editPreview || null,
    backupPath: event.backupPath || '',
    restoreHint: event.restoreHint || '',
    repairReport: event.repairReport || null,
    status: event.autoApproved ? 'approved' : 'pending',
    requestedAt: now.toISOString(),
    expiresAt: event.expiresAt || '',
  };
}

export function applyToolDecision(tool: any, approved: boolean, now = new Date()): any | null {
  if (!tool) return null;
  tool.status = approved ? 'approved' : 'denied';
  if (!approved) {
    tool.ok = false;
    tool.completedAt = now.toISOString();
    tool.output = `用户拒绝执行工具 ${getToolName(tool)}。`;
  }
  return tool;
}

export function applyToolResult(toolCalls: any[] = [], event: any = {}, now = new Date()): any {
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
  if (event.editPreview !== undefined) tool.editPreview = event.editPreview;
  if (event.backupPath !== undefined) tool.backupPath = event.backupPath;
  if (event.restoreHint !== undefined) tool.restoreHint = event.restoreHint;
  if (event.repairReport !== undefined) tool.repairReport = event.repairReport;
  if (event.editEvidence !== undefined) tool.editEvidence = event.editEvidence;
  if (event.contextOutput !== undefined) tool.contextOutput = event.contextOutput;
  if (event.rawOutputTokens !== undefined) tool.rawOutputTokens = event.rawOutputTokens;
  if (event.contextOutputTokens !== undefined) tool.contextOutputTokens = event.contextOutputTokens;
  if (event.contextCompacted !== undefined) tool.contextCompacted = event.contextCompacted;
  if (event.contextCompactionRatio !== undefined) tool.contextCompactionRatio = event.contextCompactionRatio;
  if (event.contextCompactionReason) tool.contextCompactionReason = event.contextCompactionReason;
  if (event.contextCompactionType) tool.contextCompactionType = event.contextCompactionType;
  if (event.expiresAt) tool.expiresAt = event.expiresAt;
  if (event.risk) tool.risk = event.risk;
  tool.status = event.ok ? 'completed' : tool.status === 'denied' ? 'denied' : 'failed';
  tool.output = event.output;
  tool.ok = event.ok;
  tool.completedAt = event.completedAt || now.toISOString();
  tool.sources = event.sources || extractToolSources(event.output);
  return tool;
}

export function buildToolRuns(toolCalls: any[] = []): any[] {
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
    editPreview: tool.editPreview || null,
    backupPath: tool.backupPath || '',
    restoreHint: tool.restoreHint || '',
    repairReport: tool.repairReport || null,
    editEvidence: tool.editEvidence || null,
    contextOutput: tool.contextOutput || '',
    rawOutputTokens: normalizeNumber(tool.rawOutputTokens),
    contextOutputTokens: normalizeNumber(tool.contextOutputTokens),
    contextCompacted: Boolean(tool.contextCompacted),
    contextCompactionRatio: normalizeRatio(tool.contextCompactionRatio),
    contextCompactionReason: tool.contextCompactionReason || '',
    contextCompactionType: tool.contextCompactionType || '',
    expiresAt: tool.expiresAt || '',
    evidence: buildToolEvidencePayload(tool),
  }));
}

export function buildToolEvidencePayload(tool: any = {}): any {
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
    editPreview: tool.editPreview || null,
    backupPath: tool.backupPath || '',
    restoreHint: tool.restoreHint || '',
    repairReport: tool.repairReport || null,
    editEvidence: tool.editEvidence || null,
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
    contextCompactionRatio: normalizeRatio(tool.contextCompactionRatio),
    contextCompactionReason: tool.contextCompactionReason || '',
    contextCompactionType: tool.contextCompactionType || '',
    rawOutputRef: outputText ? `tool-output:${id || getToolName(tool)}` : '',
  };
}

export function getToolStatusMeta(status: string): { label: string; tone: string; icon: string } {
  return TOOL_STATUS_META[status] || { label: status || '已记录', tone: 'neutral', icon: '•' };
}

export function getToolStatusText(status: string): string {
  return getToolStatusMeta(status).label;
}

export function getToolName(tool: any): string {
  return tool?.name || tool?.function?.name || 'unknown_tool';
}

export function getToolArgs(tool: any): any {
  if (tool?.args) return tool.args;
  return parseFunctionArgs(tool?.function?.arguments);
}

export function formatToolArgs(tool: any): string {
  return JSON.stringify(getToolArgs(tool), null, 2);
}

export function getToolQuery(tool: any): string {
  const args = getToolArgs(tool);
  if (Array.isArray(args?.queries)) {
    return args.queries
      .map((item: any) => String(item || '').trim())
      .filter(Boolean)
      .join(' / ');
  }
  return String(args?.query || '').trim();
}

// ─── Product-oriented Special Summaries ────────────────────────────────────

export interface ProjectMapSummary {
  fileCount: number;
  dirCount: number;
  entryFiles: string[];
  topModules: string[];
}

export function summarizeProjectMap(outputText = ''): ProjectMapSummary {
  const text = String(outputText || '');
  const lines = text.split('\n');
  let fileCount = 0;
  const dirs = new Set<string>();
  const entryFiles: string[] = [];
  const moduleSet = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('─')) continue;
    // Tree-like entries with files have extensions or are leaf nodes
    if (/[\│├└─]/.test(line) || line.startsWith('  ') || line.startsWith('\t')) {
      const clean = trimmed.replace(/^[\│├└─\s]+/, '').replace(/\/$/, '');
      if (clean.includes('.')) {
        fileCount++;
        if (/\.(ts|js|jsx|tsx|py|go|rs|java|kt|swift)$/i.test(clean)) {
          const dir = clean.split(/[/\\]/).slice(0, -1).join('/');
          if (dir) moduleSet.add(dir.split('/')[0] || dir);
        }
        if (/^(index|main|app|server|cli|entry)\./i.test(clean)) {
          entryFiles.push(clean);
        }
      } else if (clean && !clean.includes(' ')) {
        dirs.add(clean);
      }
    }
  }

  // Fallback: count lines that look like file paths
  if (fileCount === 0) {
    for (const line of lines) {
      if (/\.\w{1,8}$/.test(line.trim()) && !line.includes('://')) fileCount++;
    }
  }

  return {
    fileCount,
    dirCount: dirs.size,
    entryFiles: entryFiles.slice(0, 5),
    topModules: Array.from(moduleSet).slice(0, 5),
  };
}

export interface GitDiffSummary {
  changedFiles: number;
  insertions: number;
  deletions: number;
  riskyFiles: string[];
}

export function summarizeGitDiff(outputText = ''): GitDiffSummary {
  const text = String(outputText || '');
  const changedFiles = (text.match(/^diff --git /gm) || []).length;
  const insertions = (text.match(/^\+[^+]/gm) || []).length;
  const deletions = (text.match(/^-[^-]/gm) || []).length;
  const riskyFiles: string[] = [];

  const fileMatches = text.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
  for (const m of fileMatches) {
    const file = m[1] || '';
    if (
      /\.(key|pem|env|secret|token|password|credential)/i.test(file) ||
      /(config|settings|auth)\.(json|yaml|yml|toml)/i.test(file) ||
      /package-lock|yarn\.lock|pnpm-lock/i.test(file)
    ) {
      riskyFiles.push(file);
    }
  }

  return { changedFiles, insertions, deletions, riskyFiles: riskyFiles.slice(0, 5) };
}

export interface GitStatusSummary {
  branch: string;
  staged: number;
  unstaged: number;
  untracked: number;
}

export function summarizeGitStatus(outputText = ''): GitStatusSummary {
  const text = String(outputText || '');
  const lines = text.split('\n');
  let branch = 'unknown';
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    if (line.startsWith('On branch ')) branch = line.replace('On branch ', '').trim();
    if (line.startsWith('HEAD detached at ')) branch = line.trim();
    if (line.startsWith('\tmodified:') || line.startsWith('\tdeleted:') || line.startsWith('\trenamed:')) {
      if (text.indexOf(line) < text.indexOf('Changes not staged') + text.indexOf('Changes to be committed')) {
        // Rough heuristic: if before "not staged" section
      }
    }
  }

  // Better heuristic: use section markers
  const notStagedIndex = text.indexOf('Changes not staged for commit');
  const toCommitIndex = text.indexOf('Changes to be committed');
  const untrackedIndex = text.indexOf('Untracked files');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('\t')) continue;
    const pos = text.indexOf(line);
    if (toCommitIndex >= 0 && pos > toCommitIndex && (notStagedIndex < 0 || pos < notStagedIndex)) staged++;
    else if (notStagedIndex >= 0 && pos > notStagedIndex && (untrackedIndex < 0 || pos < untrackedIndex)) unstaged++;
    else if (untrackedIndex >= 0 && pos > untrackedIndex) untracked++;
  }

  return { branch, staged, unstaged, untracked };
}

export interface GitLogSummary {
  commitCount: number;
  latestMessage: string;
  authors: string[];
  modules: string[];
}

export function summarizeGitLog(outputText = '', count = 10): GitLogSummary {
  const text = String(outputText || '');
  const commits = text.match(/^commit [a-f0-9]+/gm) || [];
  const lines = text.split('\n');
  let latestMessage = '';
  const authorSet = new Set<string>();
  const moduleSet = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Author: ')) {
      const author = line.replace('Author: ', '').trim().split('<')[0].trim();
      if (author) authorSet.add(author);
    }
    if (line.startsWith('Date: ') && i + 2 < lines.length) {
      const msg = lines[i + 2]?.trim();
      if (msg && !latestMessage) latestMessage = msg;
    }
    // Detect module references like "src/module" or "feat(module)"
    const moduleMatch = line.match(/(?:src|lib|app|tests|docs)\/([a-z0-9_-]+)/gi);
    if (moduleMatch) {
      for (const m of moduleMatch) moduleSet.add(m);
    }
    const scopeMatch = line.match(/\((\w+)\):/);
    if (scopeMatch) moduleSet.add(scopeMatch[1]);
  }

  return {
    commitCount: Math.min(commits.length, count),
    latestMessage,
    authors: Array.from(authorSet).slice(0, 5),
    modules: Array.from(moduleSet).slice(0, 5),
  };
}

export interface ReadManyFilesSummary {
  totalFiles: number;
  failedFiles: number;
  successfulFiles: number;
  hitSummaries: string[];
}

export function summarizeReadManyFiles(tool: any = {}): ReadManyFilesSummary {
  const args = getToolArgs(tool);
  const totalFiles = Array.isArray(args?.paths) ? args.paths.length : 0;
  const outputText = String(tool.output || '');
  const failedMatches = outputText.match(/(?:失败|error|not found|ENOENT|missing)\s*[:：]/gi) || [];
  const failedFiles = Math.min(failedMatches.length, totalFiles);
  const successfulFiles = Math.max(0, totalFiles - failedFiles);

  // Extract file hit summaries from output headers
  const hitSummaries: string[] = [];
  const fileHeaders = outputText.matchAll(/(?:文件|File)\s*[:：]\s*(.+?)(?:\n|$)/gi);
  for (const m of fileHeaders) {
    const file = m[1]?.trim();
    if (file && !hitSummaries.includes(file)) hitSummaries.push(file);
  }

  return { totalFiles, failedFiles, successfulFiles, hitSummaries: hitSummaries.slice(0, 8) };
}

export function getToolDurationMs(tool: any): number | null {
  if (!tool?.requestedAt || !tool?.completedAt) return null;
  const start = Date.parse(tool.requestedAt);
  const end = Date.parse(tool.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function extractToolSources(outputText: string): any[] {
  const lines = String(outputText || '').split('\n');
  const sources: any[] = [];
  let current: any = null;
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

export function getSearchGrounding(message: any = {}, content = ''): any {
  const runs = getSearchRuns(message);
  const sources = runs.flatMap((run) => run.sources || []);
  const urls = sources.map((source: any) => source.url).filter(Boolean);
  const cited = urls.length > 0 && urls.some((url: string) => String(content || '').includes(url));
  return {
    hasSearch: runs.length > 0,
    hasSources: urls.length > 0,
    cited,
    warning: runs.length > 0 && (!urls.length || !cited),
    queries: runs.map((run: any) => run.query || getToolQuery(run)).filter(Boolean),
    sources,
    runs,
  };
}

export function hasSearchWithoutCitedSource(message: any, content: string): boolean {
  return getSearchGrounding(message, content).warning;
}

export function getLocalFileGrounding(message: any = {}, content = ''): any {
  const runs = getLocalFileRuns(message);
  const citations = runs.flatMap((run: any) => run.localCitations || []);
  const cited = citations.length > 0 && citations.some((citation: any) => isLocalCitationMentioned(content, citation));
  return {
    hasLocalFiles: runs.length > 0,
    hasCitations: citations.length > 0,
    cited,
    warning: runs.length > 0 && citations.length > 0 && !cited,
    citations,
    runs,
  };
}

export function hasLocalFilesWithoutCitedSource(message: any, content: string): boolean {
  return getLocalFileGrounding(message, content).warning;
}

function getSearchRuns(message: any): any[] {
  const runs = message.toolRuns?.length ? message.toolRuns : buildToolRuns(message.toolCalls || []);
  return runs.filter((run: any) => run.name === 'web_search' && run.status === 'completed');
}

function getLocalFileRuns(message: any): any[] {
  const runs = message.toolRuns?.length ? message.toolRuns : buildToolRuns(message.toolCalls || []);
  return runs.filter(
    (run: any) => ['search_workspace', 'read_symbol', 'read_file'].includes(run.name) && run.status === 'completed'
  );
}

export function extractLocalCitations(outputText = '', toolName = ''): any[] {
  const lines = String(outputText || '').split('\n');
  const citations: any[] = [];
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

export function extractWorkspaceSearchResults(outputText = '', toolName = ''): any[] {
  if (toolName !== 'search_workspace') return [];
  const payload = extractStructuredJsonAfterMarker(outputText, 'Structured Results:');
  if (!payload || payload.type !== 'deepchat.workspaceSearchResults' || !Array.isArray(payload.results)) return [];
  return payload.results
    .map((result: any) => ({
      index: normalizeNumber(result.index),
      file: String(result.file || '').trim(),
      startLine: normalizeNumber(result.startLine),
      endLine: normalizeNumber(result.endLine),
      score: normalizeNumber(result.score),
      kind: String(result.kind || 'text').trim() || 'text',
      symbol: String(result.symbol || '').trim(),
      truncated: Boolean(result.truncated),
      snippet: Array.isArray(result.snippet)
        ? result.snippet
            .map((item: any) => ({
              line: normalizeNumber(item.line),
              text: String(item.text || ''),
            }))
            .filter((item: any) => item.line > 0 || item.text)
        : [],
    }))
    .filter((result: any) => result.file);
}

export function extractWorkspaceSymbolResult(outputText = '', toolName = ''): any | null {
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
    index:
      payload.index && typeof payload.index === 'object'
        ? {
            cache: String(payload.index.cache || '').trim(),
            fileCount: normalizeNumber(payload.index.fileCount),
            chunkCount: normalizeNumber(payload.index.chunkCount),
            snapshotHash: String(payload.index.snapshotHash || '').trim(),
            hash: String(payload.index.hash || '').trim(),
          }
        : null,
    result,
    alternatives: Array.isArray(payload.alternatives)
      ? payload.alternatives.map(normalizeWorkspaceSymbolHit).filter(Boolean)
      : [],
  };
}

export function extractRunCodeResult(outputText = '', toolName = ''): any | null {
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

function normalizeWorkspaceSymbolHit(hit: any): any | null {
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
      ? hit.snippet
          .map((item: any) => ({
            line: normalizeNumber(item.line),
            text: String(item.text || ''),
          }))
          .filter((item: any) => item.line > 0 || item.text)
      : [],
  };
}

function extractStructuredJsonAfterMarker(outputText = '', marker = ''): any | null {
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

function extractBalancedJsonObject(text: string, startIndex: number): string {
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

function buildLocalCitation(file: string, startLine: string | number, endLine?: string | number): any {
  const normalizedFile = String(file || '').trim();
  const start = Number.parseInt(String(startLine), 10) || 0;
  const end = Number.parseInt(String(endLine || startLine), 10) || start;
  return {
    file: normalizedFile,
    lineStart: start,
    lineEnd: end,
    label: formatLocalCitationLabel(normalizedFile, start, end),
  };
}

function formatLocalCitationLabel(file: string, lineStart: number, lineEnd: number): string {
  if (!lineStart) return file;
  return `${file}:${lineStart}${lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ''}`;
}

function dedupeLocalCitations(citations: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const citation of citations) {
    const key = `${citation.file}:${citation.lineStart}:${citation.lineEnd}`;
    if (!citation.file || seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

function isLocalCitationMentioned(content: string, citation: any): boolean {
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
  ]
    .filter(Boolean)
    .map((item) => String(item).replace(/\\/g, '/'));
  return labels.some((label) => text.includes(label));
}

function parseFunctionArgs(value: string): any {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeRatio(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
