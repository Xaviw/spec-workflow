import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  ROOT,
  SKILLS,
  ensureWithin,
  legacySkillName,
  readJson,
  readText,
  replaceTextBlock,
  runGit,
  workflowPath,
  writeText,
} from "./common.js";

const ADAPTER_START = "<!-- spec-driven:adapter:start -->";
const ADAPTER_END = "<!-- spec-driven:adapter:end -->";
const EXCLUDE_START = "# spec-driven:adapter:start";
const EXCLUDE_END = "# spec-driven:adapter:end";
const SYMLINK_FALLBACK_ERRORS = new Set([
  "EACCES",
  "EPERM",
  "EINVAL",
  "ENOTSUP",
]);

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function adapterDefinition(agentId, config) {
  const table = readJson(join(ROOT, "tools", "agent-adapters.json"));
  if (agentId === "custom") {
    if (!config?.agent || config.agent.id !== "custom") {
      throw new Error("AGENTS.local.md 中没有自定义 Agent 配置");
    }
    return {
      id: "custom",
      display_name: config.agent.display_name || "Custom",
      native_agents_md: false,
      native_agents_skills: false,
      adapter: {
        entry_path: config.agent.entry_path,
        entry_content:
          config.agent.entry_content || "请读取并遵循根目录 AGENTS.md",
        skills_path: config.agent.skills_path,
      },
    };
  }
  const adapter = table.agents.find((item) => item.id === agentId);
  if (!adapter) {
    throw new Error("未知 Agent: " + agentId);
  }
  return adapter;
}

export function sameSkill(source, target) {
  const sourceFile = join(source, "SKILL.md");
  const targetFile = join(target, "SKILL.md");
  return (
    existsSync(sourceFile) &&
    existsSync(targetFile) &&
    readText(sourceFile) === readText(targetFile)
  );
}

export function linkPointsTo(path, expected) {
  if (!entryExists(path) || !lstatSync(path).isSymbolicLink()) {
    return false;
  }
  return resolve(dirname(path), readlinkSync(path)) === resolve(expected);
}

export function installAdapter(agentId, config, options = {}) {
  const definition = adapterDefinition(agentId, config);
  if (definition.native_agents_md && definition.native_agents_skills) {
    const setupNote = definition.setup_note ? "；" + definition.setup_note : "";
    return [{
      action: "native",
      detail: definition.display_name + " 无需生成适配器" + setupNote,
    }];
  }
  const apply = Boolean(options.apply);
  const replace = Boolean(options.replace);
  const actions = [];
  const entryPath = workflowPath(definition.adapter.entry_path);
  const entryContent = definition.adapter.entry_content;
  const sourceRoot = join(ROOT, ".agents", "skills");
  const targetRoot = workflowPath(definition.adapter.skills_path);
  const skillTargets = SKILLS.map((skill) => ({
    source: join(sourceRoot, skill),
    target: ensureWithin(targetRoot, join(targetRoot, skill)),
  }));
  const legacyTargets = SKILLS.map((skill) =>
    ensureWithin(targetRoot, join(targetRoot, legacySkillName(skill))),
  ).filter(entryExists);
  const conflicts = skillTargets.filter(
    ({ source, target }) =>
      entryExists(target) && !linkPointsTo(target, source) && !sameSkill(source, target),
  );
  if (apply && !replace && (conflicts.length || legacyTargets.length)) {
    const conflict = conflicts[0]?.target || legacyTargets[0];
    throw new Error(
      "适配目标冲突或仍使用旧 Skill 名称；先预览并明确添加 --replace: " +
        relative(ROOT, conflict),
    );
  }
  for (const target of legacyTargets) {
    actions.push({
      action: replace ? (apply ? "remove" : "would-remove") : "conflict",
      path: relative(ROOT, target),
    });
    if (apply && replace) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  actions.push({
    action: apply ? "write" : "would-write",
    path: relative(ROOT, entryPath),
  });
  if (apply) {
    const current = readText(entryPath);
    writeText(
      entryPath,
      replaceTextBlock(
        current,
        entryContent,
        ADAPTER_START,
        ADAPTER_END,
      ),
    );
  }

  if (apply) {
    mkdirSync(targetRoot, { recursive: true });
  }
  for (const { source, target } of skillTargets) {
    if (entryExists(target)) {
      if (linkPointsTo(target, source) || sameSkill(source, target)) {
        actions.push({ action: "ok", path: relative(ROOT, target) });
        continue;
      }
      if (!replace) {
        actions.push({ action: "conflict", path: relative(ROOT, target) });
        continue;
      }
      actions.push({
        action: apply ? "replace" : "would-replace",
        path: relative(ROOT, target),
      });
      if (apply) {
        rmSync(target, { recursive: true, force: true });
      }
    } else {
      actions.push({
        action: apply ? "install" : "would-install",
        path: relative(ROOT, target),
      });
    }
    if (!apply) {
      continue;
    }
    try {
      const linkTarget = process.platform === "win32"
        ? source
        : relative(dirname(target), source) || ".";
      symlinkSync(linkTarget, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!SYMLINK_FALLBACK_ERRORS.has(error.code)) {
        throw error;
      }
      cpSync(source, target, { recursive: true });
      actions[actions.length - 1].method = "copy";
    }
  }
  return actions;
}

export function ensureAdapterIgnored(agentId, config) {
  const definition = adapterDefinition(agentId, config);
  if (definition.native_agents_md && definition.native_agents_skills) {
    return;
  }
  const entry = relative(ROOT, workflowPath(definition.adapter.entry_path)).replaceAll("\\", "/");
  const skills = relative(ROOT, workflowPath(definition.adapter.skills_path)).replaceAll("\\", "/");
  const gitPath = runGit(["rev-parse", "--git-path", "info/exclude"], ROOT);
  const excludeFile = isAbsolute(gitPath) ? gitPath : resolve(ROOT, gitPath);
  const patterns = ["/" + entry, "/" + skills + "/sw-*/"].join("\n");
  writeText(
    excludeFile,
    replaceTextBlock(readText(excludeFile), patterns, EXCLUDE_START, EXCLUDE_END),
  );
}
