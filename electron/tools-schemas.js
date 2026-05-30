// @ts-check
const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_READ_MANY_FILES_BYTES = 500 * 1024;

const TOOL_SCHEMAS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web through the configured Tavily Search API and return concise sourced results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 4,
            description:
              'Optional multiple planned search queries for research mode. Results are merged and de-duplicated by URL.',
          },
          max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of results.' },
        },
      },
    },
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List text-oriented files inside a user-approved workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to list.' },
          pattern: { type: 'string', description: 'Optional filename substring or simple wildcard pattern.' },
          recent_days: {
            type: 'integer',
            minimum: 1,
            maximum: 3650,
            description: 'Only include files modified within this many days.',
          },
          sort_by: { type: 'string', enum: ['name', 'modified'], description: 'Sort files by name or modified time.' },
        },
      },
    },
  },
  search_workspace: {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Search text files, file names, paths, or an exact code symbol inside a user-approved workspace. Returns IDE-like structured results with file, line range, score, kind, symbol, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for.' },
          symbol: {
            type: 'string',
            description: 'Optional exact function/class/variable/component symbol to search for.',
          },
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to search.' },
          pattern: { type: 'string', description: 'Optional filename substring or wildcard, such as *.js or README.' },
          max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of file hits.' },
        },
      },
    },
  },
  index_workspace: {
    type: 'function',
    function: {
      name: 'index_workspace',
      description:
        'Build or refresh a lightweight cached index of approved workspace text files for faster cited search.',
      parameters: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to index.' },
          pattern: { type: 'string', description: 'Optional filename substring or wildcard, such as *.js or README.' },
          force_refresh: { type: 'boolean', description: 'Rebuild the index even when a fresh cached index exists.' },
          max_files: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_SEARCH_SCAN_FILES,
            description: 'Maximum files to scan.',
          },
        },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file inside a user-approved workspace directory. Supports focused line ranges via start_line/end_line or path citations like src/file.js:10-20.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: MAX_FILE_BYTES, description: 'Maximum bytes to read.' },
          start_line: {
            type: 'integer',
            minimum: 1,
            description: 'Optional 1-based line number to start reading from.',
          },
          end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number to stop reading at.' },
        },
        required: ['path'],
      },
    },
  },
  read_symbol: {
    type: 'function',
    function: {
      name: 'read_symbol',
      description:
        'Read the definition block for a function, class, variable, or component symbol inside a user-approved workspace. Prefer this before reading broad file ranges when the user names a code symbol.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Exact symbol name to locate, such as renderMarkdown or buildContextBudgetBundle.',
          },
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to search.' },
          pattern: {
            type: 'string',
            description: 'Optional filename substring or wildcard, such as *.js or renderer.',
          },
          context_lines: {
            type: 'integer',
            minimum: 0,
            maximum: 20,
            description: 'Extra lines before and after the symbol definition.',
          },
          max_lines: {
            type: 'integer',
            minimum: 20,
            maximum: 240,
            description: 'Maximum lines returned for the symbol block.',
          },
        },
        required: ['symbol'],
      },
    },
  },
  run_code: {
    type: 'function',
    function: {
      name: 'run_code',
      description:
        'Run a small JavaScript or Python snippet after explicit user approval. Security limits: 5s timeout, process-tree kill on timeout, 1MB output cap, 512MB memory limit, output redaction for secrets.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'js', 'python', 'py'], description: 'Runtime language.' },
          code: { type: 'string', description: 'Complete code snippet to execute.' },
          stdin: { type: 'string', description: 'Optional stdin.' },
        },
        required: ['language', 'code'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        'Show the Git working tree status for an approved workspace directory. Returns a structured list of changed, added, deleted, untracked, and conflicted files. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
        },
      },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show Git diff output for an approved workspace directory, optionally filtered to a single file or the staging area. Returns structured file list with additions, deletions, and full diff text. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          file: { type: 'string', description: 'Optional workspace-relative file path to diff.' },
          staged: { type: 'boolean', description: 'If true, show staged changes instead of unstaged changes.' },
        },
      },
    },
  },
  git_log: {
    type: 'function',
    function: {
      name: 'git_log',
      description:
        'Show Git commit history for an approved workspace directory, optionally filtered to a single file. Returns structured commit list with hash, author, date, and message. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          count: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of recent commits to show.' },
          file: { type: 'string', description: 'Optional workspace-relative file path to filter commits.' },
        },
      },
    },
  },
  project_map: {
    type: 'function',
    function: {
      name: 'project_map',
      description:
        'Generate a tree-like project structure overview with file counts per directory. Excludes .git, node_modules, dist, build, .cache, and release directories. Read-only, low-risk operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          maxDepth: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'Maximum directory depth to traverse. Defaults to 4.',
          },
        },
      },
    },
  },
  read_many_files: {
    type: 'function',
    function: {
      name: 'read_many_files',
      description:
        'Read multiple text files at once from an approved workspace. Each file is returned with a path header. Total output capped at 500KB. Read-only, medium-risk (bulk read) operation.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 50,
            description: 'List of absolute or workspace-relative file paths to read.',
          },
          maxTotalBytes: {
            type: 'integer',
            minimum: 1024,
            maximum: MAX_READ_MANY_FILES_BYTES,
            description: 'Maximum total bytes to read across all files. Defaults to 500KB.',
          },
        },
        required: ['paths'],
      },
    },
  },
};

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
