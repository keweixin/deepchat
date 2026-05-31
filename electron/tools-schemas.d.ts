export const TOOL_SCHEMAS: Record<string, unknown>;
export const MODE_TOOLS: Record<string, string[]>;
export const MAX_FILE_BYTES: number;
export const DEFAULT_FILE_BYTES: number;
export const MAX_SEARCH_SCAN_FILES: number;
export const MAX_READ_MANY_FILES_BYTES: number;
export function getToolDefinitions(
  activeSkill: string,
  options?: { settings?: Record<string, unknown>; intent?: unknown; text?: string }
): unknown[];
export function shouldExposeCodingEditTools(options?: {
  settings?: Record<string, unknown>;
  intent?: unknown;
  text?: string;
}): boolean;
export function hasCodingEditIntent(text: string): boolean;
