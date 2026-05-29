// @ts-check
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_TOOL_OUTPUT = 12000;
const RUN_CODE_SECURITY_LIMITS = {
  maxOutputBytes: 1024 * 1024, // 1MB
  maxMemoryMB: 512,
  maxTimeoutMs: 5000,
  killTreeOnTimeout: true,
};

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function runCode(args, settings = {}, signal) {
  if (settings.runCodeEnabled === false || settings.runCodeEnabled === 'false') {
    throw new Error('代码运行工具已在设置中关闭。');
  }
  const language = normalizeLanguage(args.language);
  const code = String(args.code || '');
  if (!language) throw new Error('仅支持 JavaScript 和 Python。');
  if (!code.trim()) throw new Error('代码不能为空。');
  if (code.length > 20000) throw new Error('代码过长，已拒绝执行。');

  const tempDir = path.join(os.tmpdir(), 'deepchat-code', crypto.randomUUID());
  await fs.mkdir(tempDir, { recursive: true });
  const id = crypto.randomUUID();
  const ext = language === 'python' ? 'py' : 'js';
  const filePath = path.join(tempDir, `${id}.${ext}`);
  await fs.writeFile(filePath, code, 'utf8');

  const command =
    language === 'python'
      ? process.env.DEEPCHAT_PYTHON_PATH || 'python'
      : process.env.DEEPCHAT_NODE_PATH || process.execPath;
  const env = buildSandboxEnv(language, tempDir);
  const startedAt = Date.now();
  const rawOutput = await spawnWithLimits(command, [filePath], String(args.stdin || ''), env, tempDir, signal);
  const output = {
    ...rawOutput,
    stdout: redactRunCodeOutput(rawOutput.stdout),
    stderr: redactRunCodeOutput(rawOutput.stderr),
  };
  const durationMs = Date.now() - startedAt;
  const structured = buildRunCodeStructuredResult({
    language,
    codeLength: code.length,
    stdinBytes: Buffer.byteLength(String(args.stdin || ''), 'utf8'),
    durationMs,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error('[runCode] Failed to clean up temp dir:', tempDir, err.message);
  }
  return [
    `语言：${language}`,
    `退出码：${output.exitCode ?? 'unknown'}${output.timedOut ? '（超时终止）' : ''}`,
    `耗时：${durationMs}ms`,
    `代码长度：${code.length} chars`,
    `stdin：${structured.stdinBytes} bytes`,
    '沙箱目录：已创建临时隔离目录，任务结束后清理',
    '权限：本地轻沙箱（临时目录隔离）',
    '环境：最小变量白名单（已过滤 token/key/secret/password）',
    '网络：未硬阻断',
    '风险：仅运行可信代码',
    'Structured Run:',
    JSON.stringify(structured, null, 2),
    '',
    'STDOUT:',
    output.stdout || '(empty)',
    '',
    'STDERR:',
    output.stderr || '(empty)',
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

function buildRunCodeStructuredResult(result) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    type: 'deepchat.runCodeResult',
    version: 1,
    language: result.language,
    codeLength: result.codeLength || 0,
    stdinBytes: result.stdinBytes || 0,
    durationMs: result.durationMs || 0,
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    ok: result.exitCode === 0 && !result.timedOut,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stdoutPreview: compactHeadTailText(stdout, 1600, 800),
    stderrPreview: compactHeadTailText(stderr, 1200, 600),
    failureHint: buildRunFailureHint(result.exitCode, result.timedOut, stderr),
  };
}

function compactHeadTailText(text, headLength, tailLength) {
  const value = String(text || '');
  if (value.length <= headLength + tailLength + 80) return value;
  return `${value.slice(0, headLength)}\n\n[中间输出已省略]\n\n${value.slice(-tailLength)}`;
}

function buildRunFailureHint(exitCode, timedOut, stderr) {
  if (timedOut) return '代码运行超时，可减少输入、拆分任务或检查是否存在死循环。';
  if (exitCode === 0) return '';
  const text = String(stderr || '');
  if (/SyntaxError/i.test(text)) return '语法错误：请检查括号、引号、缩进或语言模式。';
  if (/ModuleNotFoundError|Cannot find module/i.test(text)) return '依赖缺失：当前轻沙箱不会自动安装依赖。';
  if (/NameError|ReferenceError/i.test(text)) return '变量或函数未定义：请检查上下文是否完整。';
  if (/PermissionError|EACCES/i.test(text)) return '权限错误：轻沙箱目录隔离，无法访问未授权路径。';
  return exitCode === null
    ? '运行进程启动失败，请检查本机运行时配置。'
    : '代码运行失败，请查看 stderr 首尾输出定位原因。';
}

function buildSandboxEnv(language, tempDir) {
  const env = {};
  const pathValue = process.env.PATH || process.env.Path || '';
  if (pathValue) {
    env.PATH = pathValue;
    env.Path = pathValue;
  }
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = tempDir;
  env.USERPROFILE = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  env.TMPDIR = tempDir;
  env.NO_COLOR = '1';
  env.PYTHONIOENCODING = 'utf-8';
  if (language === 'javascript' && !process.env.DEEPCHAT_NODE_PATH) env.ELECTRON_RUN_AS_NODE = '1';
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isSensitiveEnvKey(key)));
}

