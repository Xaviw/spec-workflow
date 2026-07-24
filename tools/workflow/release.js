import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  ROOT,
  ensureWithin,
  fileHash,
  fingerprint,
  iterationLockPath,
  optionList,
  parseIterationData,
  readJson,
  readLocalConfig,
  readText,
  resolveIteration,
  runGit,
  withFileLocks,
  writeJson,
  writeText,
} from "./common.js";
import {
  assertRepositoryRegistration,
  inspectRepositoryRoot,
} from "./setup.js";
import { parseTaskData, validateTask } from "./tasks.js";

const TASK_ARTIFACTS = [
  "prd.md",
  "decisions.md",
  "technical-design.md",
  "spec.md",
  "verification.md",
];
const CHANGE_FIELDS = new Set([
  "schema_version",
  "id",
  "timestamp",
  "summary",
  "commits",
  "verification",
  "project_docs",
]);

function now() {
  return new Date().toISOString();
}

function nextIterationRevision(iteration, directory) {
  parseIterationData(iteration, directory);
  iteration.revision += 1;
  iteration.updated_at = now();
  return iteration.revision;
}

function assertOpenIteration(iteration, action) {
  if (iteration.status !== "open") {
    throw new Error(action + "只允许用于开放迭代；done/cancelled 是不可变终态");
  }
}

function normalizedDelivery(task) {
  return {
    repositories: task.delivery.repositories.map((repo) => ({
      id: repo.id,
      canonical_root: repo.canonical_root,
      branch: repo.branch,
      baseline_head: repo.baseline_head,
      initial_dirty_paths: [...repo.initial_dirty_paths],
      initial_dirty_state: repo.initial_dirty_state.map((entry) => ({ ...entry })),
      captured_at: repo.captured_at,
      verification_tree: repo.verification_tree,
      commits: [...repo.commits],
      final_head: repo.final_head,
      remaining_dirty_paths: repo.remaining_dirty_paths
        ? [...repo.remaining_dirty_paths]
        : [],
      finalized_at: repo.finalized_at || null,
    })),
  };
}

function artifactHashes(taskDirectory, task) {
  const names = new Set(TASK_ARTIFACTS);
  for (const checkpoint of Object.values(task.checkpoints)) {
    if (checkpoint && typeof checkpoint.artifact === "string") {
      names.add(checkpoint.artifact);
    }
  }
  const hashes = {};
  for (const name of [...names].sort()) {
    try {
      const path = ensureWithin(taskDirectory, resolve(taskDirectory, name));
      hashes[relative(taskDirectory, path).replaceAll("\\", "/")] = fileHash(path);
    } catch {
      hashes[String(name)] = null;
    }
  }
  return hashes;
}

function taskSnapshot(iterationDirectory, entry) {
  const directory = join(iterationDirectory, entry.name);
  const path = join(directory, "task.json");
  const task = parseTaskData(readJson(path));
  return {
    id: entry.name,
    schema_version: task.schema_version,
    revision: task.revision,
    task_hash: fileHash(path),
    title: task.title,
    summary: task.summary,
    type: task.type,
    phase: task.phase,
    repositories: [...task.repositories],
    modules: [...task.modules],
    related_tasks: [...task.related_tasks],
    artifacts: artifactHashes(directory, task),
    checkpoints: task.checkpoints,
    approvals: task.approvals,
    slices: task.slices,
    delivery: normalizedDelivery(task),
  };
}

