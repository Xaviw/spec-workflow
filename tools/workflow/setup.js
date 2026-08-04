import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  LOCAL_CONFIG_FILE,
  ROOT,
  discoverSkills,
  extractManagedJson,
  isSymbolicLink,
  optionValues,
  parseSetupConfig,
  readLocalConfig,
  readText,
  removeTextBlock,
  replaceManagedBlock,
  replaceTextBlock,
  repositoryIdentity,
  writeText,
} from "./common.js";

export const ENTRY_START = "<!-- spec-driven:agent-entry:start -->";
export const ENTRY_END = "<!-- spec-driven:agent-entry:end -->";
export const ENTRY_CONTENT = "请读取并遵循根目录 `AGENTS.md`。";

const AGENT_ADAPTERS = {
  "claude-code": { entry: "CLAUDE.md", skills: ".claude/skills" },
};

function displayPath(path) {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function linkPointsTo(path, expected) {
  return isSymbolicLink(path) &&
    resolve(dirname(path), readlinkSync(path)) === resolve(expected);
}

export function managedSkillLinks(targetRoot, sourceRoot) {
  if (!existsSync(targetRoot) || !lstatSync(targetRoot).isDirectory()) return [];
  return readdirSync(targetRoot)
    .filter((name) => {
      const target = join(targetRoot, name);
      if (!isSymbolicLink(target)) return false;
      const source = resolve(dirname(target), readlinkSync(target));
      return dirname(source) === resolve(sourceRoot);
    })
    .sort();
}

function parseRepositoryOptions(values) {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) {
      throw new Error("--repo 格式必须为 <id>=<path>");
    }
    return {
      id: value.slice(0, separator),
      path: repositoryIdentity(value.slice(separator + 1)),
    };
  });
}

function desiredConfig(options, existing) {
  let agent = existing?.agent ? { ...existing.agent } : null;
  if (options.agent !== undefined) agent = { id: String(options.agent) };
  if (!agent) throw new Error("首次 setup 需要 --agent <id>");
  const repositoryOptions = optionValues(options.repo);
  const repositories = repositoryOptions.length
    ? parseRepositoryOptions(repositoryOptions)
    : existing?.repositories;
  if (!repositories) throw new Error("首次 setup 至少需要一个 --repo <id>=<path>");
  return parseSetupConfig({
    schema_version: 1,
    agent,
    repositories,
    task_bindings: existing?.task_bindings || [],
  });
}

function validateTextBlock(path, body, start, end) {
  if (!pathExists(path)) return;
  const text = readText(path);
  if (body === null) removeTextBlock(text, start, end);
  else replaceTextBlock(text, body, start, end);
}

function integrationPaths(config) {
  const adapter = AGENT_ADAPTERS[config?.agent?.id];
  return {
    entry_path: adapter?.entry || null,
    skills_path: adapter?.skills || null,
    entry: adapter?.entry ? join(ROOT, adapter.entry) : null,
    skills: adapter?.skills ? join(ROOT, adapter.skills) : null,
  };
}

function preflight(previous, desired, replace) {
  const oldPaths = integrationPaths(previous);
  const newPaths = integrationPaths(desired);
  if (oldPaths.entry) validateTextBlock(oldPaths.entry, null, ENTRY_START, ENTRY_END);
  if (newPaths.entry) validateTextBlock(newPaths.entry, ENTRY_CONTENT, ENTRY_START, ENTRY_END);
  if (newPaths.skills && pathExists(newPaths.skills) && !lstatSync(newPaths.skills).isDirectory()) {
    throw new Error("Skills 目标不是目录: " + displayPath(newPaths.skills));
  }
  const sourceRoot = join(ROOT, ".agents", "skills");
  const conflicts = newPaths.skills
    ? discoverSkills().filter((name) => {
        const target = join(newPaths.skills, name);
        return pathExists(target) && !linkPointsTo(target, join(sourceRoot, name));
      })
    : [];
  if (conflicts.length && !replace) {
    throw new Error(
      "Agent Skills 目标存在用户内容，明确授权后使用 --replace: " +
        conflicts.map((name) => displayPath(join(newPaths.skills, name))).join(", "),
    );
  }
  const localBase = readText(
    LOCAL_CONFIG_FILE,
    "# 本地工作流设置\n\n受管块外可记录本机差异，不得写入凭据值。\n",
  );
  const localContent = replaceManagedBlock(localBase, desired);
  return { oldPaths, newPaths, conflicts, localContent };
}

function mutation() {
  const undo = [];
  const backups = [];
  return {
    write(path, content) {
      const existed = pathExists(path);
      const before = existed ? readText(path) : null;
      if (before === content) return "unchanged";
      writeText(path, content);
      undo.push(() => existed ? writeText(path, before) : rmSync(path, { force: true, recursive: true }));
      return existed ? "updated" : "created";
    },
    remove(path) {
      if (!pathExists(path)) return "unchanged";
      const backup = join(dirname(path), `.spec-workflow-setup-${randomUUID()}.bak`);
      renameSync(path, backup);
      backups.push(backup);
      undo.push(() => {
        rmSync(path, { force: true, recursive: true });
        renameSync(backup, path);
      });
      return "removed";
    },
    mkdir(path) {
      if (pathExists(path)) return;
      mkdirSync(path, { recursive: true });
      undo.push(() => rmSync(path, { force: true, recursive: true }));
    },
    link(source, target) {
      const linkTarget = process.platform === "win32"
        ? source
        : relative(dirname(target), source) || ".";
      symlinkSync(linkTarget, target, process.platform === "win32" ? "junction" : "dir");
      undo.push(() => rmSync(target, { force: true, recursive: true }));
    },
    commit() {
      for (const backup of backups) rmSync(backup, { force: true, recursive: true });
    },
    rollback() {
      let failure = null;
      for (const restore of undo.reverse()) {
        try {
          restore();
        } catch (error) {
          failure ||= error;
        }
      }
      if (failure) throw new Error("setup 回滚不完整: " + failure.message);
    },
  };
}

