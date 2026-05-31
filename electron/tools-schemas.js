const { TOOL_DEFINITIONS } = require('./shared/tool-definitions');

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_READ_MANY_FILES_BYTES = 500 * 1024;
const EDIT_TOOL_IDS = new Set(['edit_file', 'multi_edit']);

// Build TOOL_SCHEMAS dynamically from TOOL_DEFINITIONS
/** @type {Record<string, any>} */
const TOOL_SCHEMAS = {};
for (const [key, def] of Object.entries(TOOL_DEFINITIONS)) {
  TOOL_SCHEMAS[key] = def && def.schema;
}

/** @type {Record<string, string[]>} */
const MODE_TOOLS = {
  none: [],
  web_search: ['web_search'],
  file_reader: [
    'index_workspace',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'project_map',
    'read_many_files',
    'edit_file',
    'multi_edit',
    'git_status',
    'git_diff',
    'git_log',
  ],
  code_runner: ['run_code', 'edit_file', 'multi_edit'],
  multi_tool: [
    'web_search',
    'index_workspace',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'project_map',
    'read_many_files',
    'run_code',
    'edit_file',
    'multi_edit',
    'git_status',
    'git_diff',
    'git_log',
  ],
};

/**
 * @param {string} activeSkill
 * @param {{ settings?: any, intent?: any, text?: string }} [options]
 * @returns {any[]}
 */
function getToolDefinitions(activeSkill, options = {}) {
  /** @type {string[]} */
  const ids = MODE_TOOLS[activeSkill] || [];
  const exposeEdits = shouldExposeCodingEditTools(options);
  return ids
    .filter((/** @type {string} */ id) => exposeEdits || !EDIT_TOOL_IDS.has(id))
    .map((/** @type {string} */ id) => TOOL_SCHEMAS[id])
    .filter(Boolean);
}

/**
 * Editing tools are only useful and safe when the user has configured a
 * workspace, explicitly allows coding edits, and the current turn really asks
 * for source changes.
 *
 * @param {{ settings?: any, intent?: any, text?: string }} [options]
 * @returns {boolean}
 */
function shouldExposeCodingEditTools(options = {}) {
  const settings = options.settings || {};
  if (settings.codingEditsEnabled === false || settings.codingEditsEnabled === 'false') return false;
  if (!Array.isArray(settings.workspaceRoots) || settings.workspaceRoots.length === 0) return false;

  const intent = options.intent || {};
  const names = [
    ...(Array.isArray(intent.selectedTools) ? intent.selectedTools : []),
    ...(Array.isArray(intent.candidateTools) ? intent.candidateTools : []),
  ];
  if (names.some((name) => EDIT_TOOL_IDS.has(String(name)))) return true;
  return hasCodingEditIntent(options.text || '');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasCodingEditIntent(text) {
  return /修改|编辑|修复|改一下|改成|替换|删除|新增|实现|补上|重构|落地|写入|保存|apply|edit|fix|change|replace|delete|insert|implement|refactor|update/i.test(
    String(text || '')
  );
}

module.exports = {
  TOOL_SCHEMAS,
  MODE_TOOLS,
  getToolDefinitions,
  shouldExposeCodingEditTools,
  hasCodingEditIntent,
  MAX_FILE_BYTES,
  DEFAULT_FILE_BYTES,
  MAX_SEARCH_SCAN_FILES,
  MAX_READ_MANY_FILES_BYTES,
};
