export function normalizeRoots(roots: string[]): string[];
export function pathEquals(a: string, b: string): boolean;
export function isPathInsideRoot(candidate: string, root: string): boolean;
export function resolveWorkspaceRoot(inputRoot: string | undefined, workspaceRoots: string[]): Promise<string>;
export function resolveAllowedPath(inputPath: string, workspaceRoots: string[]): Promise<string>;
export function resolveAllowedDirectory(inputPath: string | undefined, workspaceRoots: string[]): Promise<string>;
export function isSensitivePath(filePath: string): boolean;
export function isProbablyBinary(buffer: Buffer): boolean;