function readChanges(iteration) {
  const path = join(iteration, "changes.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      let change;
      try {
        change = JSON.parse(line);
      } catch {
        throw new Error("changes.jsonl 第 " + (index + 1) + " 行不是有效 JSON");
      }
      if (
        !change ||
        typeof change !== "object" ||
        Array.isArray(change) ||
        change.schema_version !== 2 ||
        typeof change.id !== "string" ||
        !change.id ||
        typeof change.timestamp !== "string" ||
        Number.isNaN(Date.parse(change.timestamp)) ||
        typeof change.summary !== "string" ||
        !change.summary.trim() ||
        !change.commits ||
        typeof change.commits !== "object" ||
        Array.isArray(change.commits) ||
        !Object.keys(change.commits).length ||
        Object.values(change.commits).some((commit) => typeof commit !== "string") ||
        typeof change.verification !== "string" ||
        !change.verification.trim() ||
        !Array.isArray(change.project_docs) ||
        change.project_docs.some((path) => typeof path !== "string")
      ) {
        throw new Error(
          "changes.jsonl 第 " + (index + 1) + " 行格式不受支持",
        );
      }
      const unknownFields = Object.keys(change).filter(
        (field) => !CHANGE_FIELDS.has(field),
      );
      if (unknownFields.length) {
        throw new Error(
          "changes.jsonl 第 " + (index + 1) + " 行包含未知字段：" +
            unknownFields.join(", "),
        );
      }
      return change;
    });
}

function releaseIntegrityErrors(tasks, iterationDirectory) {
  const errors = [];
  for (const task of tasks.filter((item) => item.phase === "done")) {
    try {
      const validation = validateTask(join(iterationDirectory, task.id), {
        phase: "done",
      });
      for (const blocker of validation.blockers) {
        errors.push("任务 " + task.id + " 完整性失败: " + blocker);
      }
    } catch (error) {
      errors.push("任务 " + task.id + " 无法执行完整性校验: " + error.message);
    }
    const delivery = task.delivery.repositories;
    const deliveryIds = new Set();
    if (task.repositories.length && !delivery.length) {
      errors.push("任务 " + task.id + " 缺少结构化 delivery.repositories");
    }
    for (const repo of delivery) {
      if (!repo.id || deliveryIds.has(repo.id)) {
        errors.push("任务 " + task.id + " 的 delivery 仓库 ID 缺失或重复");
        continue;
      }
      deliveryIds.add(repo.id);
      if (!task.repositories.includes(repo.id)) {
        errors.push("任务 " + task.id + " 的 delivery 引用了未声明仓库 " + repo.id);
      }
      if (!repo.verification_tree) {
        errors.push("任务 " + task.id + " 的仓库 " + repo.id + " 缺少 verification_tree");
      }
      if (!repo.commits.length) {
        errors.push("任务 " + task.id + " 的仓库 " + repo.id + " 缺少交付 commit");
      }
    }
    for (const repoId of task.repositories) {
      if (!deliveryIds.has(repoId)) {
        errors.push("任务 " + task.id + " 缺少仓库 " + repoId + " 的 delivery 记录");
      }
    }
  }
  return errors;
}

