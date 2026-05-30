// @ts-nocheck
const { TOOL_DEFINITIONS } = require('./shared/tool-definitions');

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_READ_MANY_FILES_BYTES = 500 * 1024;

// Build TOOL_SCHEMAS dynamically from TOOL_DEFINITIONS
const TOOL_SCHEMAS = {};
for (const [key, def] of Object.entries(TOOL_DEFINITIONS)) {
  TOOL_SCHEMAS[key] = def.schema;
}

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
    'git_status',
    'git_diff',
    'git_log',
  ],
  code_runner: ['run_code'],
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
    'git_status',
    'git_diff',
    'git_log',
  ],
};

function getToolDefinitions(activeSkill) {
  const ids = MODE_TOOLS[activeSkill] || [];
  return ids.map((id) => TOOL_SCHEMAS[id]).filter(Boolean);
}

module.exports = {
  TOOL_SCHEMAS,
  MODE_TOOLS,
  getToolDefinitions,
  MAX_FILE_BYTES,
  DEFAULT_FILE_BYTES,
  MAX_SEARCH_SCAN_FILES,
  MAX_READ_MANY_FILES_BYTES,
};
