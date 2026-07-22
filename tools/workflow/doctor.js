import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";

import {
  ROOT,
  SKILLS,
  extractManagedJson,
  fileHash,
  findSecretPaths,
  isGitRepository,
  listIterationDirectories,
  readJson,
  readText,
  runGit,
  workflowPath,
} from "./common.js";
import {
  adapterDefinition,
  linkPointsTo,
  sameSkill,
} from "./adapter.js";
import { aggregateRelease } from "./release.js";
import { validateSetupConfig } from "./setup.js";

function compareVersion(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const result = (a[index] || 0) - (b[index] || 0);
    if (result) {
      return result;
    }
  }
  return 0;
}

export function runDoctor(options = {}, root = ROOT) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });
  if (compareVersion(process.versions.node, "22.12.0") < 0) {
    add("error", "Node.js 必须 >=22.12.0，当前为 " + process.versions.node);
  } else {
    add("ok", "Node.js " + process.versions.node);
  }
  for (const path of [
    "AGENTS.md",
    "WORKFLOW_VERSION",
    "tools/workflow.js",
    "tools/agent-adapters.json",
    "tools/package.json",
  ]) {
    add(existsSync(join(root, path)) ? "ok" : "error", "核心文件 " + path);
  }
  for (const skill of SKILLS) {
    const path = join(root, ".agents", "skills", skill, "SKILL.md");
    add(existsSync(path) ? "ok" : "error", "Skill " + skill);
  }
  if (options.template) {
    return checks;
  }
  if (!isGitRepository(root)) {
    add("error", "工作流根目录不是 Git 仓库");
  }
  const localFile = join(root, "AGENTS.local.md");
  if (!existsSync(localFile)) {
    add("error", "缺少 AGENTS.local.md，请先执行 setup");
    return checks;
  }
  let config;
  try {
    config = extractManagedJson(readText(localFile));
    validateSetupConfig(config, root);
    if (findSecretPaths(readText(localFile)).length) {
      add("error", "AGENTS.local.md 含疑似密钥值");
    } else {
      add("ok", "AGENTS.local.md 格式和密钥检查");
    }
  } catch (error) {
    add("error", "AGENTS.local.md: " + error.message);
    return checks;
  }
  add(
    existsSync(join(root, "project", "index.md")) ? "ok" : "error",
    "项目索引 project/index.md",
  );
  if (
    config.permissions?.production_write !== false ||
    config.permissions?.deploy !== false ||
    config.permissions?.ddl_execute !== false
  ) {
    add("error", "生产写入、部署和 DDL 执行权限必须保持关闭");
  } else {
    add("ok", "高风险环境权限保持关闭");
  }
  for (const repo of config.repositories || []) {
    if (
      (repo.environments?.remote_write || []).some((environment) =>
        /^(prod|production|prd)$/i.test(environment),
      )
    ) {
      add("error", "仓库 " + repo.id + " 配置了生产环境写权限");
    }
  }
  const currentVersion = readText(join(root, "WORKFLOW_VERSION")).trim();
  const configuredVersion = String(config.workflow_version || "");
  if (currentVersion.split(".")[0] !== configuredVersion.split(".")[0]) {
    add("error", "本地配置与工作流主版本不兼容");
  } else if (currentVersion !== configuredVersion) {
    add("warn", "本地配置版本为 " + configuredVersion + "，当前为 " + currentVersion);
  } else {
    add("ok", "工作流版本 " + currentVersion);
  }
  for (const repo of config.repositories || []) {
    if (!existsSync(repo.path)) {
      add("error", "仓库路径不存在: " + repo.id);
    } else if (!isGitRepository(repo.path)) {
      add("error", "仓库不是 Git 仓库: " + repo.id);
    } else {
      add("ok", "目标仓库 " + repo.id);
    }
    add(
      existsSync(join(root, "project", "repositories", repo.id + ".md"))
        ? "ok"
        : "error",
      "仓库文档 " + repo.id,
    );
  }
  try {
    const definition = adapterDefinition(config.agent.id, config);
    if (definition.native_agents_md && definition.native_agents_skills) {
      const setupNote = definition.setup_note ? "；" + definition.setup_note : "";
      add("ok", definition.display_name + " 原生入口和 Skills" + setupNote);
    } else {
      const entry = workflowPath(definition.adapter.entry_path);
      const entryText = readText(entry);
      add(
        entryText.includes(definition.adapter.entry_content) ? "ok" : "error",
        definition.display_name + " 入口适配",
      );
      const targetRoot = workflowPath(definition.adapter.skills_path);
      for (const skill of SKILLS) {
        const source = join(root, ".agents", "skills", skill);
        const target = join(targetRoot, skill);
        add(
          linkPointsTo(target, source) || sameSkill(source, target) ? "ok" : "error",
          definition.display_name + " Skill " + skill,
        );
      }
      const ignoredEntry = runGit(
        ["check-ignore", "--", relative(root, entry)],
        root,
        true,
      );
      add(
        ignoredEntry ? "ok" : "error",
        definition.display_name + " 生成入口已 Git 忽略",
      );
    }
  } catch (error) {
    add("error", "Agent 适配: " + error.message);
  }
  for (const iteration of listIterationDirectories(root)) {
    try {
      const iterationJson = readJson(join(iteration, "iteration.json"));
      if (iterationJson.release_plan?.status !== "confirmed") {
        continue;
      }
      const current = aggregateRelease(iteration);
      add(
        current.fingerprint === iterationJson.release_plan.fingerprint
          ? "ok"
          : "error",
        "发布方案指纹 " + basename(iteration),
      );
      add(
        fileHash(join(iteration, "release-plan.md")) ===
          iterationJson.release_plan.plan_hash
          ? "ok"
          : "error",
        "发布方案文件 " + basename(iteration),
      );
    } catch (error) {
      add("error", "迭代检查 " + basename(iteration) + ": " + error.message);
    }
  }
  return checks;
}

export function printDoctor(checks, json = false) {
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  const labels = { ok: "通过", warn: "警告", error: "阻塞" };
  for (const check of checks) {
    console.log("[" + labels[check.level] + "] " + check.message);
  }
  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  console.log("\n阻塞 " + errors + "，警告 " + warnings + "。");
}
