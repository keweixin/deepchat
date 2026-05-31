export type RunCodeSettings = {
  runCodeEnabled?: boolean | string;
  [key: string]: unknown;
};

export function runCode(
  args: Record<string, unknown>,
  settings?: RunCodeSettings,
  signal?: AbortSignal
): Promise<string>;
export function buildSandboxEnv(language: string, tempDir: string): NodeJS.ProcessEnv;
export function redactSensitiveText(value: unknown): string;
export function redactRunCodeOutput(value: unknown): string;
export function normalizeLanguage(value: unknown): 'javascript' | 'python' | '';