function isSensitiveEnvKey(key) {
  return /(key|token|secret|password|credential|cookie|session|auth|bearer)/i.test(String(key || ''));
}

function normalizeLanguage(value) {
  const lang = String(value || '')
    .trim()
    .toLowerCase();
  if (lang === 'python' || lang === 'py') return 'python';
  if (lang === 'javascript' || lang === 'js') return 'javascript';
  return '';
}

function spawnWithLimits(command, args, stdin, env = process.env, cwd, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const isWin = process.platform === 'win32';
  // On Unix, detached creates a new process group so we can kill the entire tree.
  const child = spawn(command, args, { windowsHide: true, env, cwd, detached: !isWin });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    const maxBytes = RUN_CODE_SECURITY_LIMITS.maxOutputBytes;

    /** Kill the entire process tree, not just the main process. */
    function killTree() {
      if (killed) return;
      killed = true;
      if (isWin) {
        // Windows: taskkill /F /T kills the process tree by PID.
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } catch {
          // Fallback: direct kill if taskkill fails (e.g. process already exited).
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      } else {
        // Unix: negative PID sends signal to the entire process group.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }
    }

    const onAbort = () => {
      timedOut = true;
      killTree();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, RUN_CODE_SECURITY_LIMITS.maxTimeoutMs);

    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') < maxBytes) {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout, 'utf8') > maxBytes) {
          stdout = stdout.slice(0, maxBytes);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') < maxBytes) {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr, 'utf8') > maxBytes) {
          stderr = stderr.slice(0, maxBytes);
        }
      }
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      cleanup();
      resolve({ stdout, stderr: error.message, exitCode: null, timedOut });
    });
    child.on('close', (exitCode) => {
      cleanup();
      const truncationNotice = '[Output truncated: exceeded 1MB limit]';
      if (Buffer.byteLength(stdout, 'utf8') >= maxBytes) stdout += `\n${truncationNotice}`;
      if (Buffer.byteLength(stderr, 'utf8') >= maxBytes) stderr += `\n${truncationNotice}`;
      resolve({ stdout, stderr, exitCode, timedOut });
    });

    try {
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      // Child may have exited before reading stdin; error is surfaced via exitCode.
    }
  });
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, 'ghp_[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, 'xoxb-[REDACTED]')
    .replace(/\btvly-[A-Za-z0-9_-]{8,}\b/g, 'tvly-[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]{8,}/gi, '$1=[REDACTED]');
}

/**
 * Redact secrets from run_code stdout/stderr output.
 * Extends redactSensitiveText with additional patterns common in code execution output
 * (private keys, JWTs, connection strings, generic long hex/base64 blobs that look like secrets).
 */
function redactRunCodeOutput(value) {
  return (
    redactSensitiveText(value)
      // PEM private key blocks
      .replace(
        /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
        '[REDACTED PRIVATE KEY]'
      )
      // JWT tokens (three base64url segments separated by dots)
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]')
      // Connection strings with embedded credentials
      .replace(/\b(?:mongodb|postgres|mysql|redis|amqp):\/\/[^'"\s]{8,}/gi, '[REDACTED CONNECTION STRING]')
      // Generic assignment patterns that look like secrets (long hex or base64 values)
      .replace(
        /\b(?:api[_-]?key|token|secret|password|authorization|auth|credential|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{16,}['"]?/gi,
        '$1=[REDACTED]'
      )
  );
}

module.exports = {
  runCode,
  buildSandboxEnv,
  redactSensitiveText,
  redactRunCodeOutput,
  normalizeLanguage,
};
