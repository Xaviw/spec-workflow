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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  runGit,
  withFileLocks,
  workflowPath,
  writeText,
} from "./common.js";

export const ENTRY_START = "<!-- spec-driven:agent-entry:start -->";
export const ENTRY_END = "<!-- spec-driven:agent-entry:end -->";
export const ENTRY_CONTENT = "请读取并遵循根目录 `AGENTS.md`。";
export const EXCLUDE_START = "# spec-driven:agent-adapter:start";
export const EXCLUDE_END = "# spec-driven:agent-adapter:end";

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
  if (options["entry-path"] !== undefined) {
    agent.entry_path = String(options["entry-path"]);
  }
  if (options["skills-path"] !== undefined) {
    agent.skills_path = String(options["skills-path"]);
  }
  const repositoryOptions = optionValues(options.repo);
  const repositories = repositoryOptions.length
    ? parseRepositoryOptions(repositoryOptions)
    : existing?.repositories;
  if (!repositories) throw new Error("首次 setup 至少需要一个 --repo <id>=<path>");
  return parseSetupConfig({ schema_version: 1, agent, repositories });
}

function validateTextBlock(path, body, start, end) {
  if (!pathExists(path)) return;
  const text = readText(path);
  if (body === null) removeTextBlock(text, start, end);
  else replaceTextBlock(text, body, start, end);
}

function integrationPaths(config) {
  return {
    entry: config?.agent?.entry_path
      ? workflowPath(config.agent.entry_path)
      : null,
    skills: config?.agent?.skills_path
      ? workflowPath(config.agent.skills_path)
      : null,
  };
}

function excludeUpdate(config) {
  const gitPath = runGit(["rev-parse", "--git-path", "info/exclude"], ROOT);
  const path = isAbsolute(gitPath) ? gitPath : resolve(ROOT, gitPath);
  const patterns = expectedExcludePatterns(config);
  const before = readText(path);
  return {
    path,
    content: patterns.length
      ? replaceTextBlock(before, patterns.join("\n"), EXCLUDE_START, EXCLUDE_END)
      : removeTextBlock(before, EXCLUDE_START, EXCLUDE_END),
  };
}

function preflight(previous, desired, replace) {
  const oldPaths = integrationPaths(previous);
  const newPaths = integrationPaths(desired);
  if (oldPaths.entry) validateTextBlock(oldPaths.entry, null, ENTRY_START, ENTRY_END);
  if (newPaths.entry) validateTextBlock(newPaths.entry, ENTRY_CONTENT, ENTRY_START, ENTRY_END);
  if (newPaths.skills && pathExists(newPaths.skills) && !lstatSync(newPaths.skills).isDirectory()) {
    throw new Error("Skills 目标不是目录: " + relative(ROOT, newPaths.skills));
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
        conflicts.map((name) => relative(ROOT, join(newPaths.skills, name))).join(", "),
    );
  }
  const localBase = readText(
    LOCAL_CONFIG_FILE,
    "# 本地工作流设置\n\n受管块外可记录本机差异，不得写入凭据值。\n",
  );
  const localContent = replaceManagedBlock(localBase, desired);
  const exclude = excludeUpdate(desired);
  return { oldPaths, newPaths, conflicts, localContent, exclude };
}

function mutation() {
  const undo = [];
  const backups = [];
  return {
    write(path, content) {
      const existed = pathExists(path);
      const before = existed ? readText(path) : null;
      writeText(path, content);
      undo.push(() => existed ? writeText(path, before) : rmSync(path, { force: true, recursive: true }));
    },
    remove(path) {
      if (!pathExists(path)) return;
      const backup = join(dirname(path), `.spec-workflow-setup-${randomUUID()}.bak`);
      renameSync(path, backup);
      backups.push(backup);
      undo.push(() => {
        rmSync(path, { force: true, recursive: true });
        renameSync(backup, path);
      });
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
    if (remaining.trim()) changes.write(plan.oldPaths.entry, remaining);
    else changes.remove(plan.oldPaths.entry);
    actions.push({ action: "remove-entry", path: relative(ROOT, plan.oldPaths.entry) });
  }
  if (plan.oldPaths.skills && plan.oldPaths.skills !== plan.newPaths.skills) {
    const sourceRoot = join(ROOT, ".agents", "skills");
    for (const name of managedSkillLinks(plan.oldPaths.skills, sourceRoot)) {
      changes.remove(join(plan.oldPaths.skills, name));
      actions.push({ action: "remove-skill-link", path: relative(ROOT, join(plan.oldPaths.skills, name)) });
    }
  }
}

function applyCurrentIntegration(config, plan, actions, changes) {
  if (plan.newPaths.entry) {
    const before = readText(plan.newPaths.entry);
    const after = replaceTextBlock(before, ENTRY_CONTENT, ENTRY_START, ENTRY_END);
    if (after !== before) changes.write(plan.newPaths.entry, after);
    actions.push({ action: after === before ? "ok" : "write-entry", path: relative(ROOT, plan.newPaths.entry) });
  }
  if (!plan.newPaths.skills) return;
  changes.mkdir(plan.newPaths.skills);
  const sourceRoot = join(ROOT, ".agents", "skills");
  const skills = discoverSkills();
  for (const stale of managedSkillLinks(plan.newPaths.skills, sourceRoot).filter((name) => !skills.includes(name))) {
    changes.remove(join(plan.newPaths.skills, stale));
    actions.push({ action: "remove-skill-link", path: relative(ROOT, join(plan.newPaths.skills, stale)) });
  }
  for (const name of skills) {
    const source = join(sourceRoot, name);
    const target = join(plan.newPaths.skills, name);
    if (linkPointsTo(target, source)) {
      actions.push({ action: "ok", path: relative(ROOT, target) });
      continue;
    }
    if (pathExists(target)) changes.remove(target);
    changes.link(source, target);
    actions.push({ action: "link-skill", path: relative(ROOT, target) });
  }
}

export function expectedExcludePatterns(config, skills) {
  const patterns = ["/AGENTS.local.md"];
  if (config.agent.entry_path) patterns.push("/" + config.agent.entry_path.replaceAll("\\", "/"));
  if (config.agent.skills_path) {
    const base = config.agent.skills_path.replaceAll("\\", "/").replace(/\/$/, "");
    patterns.push(...(skills || discoverSkills()).map((name) => "/" + base + "/" + name));
  }
  return patterns;
}

export function runSetup(options) {
  return withFileLocks([join(ROOT, ".spec-workflow.setup.lock")], () => {
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
      changes.write(LOCAL_CONFIG_FILE, plan.localContent);
      changes.write(plan.exclude.path, plan.exclude.content);
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
  });
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
