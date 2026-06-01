const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { dialog } = require('electron');

const MAX_SKILL_BYTES = 80 * 1024;
const MAX_SCAN_CANDIDATES = 80;

async function pickExternalSkill(parentWindow, settings, setSettings) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择外部 Skill 文件或目录',
    filters: [{ name: 'Skill Markdown', extensions: ['md'] }],
    properties: ['openFile', 'openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return settings;

  const skills = [];
  for (const selectedPath of result.filePaths) {
    skills.push(...(await loadSkillsFromPath(selectedPath)));
  }
  if (skills.length === 0) throw new Error('没有找到可导入的 SKILL.md。');

  const existing = Array.isArray(settings.externalSkills) ? settings.externalSkills : [];
  const merged = mergeSkills(existing, skills);
  return setSettings({ externalSkills: merged });
}

async function loadSkillsFromPath(selectedPath) {
  const stat = await fs.stat(selectedPath);
  if (stat.isFile()) return [await readSkillFile(selectedPath)];

  const direct = path.join(selectedPath, 'SKILL.md');
  const skills = [];
  if (await exists(direct)) skills.push(await readSkillFile(direct));

  const entries = await fs.readdir(selectedPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(selectedPath, entry.name, 'SKILL.md');
    if (await exists(candidate)) skills.push(await readSkillFile(candidate));
  }
  return skills;
}

async function scanExternalSkills(settings = {}, options = {}) {
  const roots = buildExternalSkillRoots(settings, options);
  const existing = Array.isArray(settings.externalSkills) ? settings.externalSkills : [];
  const existingKeys = new Set(existing.map((skill) => normalizePathKey(skill.sourcePath || skill.id)));
  const candidates = [];
  const warnings = [];
  const seen = new Set();

  for (const root of roots) {
    const rootKey = normalizePathKey(root.path);
    if (!root.path || seen.has(rootKey)) continue;
    seen.add(rootKey);
    try {
      const skills = await loadSkillsFromPath(root.path);
      for (const skill of skills) {
        const skillKey = normalizePathKey(skill.sourcePath || skill.id);
        if (!skillKey || candidates.some((item) => normalizePathKey(item.sourcePath) === skillKey)) continue;
        const imported = existingKeys.has(skillKey);
        candidates.push({
          id: `external_skill_candidate_${candidates.length + 1}`,
          name: skill.name,
          description: skill.description || '',
          sourcePath: skill.sourcePath,
          sourceLabel: root.label,
          imported,
          duplicate: imported,
          status: imported ? 'imported' : 'new',
          importSkill: skill,
        });
        if (candidates.length >= MAX_SCAN_CANDIDATES) break;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warnings.push(`${root.label} 扫描失败：${error?.message || error}`);
    }
    if (candidates.length >= MAX_SCAN_CANDIDATES) break;
  }

  return {
    scannedAt: new Date().toISOString(),
    candidates,
    warnings,
    summary: {
      total: candidates.length,
      new: candidates.filter((item) => item.status === 'new').length,
      imported: candidates.filter((item) => item.status === 'imported').length,
      warnings: warnings.length,
    },
  };
}

function buildExternalSkillRoots(settings = {}, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const roots = [
    { label: 'Codex Skills', path: path.join(homeDir, '.codex', 'skills') },
    { label: 'Agents Skills', path: path.join(homeDir, '.agents', 'skills') },
    { label: 'Claude Skills', path: path.join(homeDir, '.claude', 'skills') },
  ];
  if (process.env.CODEX_HOME)
    roots.push({ label: 'Codex Home Skills', path: path.join(process.env.CODEX_HOME, 'skills') });
  if (process.env.CLAUDE_CONFIG_DIR) {
    roots.push({ label: 'Claude Config Skills', path: path.join(process.env.CLAUDE_CONFIG_DIR, 'skills') });
  }
  const workspaceRoots = Array.isArray(options.workspaceRoots)
    ? options.workspaceRoots
    : Array.isArray(settings.workspaceRoots)
      ? settings.workspaceRoots
      : [];
  for (const root of workspaceRoots) {
    const workspaceRoot = String(root || '').trim();
    if (workspaceRoot)
      roots.push({ label: 'Workspace Claude Skills', path: path.join(workspaceRoot, '.claude', 'skills') });
  }
  return roots;
}

async function readSkillFile(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`Skill 文件过大：${filePath}`);
  const content = await fs.readFile(filePath, 'utf8');
  const meta = parseSkillMeta(content);
  return {
    id: createSkillId(filePath),
    name: meta.name || path.basename(path.dirname(filePath)) || '外部 Skill',
    description: meta.description || '',
    sourcePath: filePath,
    content,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
}

function parseSkillMeta(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const key = parts.shift().trim();
    const value = parts
      .join(':')
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key === 'name' || key === 'description') meta[key] = value;
  }
  return meta;
}

function mergeSkills(existing, incoming) {
  const map = new Map();
  for (const skill of existing) map.set(skill.sourcePath || skill.id, skill);
  for (const skill of incoming) map.set(skill.sourcePath || skill.id, skill);
  return [...map.values()];
}

function normalizePathKey(value) {
  if (!value) return '';
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createSkillId(filePath) {
  return `skill_${Buffer.from(path.resolve(filePath).toLowerCase()).toString('base64url').slice(0, 24)}`;
}

/**
 * Load built-in skill templates from the `skills/` directory at the project
 * root.  These ship with the app and are always available regardless of
 * user-imported external skills.
 *
 * Each `.md` file in the directory is parsed using the same YAML front-matter
 * format as external skills.
 */
async function loadBuiltinSkills() {
  const skillsDir = path.join(__dirname, '..', 'skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(skillsDir, entry.name);
    try {
      const skill = await readSkillFile(filePath);
      skill.builtin = true;
      skills.push(skill);
    } catch {
      // Skip files that fail to parse (too large, invalid, etc.)
    }
  }
  return skills;
}

module.exports = {
  pickExternalSkill,
  loadSkillsFromPath,
  loadBuiltinSkills,
  parseSkillMeta,
  scanExternalSkills,
  mergeSkills,
};
