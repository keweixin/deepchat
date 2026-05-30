import { getSettings } from './settings-core.js';
import { SKILLS, isSkillRunnable, resolveRunnableSkill, hasNativeBridge, saveSettings } from './api.js';
import { showToast } from './utils.js';

export function renderSkillGrid(
  container: HTMLElement | null,
  activeSkill: string,
  settings: Record<string, unknown> = getSettings()
): void {
  if (!container) return;
  container.textContent = '';

  const resolvedActiveSkill = resolveRunnableSkill(settings);
  for (const [id, skill] of Object.entries(SKILLS) as [string, { icon: string; name: string; description: string }][]) {
    const card = document.createElement('button');
    const available = isSkillAvailable(id, settings);
    card.type = 'button';
    card.disabled = !available;
    card.setAttribute('aria-disabled', String(!available));
    card.className = `skill-card${id === resolvedActiveSkill ? ' active' : ''}${available ? '' : ' unavailable'}`;
    card.innerHTML = ` /* safeSetHTML-exempt: static template */
      <span class="skill-icon">${skill.icon}</span>
      <span class="skill-name">${skill.name}</span>
      <span class="skill-desc">${skill.description}</span>
      <span class="skill-state">${available ? '可用' : getUnavailableReason(id)}</span>
    `;
    card.addEventListener('click', () => {
      if (!available) {
        showToast(getUnavailableReason(id));
        return;
      }
      saveSettings({ activeSkill: id });
      container.querySelectorAll('.skill-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    container.appendChild(card);
  }
}

export function isSkillAvailable(id: string, settings: Record<string, unknown>): boolean {
  return isSkillRunnable(id, settings);
}

export function getUnavailableReason(id: string): string {
  if (!hasNativeBridge() && id !== 'none' && id !== 'web_search') return '需桌面版';
  if (id === 'web_search') return '需 Tavily Key';
  if (id === 'file_reader') return '需工作区';
  if (id === 'mcp_tool') return '需 MCP';
  if (id === 'multi_tool') return '需配置工具';
  return '可用';
}

export function renderStorageStatus(container: HTMLElement | null, settings: Record<string, unknown>): void {
  if (!container) return;
  const status = (settings.storageStatus as { mode: string; encryptionAvailable?: boolean; dataDir?: string }) || {
    mode: 'browser',
  };
  if (status.mode === 'electron') {
    container.textContent = `桌面安全存储：${status.encryptionAvailable ? '加密可用' : '加密不可用'} · 备份不包含 API Key/Tavily Key/MCP env · ${status.dataDir || ''}`;
  } else {
    container.textContent =
      '浏览器预览模式：非敏感设置和对话保存在 localStorage；密钥仅当前页面会话保留，备份不包含 API Key/Tavily Key/MCP env。';
  }
}

export function formatWorkspaceIndexClearResult(result: Record<string, unknown> = {}): string {
  if (!result.diskEnabled) return '已清理内存索引；浏览器预览或当前存储目录未启用磁盘索引缓存。';
  const bytes = Number(result.deletedBytes || 0);
  return `已清理工作区索引缓存：${result.deletedFiles || 0} 个文件，${formatBytes(bytes)}。`;
}

export function formatBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
}