export function aggregateRelease(iterationDirectory) {
  const iteration = parseIterationData(
    readJson(join(iterationDirectory, "iteration.json")),
    iterationDirectory,
  );
  const tasks = [];
  for (const entry of readdirSync(iterationDirectory, { withFileTypes: true })) {
    const taskPath = join(iterationDirectory, entry.name, "task.json");
    if (entry.isDirectory() && existsSync(taskPath)) {
      tasks.push(taskSnapshot(iterationDirectory, entry));
    }
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  const changes = readChanges(iterationDirectory);
  const sourceIteration = {
    id: iteration.id,
    title: iteration.title,
    goal: iteration.goal,
    target_version: iteration.target_version,
  };
  const sources = { iteration: sourceIteration, tasks, changes };
  return {
    iteration,
    done: tasks.filter((task) => task.phase === "done"),
    cancelled: tasks.filter((task) => task.phase === "cancelled"),
    unfinished: tasks.filter(
      (task) => task.phase !== "done" && task.phase !== "cancelled",
    ),
    changes,
    integrity_errors: releaseIntegrityErrors(tasks, iterationDirectory),
    fingerprint: fingerprint(sources),
  };
}

export function collectReleaseCommitReferences(aggregate) {
  const references = [];
  for (const task of aggregate.done) {
    for (const repo of task.delivery.repositories) {
      for (const sha of repo.commits) {
        references.push({
          repo_id: repo.id,
          sha,
          source_type: "task",
          source_id: task.id,
          canonical_root: repo.canonical_root,
        });
      }
    }
  }
  for (const change of aggregate.changes) {
    for (const [repoId, rawCommit] of Object.entries(change.commits)) {
      const sha = String(rawCommit).trim();
      if (sha) {
        references.push({
          repo_id: repoId,
          sha,
          source_type: "change",
          source_id: change.id,
          canonical_root: null,
        });
      }
    }
  }
  return references.sort(
    (left, right) =>
      left.repo_id.localeCompare(right.repo_id) ||
      left.sha.localeCompare(right.sha) ||
      String(left.source_id).localeCompare(String(right.source_id)),
  );
}

function resolveRepositoryCommit(config, repoId, rawCommit) {
  const repo = (config?.repositories || []).find((item) => item.id === repoId);
  if (!repo) {
    throw new Error("未登记的仓库 ID: " + repoId);
  }
  const identity = assertRepositoryRegistration(repo);
  const commit = String(rawCommit || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
    throw new Error("仓库 " + repoId + " 的 commit 必须是十六进制 SHA");
  }
  const resolvedCommit = runGit(
    ["rev-parse", "--verify", commit + "^{commit}"],
    identity.path,
  );
  if (!/^[0-9a-f]{40,64}$/i.test(resolvedCommit)) {
    throw new Error("仓库 " + repoId + " 的 commit 解析结果无效");
  }
  return { identity, sha: resolvedCommit.toLowerCase() };
}

export function validateReleaseCommitReferences(
  aggregate,
  config = readLocalConfig(),
) {
  const errors = [...aggregate.integrity_errors];
  if (!config) {
    return [...errors, "缺少 AGENTS.local.md，无法验证发布 commit"];
  }
  for (const reference of collectReleaseCommitReferences(aggregate)) {
    try {
      const { identity } = resolveRepositoryCommit(
        config,
        reference.repo_id,
        reference.sha,
      );
      if (reference.canonical_root) {
        const recordedIdentity = inspectRepositoryRoot(reference.canonical_root);
        if (recordedIdentity.path_key !== identity.path_key) {
          errors.push(
            "来源 " + reference.source_id + " 的仓库 " +
              reference.repo_id + " canonical_root 已漂移",
          );
        }
      }
    } catch (error) {
      errors.push("来源 " + reference.source_id + ": " + error.message);
    }
  }
  return [...new Set(errors)];
}

function releasePlanMarkdown(aggregate) {
  const taskLines = aggregate.done.length
    ? aggregate.done.map((task) => "- " + task.id + ": " + task.title)
    : ["- 无"];
  const changeLines = aggregate.changes.length
    ? aggregate.changes.map((change) => "- " + change.summary)
    : ["- 无"];
  const commitReferences = collectReleaseCommitReferences(aggregate);
  const commitLines = commitReferences.length
    ? commitReferences.map(
        (commit) =>
          "- " + commit.repo_id + " @ " + commit.sha + "（" +
          (commit.source_type === "task" ? "任务 " : "变更 ") +
          commit.source_id + "）",
      )
    : ["- 无"];
  const blockers = [
    ...aggregate.unfinished.map(
      (task) => "- " + task.id + " (" + task.phase + ")",
    ),
    ...aggregate.integrity_errors.map((error) => "- " + error),
  ];
  return [
    "# 发布变更方案",
    "",
    "目标版本或批次：" + (aggregate.iteration.target_version || "待确认"),
    "来源指纹：" + aggregate.fingerprint,
    "",
    "## 已完成任务",
    "",
    ...taskLines,
    "",
    "## 独立简单变更",
    "",
    ...changeLines,
    "",
    "## 各仓库 Commit 与版本",
    "",
    ...commitLines,
    "",
    "## 部署顺序与依赖",
    "",
    "待补充。",
    "",
    "## DDL、数据、配置与环境",
    "",
    "待补充；本方案不授权执行 DDL。",
    "",
    "## 公共契约与联调",
    "",
    "待补充。",
    "",
    "## 发布前后检查",
    "",
    "待补充。",
    "",
    "## 回滚方案",
    "",
    "待补充。",
    "",
    "## 未匹配 Git 变更",
    "",
    "待核对。",
    "",
    "## 阻塞项",
    "",
    ...(blockers.length ? blockers : ["- 无"]),
    "",
  ].join("\n");
}

function invalidateReleasePlan(iterationJson, iteration, aggregate, reason) {
  const revision = nextIterationRevision(iterationJson, iteration);
  iterationJson.release_plan = {
    ...(iterationJson.release_plan || {}),
    status: "draft",
    fingerprint: aggregate.fingerprint,
    invalidated_at: now(),
    invalidated_by: reason,
    revision,
  };
  for (const field of [
    "plan_hash",
    "confirmed_at",
    "confirmation_revision",
    "confirmation_receipt",
  ]) {
    delete iterationJson.release_plan[field];
  }
  writeJson(join(iteration, "iteration.json"), iterationJson);
}

export function addChange(options) {
  const iteration = resolveIteration(String(options.iteration || ""));
  if (!options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      addChange({ ...options, __iterationLocked: true }),
    );
  }
  const iterationPath = join(iteration, "iteration.json");
  const iterationJson = parseIterationData(readJson(iterationPath), iteration);
  assertOpenIteration(iterationJson, "追加简单变更");
  if (!options.summary || !options.verification) {
    throw new Error("change add 需要 --summary、--verification 和至少一个 --commit repo=sha");
  }
  const config = readLocalConfig();
  if (!config) {
    throw new Error("缺少 AGENTS.local.md，无法校验仓库和 commit");
  }
  const commits = {};
  for (const item of optionList(options.commit)) {
    const at = item.indexOf("=");
    if (at < 1 || at === item.length - 1) {
      throw new Error("--commit 格式必须是 repo=sha");
    }
    const repoId = item.slice(0, at);
    if (Object.hasOwn(commits, repoId)) {
      throw new Error("同一简单变更不能重复登记仓库: " + repoId);
    }
    commits[repoId] = resolveRepositoryCommit(
      config,
      repoId,
      item.slice(at + 1),
    ).sha;
  }
  if (!Object.keys(commits).length) {
    throw new Error("至少需要一个 commit");
  }
  const item = {
    schema_version: 2,
    id: randomUUID(),
    timestamp: now(),
    summary: String(options.summary),
    commits,
    verification: String(options.verification),
    project_docs: optionList(options["project-docs"]),
  };
  const changesPath = join(iteration, "changes.jsonl");
  const existingChanges = readText(changesPath).trimEnd();
  writeText(
    changesPath,
    (existingChanges ? existingChanges + "\n" : "") + JSON.stringify(item),
  );
  nextIterationRevision(iterationJson, iteration);
  if (iterationJson.release_plan) {
    iterationJson.release_plan.status = "draft";
    iterationJson.release_plan.invalidated_at = now();
    iterationJson.release_plan.invalidated_by = "change_added";
    for (const field of [
      "plan_hash",
      "confirmed_at",
      "confirmation_revision",
      "confirmation_receipt",
    ]) {
      delete iterationJson.release_plan[field];
    }
  }
  writeJson(iterationPath, iterationJson);
  console.log(JSON.stringify(item, null, 2));
}

