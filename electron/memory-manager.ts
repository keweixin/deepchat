// @ts-check
/**
 * Three-layer memory system for DeepChat.
 *
 * Session Memory  — ephemeral, in-memory Map tracking current conversation state.
 * Project Memory  — persistent JSON file storing project-level facts.
 * Evidence Memory — persistent JSON file storing tool evidence with LRU eviction.
 *
 * All file I/O is delegated to the caller-provided `readJson` / `writeJson`
 * helpers so the module stays testable without Electron runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMemoryEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface ProjectMemoryFact {
  id: string;
  fact: string;
  category: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceMemoryEntry {
  id: string;
  sourceTool: string;
  content: string;
  timestamp: string;
  conversationId: string;
  messageIndex: number;
}

export interface FormattedMemory {
  text: string;
  sessionCount: number;
  projectCount: number;
  evidenceCount: number;
}

export type ReadJsonFn = (fileName: string, fallback: unknown) => Promise<unknown>;
export type WriteJsonFn = (fileName: string, value: unknown) => Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_MEMORY_FILE = 'project-memory.json';
const EVIDENCE_MEMORY_FILE = 'evidence-memory.json';
const EVIDENCE_MAX_ENTRIES = 1000;
const CONTEXT_MAX_SESSION = 8;
const CONTEXT_MAX_PROJECT = 6;
const CONTEXT_MAX_EVIDENCE = 5;
const CONTEXT_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _sessionMemory: Map<string, SessionMemoryEntry> = new Map();
let _projectMemory: ProjectMemoryFact[] = [];
let _evidenceMemory: EvidenceMemoryEntry[] = [];
let _readJson: ReadJsonFn | null = null;
let _writeJson: WriteJsonFn | null = null;
let _initialized = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeText(text: unknown): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractSearchTerms(query: string): string[] {
  const cleaned = normalizeText(query);
  const matches = cleaned.match(/[a-z0-9_./-]{3,}|[一-龥]{2,}/g) || [];
  const stopWords = new Set([
    '这个',
    '那个',
    '一下',
    '帮我',
    '请你',
    '怎么',
    '为什么',
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'from',
  ]);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const term = match.trim();
    if (term.length < 2 || stopWords.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 10) break;
  }
  return terms;
}

function scoreFact(fact: ProjectMemoryFact, terms: string[]): number {
  const text = normalizeText(fact.fact);
  const cat = normalizeText(fact.category);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += Math.min(6, Math.max(1, term.length / 2));
    if (cat.includes(term)) score += 3;
  }
  return score;
}

function scoreEvidence(entry: EvidenceMemoryEntry, terms: string[]): number {
  const content = normalizeText(entry.content);
  const source = normalizeText(entry.sourceTool);
  let score = 0;
  for (const term of terms) {
    if (content.includes(term)) score += Math.min(6, Math.max(1, term.length / 2));
    if (source.includes(term)) score += 2;
  }
  return score;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}...`;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Load persistent memories from disk. Call once at app startup.
 * Pass the storage helpers so the module does not depend on Electron directly.
 */
export async function initMemoryManager(readJson: ReadJsonFn, writeJson: WriteJsonFn): Promise<void> {
  _readJson = readJson;
  _writeJson = writeJson;
  _sessionMemory.clear();

  try {
    const projectData = await readJson(PROJECT_MEMORY_FILE, []);
    _projectMemory = Array.isArray(projectData) ? (projectData as ProjectMemoryFact[]) : [];
  } catch {
    _projectMemory = [];
  }

  try {
    const evidenceData = await readJson(EVIDENCE_MEMORY_FILE, []);
    _evidenceMemory = Array.isArray(evidenceData) ? (evidenceData as EvidenceMemoryEntry[]) : [];
  } catch {
    _evidenceMemory = [];
  }

  _initialized = true;
}

/** Check whether the manager has been initialised. */
export function isMemoryManagerInitialized(): boolean {
  return _initialized;
}

// ---------------------------------------------------------------------------
// Session Memory (ephemeral)
// ---------------------------------------------------------------------------

/** Add or update a session memory entry. */
export function addSessionMemory(key: string, value: unknown): void {
  _sessionMemory.set(key, {
    key,
    value,
    updatedAt: now(),
  });
}

/** Get a session memory entry by key, or undefined. */
export function getSessionMemory(key: string): SessionMemoryEntry | undefined {
  return _sessionMemory.get(key);
}

/** Clear all session memory (e.g. when conversation switches). */
export function clearSessionMemory(): void {
  _sessionMemory.clear();
}

/** Get all session memory entries. */
export function getAllSessionMemory(): SessionMemoryEntry[] {
  return Array.from(_sessionMemory.values());
}

// ---------------------------------------------------------------------------
// Project Memory (persistent)
// ---------------------------------------------------------------------------

