export type ProviderCompatibilityItem = {
  severity?: string;
  label?: string;
};

export type ProviderCompatibilityReport = {
  status?: string;
  items?: ProviderCompatibilityItem[];
};

export function buildProviderSetupHint(report: ProviderCompatibilityReport | null | undefined): string {
  if (report?.status !== 'blocked') return '';
  const keyIssue = Array.isArray(report.items) ? report.items.find((item) => item?.severity === 'error') : null;
  return keyIssue?.label
    ? `配置提示：${keyIssue.label}。点击右上角 ⚙️ 打开设置。`
    : '配置提示：请检查设置中的 Provider 和 API Key。';
}

export function maybeShowProviderSetupHint(options: {
  getSettings: () => Record<string, unknown>;
  getProviderCompatibilityReport: (settings: Record<string, unknown>) => ProviderCompatibilityReport;
  showToast: (message: string, duration?: number) => void;
  durationMs?: number;
}): string {
  const settings = options.getSettings();
  const report = options.getProviderCompatibilityReport(settings);
  const message = buildProviderSetupHint(report);
  if (message) options.showToast(message, options.durationMs ?? 5000);
  return message;
}
