/**
 * Settings Workspace utilities — workspace list rendering and refresh
 */

export function renderWorkspaceList(
  container: HTMLElement | null,
  roots: string[],
  onRemove: (root: string) => void
): void {
  if (!container) return;
  container.innerHTML = '';
  if (!roots || roots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('workspace-empty-icon');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
    icon.appendChild(path);

    const title = document.createElement('div');
    title.textContent = '尚未添加工作区';
    const hint = document.createElement('div');
    hint.className = 'workspace-empty-hint';
    hint.textContent = '文件读取能力暂时受限';
    empty.append(icon, title, hint);
    container.appendChild(empty);
    return;
  }
  for (const root of roots) {
    const item = document.createElement('div');
    item.className = 'workspace-item';
    const text = document.createElement('span');
    text.textContent = root;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn-sm';
    removeBtn.title = '移除工作区';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', () => onRemove(root));
    item.append(text, removeBtn);
    container.appendChild(item);
  }
}

export async function refreshWorkspaces(
  els: Record<string, HTMLElement>,
  nextSettings: Record<string, unknown>,
  {
    removeWorkspace,
    renderSkillGrid,
  }: {
    removeWorkspace: (root: string) => Promise<Record<string, unknown>>;
    renderSkillGrid: (container: HTMLElement, activeSkill: string, settings: Record<string, unknown>) => void;
  }
): Promise<void> {
  renderWorkspaceList(els.workspaceList, (nextSettings.workspaceRoots as string[]) || [], async (root) => {
    const updated = await removeWorkspace(root);
    await refreshWorkspaces(els, updated, { removeWorkspace, renderSkillGrid });
    renderSkillGrid(els.skillGrid, String(updated.activeSkill || ''), updated);
  });
}
