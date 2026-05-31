import { describe, expect, it, vi } from 'vitest';
import { buildProviderSetupHint, maybeShowProviderSetupHint } from '../src/modules/app-startup.js';

describe('app startup helpers', () => {
  it('does not show a setup hint when provider status is ready', () => {
    expect(buildProviderSetupHint({ status: 'ready', items: [] })).toBe('');
  });

  it('prefers the first provider error label for blocked setup hints', () => {
    expect(
      buildProviderSetupHint({
        status: 'blocked',
        items: [
          { severity: 'warning', label: '模型不支持图片' },
          { severity: 'error', label: '需要 API Key' },
        ],
      })
    ).toBe('配置提示：需要 API Key。点击右上角 ⚙️ 打开设置。');
  });

  it('falls back to a generic setup hint when blocked without a specific error', () => {
    expect(buildProviderSetupHint({ status: 'blocked', items: [{ severity: 'warning', label: '仅警告' }] })).toBe(
      '配置提示：请检查设置中的 Provider 和 API Key。'
    );
  });

  it('emits the setup toast and returns the message', () => {
    const showToast = vi.fn();
    const message = maybeShowProviderSetupHint({
      getSettings: () => ({ providerId: 'deepseek' }),
      getProviderCompatibilityReport: () => ({ status: 'blocked', items: [{ severity: 'error', label: '未配置' }] }),
      showToast,
      durationMs: 1200,
    });

    expect(message).toBe('配置提示：未配置。点击右上角 ⚙️ 打开设置。');
    expect(showToast).toHaveBeenCalledWith(message, 1200);
  });
});
