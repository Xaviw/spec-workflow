import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  discoverSkills,
  parseSetupConfig,
  repositoryIdentity,
  runGit,
} from "./common.js";
import { inspectIntegration, readRawLocalConfig } from "./setup.js";

function nodeVersionAtLeast(actual, minimum) {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < right.length; index += 1) {
    if ((left[index] || 0) !== right[index]) return (left[index] || 0) > right[index];
  }
  return true;
}

export function runDoctor() {
  const checks = [];
  const add = (id, level, message, hint) => {
    const check = { id, level, message };
    if (hint) check.hint = hint;
    checks.push(check);
  };

  add(
    "runtime.node",
    nodeVersionAtLeast(process.versions.node, "22.12.0") ? "ok" : "error",
    "Node.js " + process.versions.node,
    "安装 Node.js 22.12.0 或更高版本，并确保 node 可执行文件位于 PATH",
  );
  add(
    "workflow.git",
    runGit(["rev-parse", "--is-inside-work-tree"], ROOT, true) === "true" ? "ok" : "error",
    "工作流根目录 Git 仓库",
    "先初始化工作流仓库",
  );
  for (const [id, path] of [
    ["workflow.entry", join(ROOT, "tools", "workflow.js")],
    ["workflow.instructions", join(ROOT, "AGENTS.md")],
  ]) {
    add(id, existsSync(path) ? "ok" : "error", path.slice(ROOT.length + 1), "恢复缺失文件");
  }

  let skills = [];
  let skillsAvailable = false;
  try {
    skills = discoverSkills();
    skillsAvailable = true;
    add("skills.discovery", "ok", `发现 ${skills.length} 个 Skill`);
  } catch (error) {
    add("skills.discovery", "error", error.message, "检查 .agents/skills/*/SKILL.md");
  }

  let config = null;
  try {
    const raw = readRawLocalConfig();
    if (!raw) throw new Error("缺少 AGENTS.local.md 受管配置");
    config = parseSetupConfig(raw);
    add("setup.config", "ok", "setup 受管配置有效");
  } catch (error) {
    add("setup.config", "error", error.message, "运行 setup 更新接入配置");
  }

  if (config) {
    for (const repository of config.repositories) {
      try {
        repositoryIdentity(repository.path);
        add("repository." + repository.id, "ok", repository.path);
      } catch (error) {
        add("repository." + repository.id, "error", error.message, "运行 setup 更新仓库映射");
      }
    }
    let integration = null;
    try {
      integration = inspectIntegration(config, skillsAvailable ? skills : null);
    } catch (error) {
      add("agent.integration", "error", error.message, "运行 setup 同步 Agent 接入");
    }
    const localPaths = ["AGENTS.local.md", integration?.entry_path, integration?.skills_path].filter(Boolean);
    const unignored = localPaths.filter(
      (path) => !runGit(["check-ignore", "--no-index", "-v", path], ROOT, true),
    );
    add(
      "setup.local-ignore",
      unignored.length ? "error" : "ok",
      unignored.length ? "缺少本地忽略规则: " + unignored.join(", ") : "本地配置和 Agent 适配入口保持本地",
      "将缺失路径加入 .gitignore",
    );
    if (integration?.entry) {
      add(
        "agent.entry",
        integration.entry_ok ? "ok" : "error",
        integration.entry_path,
        "运行 setup 同步 Agent 入口",
      );
    } else if (integration) {
      add("agent.entry", "ok", "Agent 原生读取 AGENTS.md");
    }
    if (integration?.skills) {
      if (!skillsAvailable) {
        add("agent.skills", "error", "Skills 发现失败，无法检查 Agent 链接", "先修复 skills.discovery");
      } else {
        for (const link of integration.skill_links) {
          add(
            "agent.skill." + link.name,
            link.ok ? "ok" : "error",
            integration.skills_path + "/" + link.name,
            "运行 setup 同步 Skills 链接",
          );
        }
        for (const name of integration.stale_skill_links) {
          add(
            "agent.skill.stale." + name,
            "error",
            "残留的受管 Skill 链接: " + integration.skills_path + "/" + name,
            "运行 setup 清理失效链接",
          );
        }
      }
    } else if (integration) {
      add("agent.skills", "ok", "Agent 原生读取 .agents/skills");
    }
  }

  return checks;
}

export function printDoctor(checks, json = false) {
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  for (const check of checks) {
    console.log(`[${check.level.toUpperCase()}] ${check.id}: ${check.message}`);
    if (check.hint && check.level !== "ok") console.log("  修复: " + check.hint);
  }
  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  console.log(`阻塞 ${errors}，警告 ${warnings}`);
}