export function writeReleasePlan(reference, options) {
  const iteration = resolveIteration(reference);
  if (options.apply && !options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      writeReleasePlan(reference, { ...options, __iterationLocked: true }),
    );
  }
  const iterationPath = join(iteration, "iteration.json");
  const iterationJson = parseIterationData(readJson(iterationPath), iteration);
  assertOpenIteration(iterationJson, "生成发布方案");
  const aggregate = aggregateRelease(iteration);
  const markdown = releasePlanMarkdown(aggregate);
  if (!options.apply) {
    console.log(markdown);
    console.log("确认写入后添加 --apply。");
    return;
  }
  const planPath = join(iteration, "release-plan.md");
  const planHash = fileHash(planPath);
  const releasePlan = iterationJson.release_plan;
  if (
    releasePlan?.status === "confirmed" &&
    releasePlan.fingerprint === aggregate.fingerprint &&
    releasePlan.plan_hash === planHash
  ) {
    console.log(relative(ROOT, planPath));
    return;
  }
  if (!existsSync(planPath)) {
    writeText(planPath, markdown);
  } else {
    console.log("release-plan.md 已存在，保留现有内容；请按本次预览手动同步。");
  }
  if (
    releasePlan?.status === "draft" &&
    releasePlan.fingerprint === aggregate.fingerprint
  ) {
    console.log(relative(ROOT, planPath));
    return;
  }
  const revision = nextIterationRevision(iterationJson, iteration);
  iterationJson.release_plan = {
    status: "draft",
    fingerprint: aggregate.fingerprint,
    generated_at: now(),
    generation: (Number(releasePlan?.generation) || 0) + 1,
    revision,
  };
  writeJson(iterationPath, iterationJson);
  console.log(relative(ROOT, planPath));
}

