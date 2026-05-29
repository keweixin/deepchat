import { DEFAULT_SETTINGS } from './settings-core.js';

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export function normalizeBaseUrl(apiBase: string | undefined): string {
  let baseUrl = String(apiBase || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
  // Only append /v1 if the URL doesn't already contain it
  if (!/\/v1(\/|$)/i.test(baseUrl)) baseUrl += '/v1';
  return baseUrl;
}

export function normalizeProviderBase(apiBase: string | undefined): string {
  return String(apiBase || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function buildHeaders(apiKey: string | undefined, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function isLocalApi(apiBase: string | undefined): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(String(apiBase || ''));
}

export function parseApiError(status: number, text: string): string {
  let msg = `API 错误 (${status})`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    msg = parsed.error?.message || msg;
  } catch {}
  return msg;
}

export function isUnsupportedParameterError(text: string, parameter: string): boolean {
  const body = String(text || '').toLowerCase();
  return (
    body.includes(parameter.toLowerCase()) &&
    /unsupported|unknown|unrecognized|invalid|not support|不支持|未知|无效/.test(body)
  );
}
