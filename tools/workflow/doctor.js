import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  ROOT,
  SKILLS,
  PHASES,
  TASK_TYPES,
  ensureExistingWithin,
  extractManagedJson,
  fileHash,
  fingerprint,
  findSecretPaths,
  isGitRepository,
  legacySkillName,
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
import {
  aggregateRelease,
  validateReleaseCommitReferences,
} from "./release.js";
import {
  assertRepositoryRegistration,
  validateSetupConfig,
} from "./setup.js";

const ITERATION_STATUSES = new Set(["open", "done", "cancelled"]);
const SLICE_STATUSES = new Set(["pending", "in_progress", "done"]);
const PHASE_ARTIFACTS = {
  prd: ["prd.md", "decisions.md"],
  technical_design: ["prd.md", "decisions.md", "technical-design.md"],
  implementation_spec: [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
  ],
  implementation: [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
  ],
  verification: [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
    "verification.md",
  ],
  done: [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
    "verification.md",
  ],
  cancelled: ["prd.md", "decisions.md"],
};

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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateSlices(task, label, add) {
  if (!Array.isArray(task.slices)) {
    add("error", label + " 的 slices 必须是数组");
    return;
  }
  const ids = new Set();
  const dependencies = new Map();
  let inProgress = 0;
  for (const slice of task.slices) {
    if (!isObject(slice) || !slice.id || ids.has(slice.id)) {
      add("error", label + " 的 slice ID 缺失或重复");
      continue;
    }
    ids.add(slice.id);
    if (!slice.title) {
      add("error", label + " 的 slice " + slice.id + " 缺少标题");
    }
    if (!SLICE_STATUSES.has(slice.status)) {
      add("error", label + " 的 slice " + slice.id + " 状态无效");
    }
    if (slice.status === "in_progress") {
      inProgress += 1;
    }
    if (slice.blocked_by !== undefined && !Array.isArray(slice.blocked_by)) {
      add("error", label + " 的 slice " + slice.id + " blocked_by 必须是数组");
    }
    dependencies.set(slice.id, Array.isArray(slice.blocked_by) ? slice.blocked_by : []);
  }
  if (inProgress > 1) {
    add("error", label + " 同时有多个 in_progress slice");
  }
  for (const [id, blockedBy] of dependencies) {
    for (const dependency of blockedBy) {
      if (dependency === id || !ids.has(dependency)) {
        add("error", label + " 的 slice " + id + " 包含无效依赖 " + dependency);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function hasCycle(id) {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) {
      if (ids.has(dependency) && hasCycle(dependency)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if ([...ids].some(hasCycle)) {
    add("error", label + " 的 slice 依赖存在循环");
  }
  if (
    ["verification", "done"].includes(task.phase) &&
    task.slices.some((slice) => slice.status !== "done")
  ) {
    add("error", label + " 进入 " + task.phase + " 时仍有未完成 slice");
  }
}

function validateCheckpoints(taskDirectory, task, label, add) {
  const requireFresh = task.phase !== "cancelled";
  if (task.checkpoints !== undefined && !isObject(task.checkpoints)) {
    add("error", label + " 的 checkpoints 必须是对象");
    return;
  }
  for (const [phase, checkpoint] of Object.entries(task.checkpoints || {})) {
    if (!PHASES.includes(phase) || !isObject(checkpoint)) {
      add("error", label + " 含无效 checkpoint: " + phase);
      continue;
    }
    if (!checkpoint.content_hash || (phase !== "implementation" && !checkpoint.artifact)) {
      add("error", label + " 的 " + phase + " checkpoint 缺少产物或哈希");
      continue;
    }
    if (checkpoint.artifact) {
      try {
        const artifact = ensureExistingWithin(
          taskDirectory,
          resolve(taskDirectory, checkpoint.artifact),
        );
        if (!existsSync(artifact)) {
          add("error", label + " 的 " + phase + " checkpoint 产物不存在");
        } else if (
          requireFresh &&
          fileHash(artifact) !== checkpoint.content_hash
        ) {
          add("error", label + " 的 " + phase + " checkpoint 已失效");
        }
      } catch {
        add("error", label + " 的 " + phase + " checkpoint 路径越界");
      }
    }
    if (!isObject(checkpoint.dependency_hashes)) {
      add("error", label + " 的 " + phase + " dependency_hashes 无效");
    } else {
      if (!Object.hasOwn(checkpoint.dependency_hashes, "decisions")) {
        add("error", label + " 的 " + phase + " checkpoint 缺少 decisions 依赖");
      }
      const dependencyFiles = {
        decisions: "decisions.md",
        prd: "prd.md",
        technical_design: "technical-design.md",
        implementation_spec: "spec.md",
      };
      for (const [dependency, recordedHash] of Object.entries(
        checkpoint.dependency_hashes || {},
      )) {
        const currentHash = dependency === "implementation"
          ? task.checkpoints?.implementation?.content_hash
          : dependencyFiles[dependency]
            ? fileHash(join(taskDirectory, dependencyFiles[dependency]))
            : undefined;
        if (currentHash === undefined) {
          add("error", label + " 的 " + phase + " 含未知 checkpoint 依赖 " + dependency);
        } else if (currentHash === null && recordedHash !== null) {
          add("error", label + " 的 " + phase + " checkpoint 依赖不存在：" + dependency);
        } else if (requireFresh && currentHash !== recordedHash) {
          add("error", label + " 的 " + phase + " checkpoint 上游已失效");
        }
      }
    }
    if (
      checkpoint.revision !== undefined &&
      (!validRevision(checkpoint.revision) || checkpoint.revision > task.revision)
    ) {
      add("error", label + " 的 " + phase + " checkpoint revision 无效");
    }
    const approval = task.approvals?.[phase];
    const checkpointHash = fingerprint({
      phase,
      artifact: checkpoint.artifact ?? null,
      content_hash: checkpoint.content_hash ?? null,
      dependency_hashes: checkpoint.dependency_hashes || {},
    });
    if (
      !isObject(approval) ||
      approval.status !== "confirmed" ||
      approval.checkpoint_hash !== checkpointHash ||
      !validRevision(approval.revision) ||
      approval.revision > task.revision
    ) {
      add("error", label + " 的 " + phase + " approval 无效或已失效");
    }
  }
  if (task.approvals !== undefined && !isObject(task.approvals)) {
    add("error", label + " 的 approvals 必须是对象");
  }
  if (PHASES.includes(task.phase)) {
    const currentIndex = PHASES.indexOf(task.phase);
    for (const phase of PHASES.slice(0, currentIndex)) {
      if (phase === "done") {
        continue;
      }
      if (!task.checkpoints?.[phase] || !task.approvals?.[phase]) {
        add("error", label + " 缺少已通过阶段 checkpoint: " + phase);
      }
    }
  }
}

function validateDelivery(task, label, repositories, add) {
  const delivery = task.delivery;
  if (delivery !== undefined && !isObject(delivery)) {
    add("error", label + " 的 delivery 必须是对象");
    return;
  }
  const entries = Array.isArray(delivery?.repositories)
    ? delivery.repositories
    : [];
  if (task.phase === "done" && task.repositories.length && !entries.length) {
    add("error", label + " 已完成但缺少 delivery.repositories");
  }
  const ids = new Set();
  for (const entry of entries) {
    const repoId = entry?.id;
    if (!repoId || ids.has(repoId)) {
      add("error", label + " 的 delivery 仓库 ID 缺失或重复");
      continue;
    }
    ids.add(repoId);
    if (!task.repositories.includes(repoId)) {
      add("error", label + " 的 delivery 引用了未声明仓库 " + repoId);
    }
    const repo = repositories.get(repoId);
    if (!repo) {
      add("error", label + " 的 delivery 引用了未登记仓库 " + repoId);
      continue;
    }
    let identity;
    try {
      identity = assertRepositoryRegistration(repo);
      if (!entry.canonical_root) {
        if (task.phase === "done") {
          add("error", label + " 的仓库 " + repoId + " 缺少 canonical_root");
        }
      } else {
        const recorded = assertRepositoryRegistration({
          id: repoId,
          path: entry.canonical_root,
        });
        if (recorded.path_key !== identity.path_key) {
          add("error", label + " 的仓库 " + repoId + " canonical_root 已漂移");
        }
      }
    } catch (error) {
      add("error", label + " 的仓库 " + repoId + ": " + error.message);
      continue;
    }
    for (const field of ["baseline_head", "final_head"]) {
      if (task.phase === "done" && !entry[field]) {
        add("error", label + " 的仓库 " + repoId + " 缺少 " + field);
      } else if (
        entry[field] &&
        !runGit(
          ["rev-parse", "--verify", String(entry[field]) + "^{commit}"],
          identity.path,
          true,
        )
      ) {
        add("error", label + " 的仓库 " + repoId + " 的 " + field + " 不存在");
      }
    }
    if (!Array.isArray(entry.initial_dirty_paths)) {
      add("error", label + " 的仓库 " + repoId + " initial_dirty_paths 必须是数组");
    }
    if (!Array.isArray(entry.initial_dirty_state)) {
      add("error", label + " 的仓库 " + repoId + " 缺少初始脏文件指纹");
    }
    if (task.phase === "done" && !entry.verification_tree) {
      add("error", label + " 的仓库 " + repoId + " 缺少 verification_tree");
    } else if (
      entry.verification_tree &&
      !runGit(
        ["rev-parse", "--verify", String(entry.verification_tree) + "^{tree}"],
        identity.path,
        true,
      )
    ) {
      add("error", label + " 的仓库 " + repoId + " verification_tree 不存在");
    }
    if (!Array.isArray(entry.commits) || (task.phase === "done" && !entry.commits.length)) {
      add("error", label + " 的仓库 " + repoId + " 缺少交付 commits");
    }
    if (
      entry.remaining_dirty_paths !== undefined &&
      !Array.isArray(entry.remaining_dirty_paths)
    ) {
      add("error", label + " 的仓库 " + repoId + " remaining_dirty_paths 必须是数组");
    }
    if (task.phase === "done" && !entry.finalized_at) {
      add("error", label + " 的仓库 " + repoId + " 缺少 finalized_at");
    }
  }
  if (task.phase === "done") {
    for (const repoId of task.repositories) {
      if (!ids.has(repoId)) {
        add("error", label + " 缺少仓库 " + repoId + " 的 delivery 记录");
      }
    }
  }
}

function validateTaskDirectory(directory, repositories, add) {
  const label = "任务 " + basename(directory);
  let task;
  try {
    task = readJson(join(directory, "task.json"));
  } catch (error) {
    add("error", label + " 的 task.json 无效: " + error.message);
    return;
  }
  if (!isObject(task) || !task.title || !task.summary) {
    add("error", label + " 缺少 title 或 summary");
  }
  if (task.schema_version !== 2) {
    add("error", label + " 的 schema_version 不受支持");
  }
  if (!validRevision(task.revision)) {
    add("error", label + " 的 revision 无效");
  }
  if (!TASK_TYPES.includes(task.type)) {
    add("error", label + " 的 type 无效");
  }
  if (![...PHASES, "cancelled"].includes(task.phase)) {
    add("error", label + " 的 phase 无效");
  }
  if (!Array.isArray(task.repositories) || !Array.isArray(task.modules)) {
    add("error", label + " 的 repositories/modules 必须是数组");
    return;
  }
  for (const repoId of task.repositories) {
    if (!repositories.has(repoId)) {
      add("error", label + " 引用了未登记仓库 " + repoId);
    }
  }
  for (const artifact of PHASE_ARTIFACTS[task.phase] || []) {
    const path = join(directory, artifact);
    if (!existsSync(path) || !readText(path).trim()) {
      add("error", label + " 在 " + task.phase + " 阶段缺少有效 " + artifact);
    }
  }
  task.revision = Number.isInteger(task.revision) ? task.revision : 0;
  validateSlices(task, label, add);
  validateCheckpoints(directory, task, label, add);
  validateDelivery(task, label, repositories, add);
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
    ".gitattributes",
    "AGENTS.md",
    "tools/workflow.js",
    "tools/agent-adapters.json",
    "tools/package.json",
    "standards/logging.md",
    "standards/security.md",
    "standards/api-contract.md",
    "standards/api-signing-v2.md",
    "standards/mysql.md",
    "standards/redis.md",
    "standards/object-storage.md",
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
  } catch (error) {
    add("error", "AGENTS.local.md: " + error.message);
    return checks;
  }
  try {
    validateSetupConfig(config, root);
  } catch (error) {
    add("error", "AGENTS.local.md: " + error.message);
  }
  if (findSecretPaths(readText(localFile)).length) {
    add("error", "AGENTS.local.md 含疑似密钥值");
  } else {
    add("ok", "AGENTS.local.md 格式和密钥检查");
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
  const currentVersion = readJson(join(root, "tools", "package.json")).version;
  const configuredVersion = String(config.workflow_version || "");
  if (currentVersion.split(".")[0] !== configuredVersion.split(".")[0]) {
    add("error", "本地配置与工作流主版本不兼容");
  } else if (currentVersion !== configuredVersion) {
    add("warn", "本地配置版本为 " + configuredVersion + "，当前为 " + currentVersion);
  } else {
    add("ok", "工作流版本 " + currentVersion);
  }
  const repositories = new Map();
  const repositoryPaths = new Set();
  for (const repo of config.repositories || []) {
    repositories.set(repo.id, repo);
    try {
      const identity = assertRepositoryRegistration(repo);
      if (repositoryPaths.has(identity.path_key)) {
        add("error", "仓库 " + repo.id + " 与其他 ID 指向同一 Git 根目录");
      } else {
        repositoryPaths.add(identity.path_key);
        add("ok", "目标仓库根目录与 remote " + repo.id);
      }
    } catch (error) {
      add("error", "目标仓库 " + repo.id + ": " + error.message);
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
      const legacySkills = SKILLS.filter((skill) => {
        const legacy = legacySkillName(skill);
        const legacyTarget = join(targetRoot, legacy);
        const legacySource = join(root, ".agents", "skills", legacy);
        return (
          existsSync(legacyTarget) ||
          linkPointsTo(legacyTarget, legacySource)
        );
      });
      if (legacySkills.length) {
        add(
          "error",
          definition.display_name + " 存在 " + legacySkills.length +
            " 个旧名称 Skill；先预览 adapter install --agent " + definition.id +
            "，确认后添加 --replace --apply",
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
    const iterationId = basename(iteration);
    let iterationJson;
    try {
      iterationJson = readJson(join(iteration, "iteration.json"));
    } catch (error) {
      add("error", "迭代 " + iterationId + " 的 iteration.json 无效: " + error.message);
      continue;
    }
    if (
      !isObject(iterationJson) ||
      !iterationJson.title ||
      !iterationJson.goal ||
      !ITERATION_STATUSES.has(iterationJson.status)
    ) {
      add("error", "迭代 " + iterationId + " 缺少基础字段或 status 无效");
    }
    if (iterationJson.schema_version !== 2) {
      add("error", "迭代 " + iterationId + " 的 schema_version 不受支持");
    }
    if (!validRevision(iterationJson.revision)) {
      add("error", "迭代 " + iterationId + " 的 revision 无效");
    }
    if (iterationJson.id !== iterationId) {
      add("error", "迭代 " + iterationId + " 的稳定 ID 与目录名不一致");
    }
    if (["done", "cancelled"].includes(iterationJson.status)) {
      if (
        !isObject(iterationJson.closure_receipt) ||
        iterationJson.closure_receipt.status !== iterationJson.status ||
        iterationJson.closure_receipt.revision !== iterationJson.revision
      ) {
        add("error", "终态迭代 " + iterationId + " 的 closure_receipt 无效");
      }
    }
    if (
      iterationJson.release_plan &&
      !["draft", "confirmed"].includes(iterationJson.release_plan.status)
    ) {
      add("error", "迭代 " + iterationId + " 的 release_plan 状态无效");
    }
    if (iterationJson.status === "cancelled" && iterationJson.release_plan) {
      add("error", "已取消迭代 " + iterationId + " 不应保留发布方案状态");
    }
    for (const entry of readdirSync(iteration, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(iteration, entry.name, "task.json"))) {
        validateTaskDirectory(join(iteration, entry.name), repositories, add);
      }
    }
    try {
      const current = aggregateRelease(iteration);
      for (const error of current.integrity_errors) {
        add("error", "迭代 " + iterationId + ": " + error);
      }
      if (iterationJson.status === "done" && current.unfinished.length) {
        add("error", "已完成迭代 " + iterationId + " 仍有未完成任务");
      }
      if (iterationJson.status === "done" && iterationJson.release_plan?.status !== "confirmed") {
        add("error", "已完成迭代 " + iterationId + " 缺少 confirmed 发布方案");
      }
      if (iterationJson.release_plan?.status === "draft") {
        add(
          current.fingerprint === iterationJson.release_plan.fingerprint ? "ok" : "warn",
          "发布草案来源 " + iterationId,
        );
      }
      if (iterationJson.release_plan?.status === "confirmed") {
        const fingerprintValid =
          current.fingerprint === iterationJson.release_plan.fingerprint;
        const planHash = fileHash(join(iteration, "release-plan.md"));
        const planValid = planHash === iterationJson.release_plan.plan_hash;
        add(fingerprintValid ? "ok" : "error", "发布方案指纹 " + iterationId);
        add(planValid ? "ok" : "error", "发布方案文件 " + iterationId);
        if (
          iterationJson.status === "open" &&
          iterationJson.release_plan.confirmation_revision !== iterationJson.revision
        ) {
          add("error", "发布方案确认 revision 已失效 " + iterationId);
        }
        if (
          iterationJson.status === "done" &&
          iterationJson.closure_receipt?.confirmation_revision !==
            iterationJson.release_plan.confirmation_revision
        ) {
          add("error", "迭代收口回执未绑定发布确认 " + iterationId);
        }
        const commitErrors = validateReleaseCommitReferences(current, config);
        for (const error of commitErrors) {
          add("error", "发布 commit " + iterationId + ": " + error);
        }
      }
      add("ok", "迭代与任务结构 " + iterationId);
    } catch (error) {
      add("error", "迭代检查 " + iterationId + ": " + error.message);
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