export function confirmReleasePlan(reference, options) {
  if (!options.confirmed) {
    throw new Error("确认发布方案需要 --confirmed");
  }
  const iteration = resolveIteration(reference);
  if (!options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      confirmReleasePlan(reference, { ...options, __iterationLocked: true }),
    );
  }
  const iterationPath = join(iteration, "iteration.json");
  const iterationJson = parseIterationData(readJson(iterationPath), iteration);
  assertOpenIteration(iterationJson, "确认发布方案");
  const aggregate = aggregateRelease(iteration);
  const planPath = join(iteration, "release-plan.md");
  if (aggregate.unfinished.length) {
    throw new Error("仍有未完成任务，发布方案只能保持 draft");
  }
  if (aggregate.integrity_errors.length) {
    throw new Error("发布来源不完整: " + aggregate.integrity_errors.join("；"));
  }
  if (
    !iterationJson.release_plan ||
    iterationJson.release_plan.fingerprint !== aggregate.fingerprint
  ) {
    if (iterationJson.release_plan) {
      invalidateReleasePlan(
        iterationJson,
        iteration,
        aggregate,
        "release_sources_changed",
      );
    }
    throw new Error("发布来源已变化，请重新生成并审阅方案");
  }
  if (!existsSync(planPath)) {
    throw new Error("缺少 release-plan.md");
  }
  const plan = readText(planPath);
  if (/待补充|待核对|待确认/.test(plan)) {
    throw new Error("发布方案仍有待补充、待核对或待确认内容");
  }
  if (!plan.includes("来源指纹：" + aggregate.fingerprint)) {
    throw new Error("发布方案中的来源指纹与当前来源不一致");
  }
  const commitErrors = validateReleaseCommitReferences(aggregate);
  if (commitErrors.length) {
    throw new Error("发布 commit 校验失败: " + commitErrors.join("；"));
  }
  const planHash = fileHash(planPath);
  if (
    iterationJson.release_plan.status === "confirmed" &&
    iterationJson.release_plan.plan_hash === planHash &&
    iterationJson.release_plan.confirmation_revision === iterationJson.revision
  ) {
    console.log("confirmed");
    return;
  }
  const revision = nextIterationRevision(iterationJson, iteration);
  const references = collectReleaseCommitReferences(aggregate);
  iterationJson.release_plan = {
    ...iterationJson.release_plan,
    status: "confirmed",
    plan_hash: planHash,
    confirmed_at: now(),
    confirmation_revision: revision,
    confirmation_receipt: {
      schema_version: 1,
      fingerprint: aggregate.fingerprint,
      plan_hash: planHash,
      iteration_revision: revision,
      task_revisions: Object.fromEntries(
        aggregate.done.map((task) => [task.id, task.revision]),
      ),
      commits: references.map(({ repo_id, sha }) => ({ repo_id, sha })),
    },
  };
  writeJson(iterationPath, iterationJson);
  console.log("confirmed");
}
