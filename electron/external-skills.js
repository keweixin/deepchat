
const fs = require('fs/promises');
const path = require('path');
const { dialog } = require('electron');

const MAX_SKILL_BYTES = 80 * 1024;

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
};
