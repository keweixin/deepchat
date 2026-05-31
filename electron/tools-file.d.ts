export type FileToolSettings = {
  workspaceRoots?: string[];
  storageStatus?: { dataDir?: string };
  dataDir?: string;
  [key: string]: unknown;
};

export type FileEditPreview = Record<string, unknown> & {
  tool: 'edit_file' | 'multi_edit';
  path: string;
  requestedPath?: string;
  editCount: number;
  diffSummary: string;
  backupPlanned: boolean;
  restoreHint: string;
};

export type PathLineCitation = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export function listFiles(args: Record<string, unknown>, settings: FileToolSettings): Promise<string>;
export function readFile(args: Record<string, unknown>, settings: FileToolSettings): Promise<string>;
export function readManyFiles(args: Record<string, unknown>, settings: FileToolSettings): Promise<string>;
export function editFile(args: Record<string, unknown>, settings: FileToolSettings): Promise<string>;
export function multiEdit(args: Record<string, unknown>, settings: FileToolSettings): Promise<string>;
export function previewEditFile(args: Record<string, unknown>, settings: FileToolSettings): Promise<FileEditPreview>;
export function previewMultiEdit(args: Record<string, unknown>, settings: FileToolSettings): Promise<FileEditPreview>;
export function previewFileEditTool(
  args: Record<string, unknown> & { toolName?: string; name?: string },
  settings: FileToolSettings
): Promise<FileEditPreview | null>;
export function atomicWriteFile(resolvedPath: string, content: string): Promise<void>;
export function getBackupDir(resolvedPath: string, settings?: FileToolSettings): string;
export function resolveEditableFilePath(filePath: string, workspaceRoots: string[]): Promise<string>;
export function walk(
  root: string,
  current: string,
  files: string[],
  matcher: (filePath: string) => boolean,
  maxFiles?: number
): Promise<void>;
export function shouldSkip(filePath: string): boolean;
export function createMatcher(pattern?: string): (filePath: string) => boolean;
export function formatListedFile(root: string, filePath: string): string;
export function formatMtime(value: number | string | Date): string;
export function parsePathLineCitation(value: unknown): PathLineCitation;
export function normalizeLineRange(
  startLine: unknown,
  endLine: unknown,
  maxLine: number
): { startLine: number; endLine: number };
export function formatLineRangeFileOutput(filePath: string, content: string, options?: Record<string, unknown>): string;