function removePreviousIntegration(plan, actions, changes) {
  if (plan.oldPaths.entry && plan.oldPaths.entry !== plan.newPaths.entry) {
    const remaining = removeTextBlock(readText(plan.oldPaths.entry), ENTRY_START, ENTRY_END);
    const action = remaining.trim()
      ? changes.write(plan.oldPaths.entry, remaining)
      : changes.remove(plan.oldPaths.entry);
    actions.push({ action, path: displayPath(plan.oldPaths.entry) });
  }
  if (plan.oldPaths.skills && plan.oldPaths.skills !== plan.newPaths.skills) {
    const sourceRoot = join(ROOT, ".agents", "skills");
    for (const name of managedSkillLinks(plan.oldPaths.skills, sourceRoot)) {
      const target = join(plan.oldPaths.skills, name);
      actions.push({ action: changes.remove(target), path: displayPath(target) });
    }
  }
}

function applyCurrentIntegration(config, plan, actions, changes) {
  if (plan.newPaths.entry) {
    const before = readText(plan.newPaths.entry);
    const after = replaceTextBlock(before, ENTRY_CONTENT, ENTRY_START, ENTRY_END);
    actions.push({ action: changes.write(plan.newPaths.entry, after), path: displayPath(plan.newPaths.entry) });
  }
  if (!plan.newPaths.skills) return;
  changes.mkdir(plan.newPaths.skills);
  const sourceRoot = join(ROOT, ".agents", "skills");
  const skills = discoverSkills();
  for (const stale of managedSkillLinks(plan.newPaths.skills, sourceRoot).filter((name) => !skills.includes(name))) {
    const target = join(plan.newPaths.skills, stale);
    actions.push({ action: changes.remove(target), path: displayPath(target) });
  }
  for (const name of skills) {
    const source = join(sourceRoot, name);
    const target = join(plan.newPaths.skills, name);
    if (linkPointsTo(target, source)) {
      actions.push({ action: "unchanged", path: displayPath(target) });
      continue;
    }
    const existed = pathExists(target);
    if (existed) changes.remove(target);
    changes.link(source, target);
    actions.push({ action: existed ? "updated" : "created", path: displayPath(target) });
  }
}

export function runSetup(options) {
  let existing = null;
  try {
    existing = readLocalConfig();
  } catch (error) {
    if (options.agent === undefined || !optionValues(options.repo).length) throw error;
  }
  const config = desiredConfig(options, existing);
  const plan = preflight(existing, config, Boolean(options.replace));
  const actions = [];
  const changes = mutation();
  try {
    removePreviousIntegration(plan, actions, changes);
    applyCurrentIntegration(config, plan, actions, changes);
    actions.push({ action: changes.write(LOCAL_CONFIG_FILE, plan.localContent), path: displayPath(LOCAL_CONFIG_FILE) });
  } catch (error) {
    try {
      changes.rollback();
    } catch (rollbackError) {
      throw new Error(error.message + "；" + rollbackError.message);
    }
    throw error;
  }
  changes.commit();
  return { config, actions };
}

export function inspectIntegration(config, skills) {
  const paths = integrationPaths(config);
  const sourceRoot = join(ROOT, ".agents", "skills");
  const knownSkills = skills === null
    ? null
    : skills || (paths.skills ? discoverSkills() : []);
  const entryText = paths.entry && pathExists(paths.entry) ? readText(paths.entry) : "";
  const entryStart = entryText.indexOf(ENTRY_START);
  const entryEnd = entryText.indexOf(ENTRY_END);
  return {
    entry: paths.entry,
    skills: paths.skills,
    entry_path: paths.entry_path,
    skills_path: paths.skills_path,
    entry_ok: !paths.entry || (
      entryStart >= 0 &&
      entryEnd > entryStart &&
      entryText.slice(entryStart + ENTRY_START.length, entryEnd).trim() === ENTRY_CONTENT
    ),
    skill_links: paths.skills && knownSkills
      ? knownSkills.map((name) => ({
          name,
          ok: linkPointsTo(join(paths.skills, name), join(sourceRoot, name)),
        }))
      : [],
    stale_skill_links: paths.skills && knownSkills
      ? managedSkillLinks(paths.skills, sourceRoot).filter((name) => !knownSkills.includes(name))
      : [],
  };
}

export function readRawLocalConfig() {
  if (!existsSync(LOCAL_CONFIG_FILE)) return null;
  return extractManagedJson(readText(LOCAL_CONFIG_FILE));
}