/** Add a project-level fact. */
export async function addProjectMemory(
  fact: string,
  category: string = 'general',
  conversationId: string = ''
): Promise<ProjectMemoryFact> {
  const entry: ProjectMemoryFact = {
    id: newId(),
    fact,
    category,
    conversationId,
    createdAt: now(),
    updatedAt: now(),
  };
  _projectMemory.push(entry);
  await _persistProjectMemory();
  return entry;
}

/** Search project facts by keyword. */
export function getProjectMemory(query: string): ProjectMemoryFact[] {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const scored = _projectMemory
    .map((fact) => ({ fact, score: scoreFact(fact, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONTEXT_MAX_PROJECT);

  return scored.map((item) => item.fact);
}

/** Get all project memory entries. */
export function getAllProjectMemory(): ProjectMemoryFact[] {
  return [..._projectMemory];
}

// ---------------------------------------------------------------------------
// Evidence Memory (persistent, LRU)
// ---------------------------------------------------------------------------

/** Add a tool evidence entry. LRU eviction when over max. */
export async function addEvidenceMemory(
  sourceTool: string,
  content: string,
  conversationId: string = '',
  messageIndex: number = 0
): Promise<EvidenceMemoryEntry> {
  const entry: EvidenceMemoryEntry = {
    id: newId(),
    sourceTool,
    content,
    timestamp: now(),
    conversationId,
    messageIndex,
  };
  _evidenceMemory.push(entry);

  // LRU eviction: keep newest entries
  if (_evidenceMemory.length > EVIDENCE_MAX_ENTRIES) {
    _evidenceMemory = _evidenceMemory.slice(-EVIDENCE_MAX_ENTRIES);
  }

  await _persistEvidenceMemory();
  return entry;
}

/** Search evidence by keyword, returning up to `limit` results. */
export function getEvidenceMemory(query: string, limit: number = CONTEXT_MAX_EVIDENCE): EvidenceMemoryEntry[] {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const maxResults = Math.max(1, Math.min(limit, 20));
  return _evidenceMemory
    .map((entry) => ({ entry, score: scoreEvidence(entry, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime())
    .slice(0, maxResults)
    .map((item) => item.entry);
}

/** Get all evidence memory entries. */
export function getAllEvidenceMemory(): EvidenceMemoryEntry[] {
  return [..._evidenceMemory];
}

/** Get the count of evidence entries. */
export function getEvidenceMemoryCount(): number {
  return _evidenceMemory.length;
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/**
 * Format relevant memories from all three layers into a single string
 * suitable for injection into the system prompt or user message context.
 */
export function formatMemoryForContext(query: string): FormattedMemory {
  const sessionEntries = getAllSessionMemory().slice(0, CONTEXT_MAX_SESSION);
  const projectFacts = getProjectMemory(query).slice(0, CONTEXT_MAX_PROJECT);
  const evidenceEntries = getEvidenceMemory(query, CONTEXT_MAX_EVIDENCE);

  const lines: string[] = [];
  lines.push('<three_layer_memory>');
  lines.push('以下为 DeepChat 三层记忆系统检索到的相关信息，只作参考；如果与当前用户消息冲突，以当前消息为准。');

  if (sessionEntries.length > 0) {
    lines.push('');
    lines.push('## Session Memory (当前会话)');
    for (const entry of sessionEntries) {
      const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      lines.push(`- [${entry.key}] ${truncate(value, 200)}`);
    }
  }

  if (projectFacts.length > 0) {
    lines.push('');
    lines.push('## Project Memory (项目知识)');
    for (const fact of projectFacts) {
      const cat = fact.category !== 'general' ? ` [${fact.category}]` : '';
      lines.push(`-${cat} ${truncate(fact.fact, 240)}`);
    }
  }

  if (evidenceEntries.length > 0) {
    lines.push('');
    lines.push('## Evidence Memory (工具证据)');
    for (const entry of evidenceEntries) {
      lines.push(`- [${entry.sourceTool}] ${truncate(entry.content, 200)}`);
    }
  }

  lines.push('</three_layer_memory>');

  let text = lines.join('\n');
  if (text.length > CONTEXT_MAX_CHARS) {
    text = `${text.slice(0, CONTEXT_MAX_CHARS - 24).trim()}\n</three_layer_memory>`;
  }

  return {
    text,
    sessionCount: sessionEntries.length,
    projectCount: projectFacts.length,
    evidenceCount: evidenceEntries.length,
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function _persistProjectMemory(): Promise<void> {
  if (!_writeJson) return;
  try {
    await _writeJson(PROJECT_MEMORY_FILE, _projectMemory);
  } catch {
    // Silent failure — non-critical persistence
  }
}

async function _persistEvidenceMemory(): Promise<void> {
  if (!_writeJson) return;
  try {
    await _writeJson(EVIDENCE_MEMORY_FILE, _evidenceMemory);
  } catch {
    // Silent failure — non-critical persistence
  }
}
