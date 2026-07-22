import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  ITERATIONS_DIR,
  PHASES,
  ROOT,
  TASK_TYPES,
  ensureWithin,
  isGitRepository,
  listTaskDirectories,
  optionList,
  pathHasCommit,
  readJson,
  resolveIteration,
  resolveTask,
  runGit,
  slugify,
  today,
  uniqueDirectory,
  writeJson,
  writeText,
} from "./common.js";

export function canTransition(from, to, reason = "") {
  if (from === "cancelled" || to === "cancelled") {
    return false;
  }
  const fromIndex = PHASES.indexOf(from);
  const toIndex = PHASES.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || from === to) {
    return false;
  }
  if (toIndex === fromIndex + 1) {
    return true;
  }
  return toIndex < fromIndex && Boolean(String(reason).trim());
}

function phaseTemplate(phase, title) {
  if (phase === "technical_design") {
    return "# 技术方案\n\n## 目标与非目标\n\n## 当前实现与证据\n\n## 总体设计\n\n## 数据模型与 DDL\n\n## API 与调用方\n\n## 后端实现\n\n## Web/小程序实现\n\n## 权限与安全\n\n## 配置、环境与联调\n\n## 可观测性\n\n## 跨仓库依赖与顺序\n\n## 迁移、发布与回滚\n\n## 测试和验证策略\n\n## 风险与未决问题\n";
  }
  if (phase === "implementation_spec") {
    return "# 实施方案\n\n## 本轮实施基线\n\n## 实施顺序与依赖\n\n## 按仓库的修改计划\n\n## 数据库与配置动作\n\n## 验收标准到验证的映射\n\n## 测试与联调\n\n## 项目文档同步\n\n## Slices\n\n## 风险和停止条件\n";
  }
  if (phase === "verification") {
    return "# 验证记录\n\n## 验收项与证据\n\n## 仓库检查\n\n## 集成验证\n\n## 数据库验证\n\n## UI 证据\n\n## 项目文档同步\n\n## 提交范围\n\n## 未验证项与残余风险\n";
  }
  return "# " + title + "\n";
}

export function createTask(options) {
  const iteration = resolveIteration(String(options.iteration || ""));
  const iterationJson = readJson(join(iteration, "iteration.json"));
  if (iterationJson.status !== "open") {
    throw new Error("只能在开放迭代中创建任务");
  }
  if (!options.title || !options.summary) {
    throw new Error("task create 需要 --iteration、--title 和 --summary");
  }
  const type = String(options.type || "feature");
  if (!TASK_TYPES.includes(type)) {
    throw new Error("任务类型必须是: " + TASK_TYPES.join(", "));
  }
  const baseId = today() + "-" + slugify(options.slug || options.title, "task");
  const id = uniqueDirectory(iteration, baseId);
  const directory = join(iteration, id);
  mkdirSync(directory);
  writeJson(join(directory, "task.json"), {
    title: String(options.title),
    summary: String(options.summary),
    type,
    phase: "prd",
    repositories: optionList(options.repositories),
    modules: optionList(options.modules),
    related_tasks: optionList(options.related),
    slices: [],
  });
  writeText(
    join(directory, "prd.md"),
    "# " +
      options.title +
      "\n\n## 背景与原始需求\n\n" +
      options.summary +
      "\n\n## 目标\n\n## 非目标\n\n## 用户与场景\n\n## 范围和业务规则\n\n## 异常与边界\n\n## 验收标准\n\n## 约束与依赖\n\n## 未决问题\n",
  );
  writeText(join(directory, "decisions.md"), "# 决策记录\n");
  console.log(relative(ROOT, directory));
}

export function transitionTask(reference, phase, options) {
  const directory = resolveTask(reference);
  const path = join(directory, "task.json");
  const task = readJson(path);
  const reason = options.reason === true ? "" : String(options.reason || "");
  if (!canTransition(task.phase, phase, reason)) {
    throw new Error("非法阶段转换: " + task.phase + " -> " + phase);
  }
  if (PHASES.indexOf(phase) > PHASES.indexOf(task.phase) && !options.confirmed) {
    throw new Error("向前推进阶段需要用户明确确认，并添加 --confirmed");
  }
  const parent = dirname(directory);
  if (task.phase === "done" && phase !== "done") {
    const iteration = readJson(join(parent, "iteration.json"));
    if (iteration.status !== "open") {
      throw new Error("已结束迭代中的任务不能重开；请在新迭代创建关联任务");
    }
  }
  task.phase = phase;
  writeJson(path, task);
  const files = {
    technical_design: "technical-design.md",
    implementation_spec: "spec.md",
    verification: "verification.md",
  };
  if (files[phase]) {
    const document = join(directory, files[phase]);
    if (!existsSync(document)) {
      writeText(document, phaseTemplate(phase, task.title));
    }
  }
  console.log(task.phase);
}

export function cancelTask(reference, options) {
  if (!options.confirmed || !options.reason || options.reason === true) {
    throw new Error("取消任务需要 --reason 和 --confirmed");
  }
  const directory = resolveTask(reference);
  const taskPath = join(directory, "task.json");
  const task = readJson(taskPath);
  if (task.phase === "done" || task.phase === "cancelled") {
    throw new Error("任务已处于终态");
  }
  task.phase = "cancelled";
  task.closure_reason = String(options.reason);
  writeJson(taskPath, task);
  console.log("cancelled");
}

function taskReferences(taskDirectory) {
  const id = basename(taskDirectory);
  const rel = relative(ROOT, taskDirectory).replaceAll("\\", "/");
  return listTaskDirectories().filter((directory) => {
    if (directory === taskDirectory) {
      return false;
    }
    const related = readJson(join(directory, "task.json")).related_tasks || [];
    return related.includes(id) || related.includes(rel);
  });
}

function taskHasCommit(taskDirectory) {
  return pathHasCommit(taskDirectory);
}

export function deleteTask(reference, options) {
  const directory = resolveTask(reference);
  const task = readJson(join(directory, "task.json"));
  const allowedFiles = new Set(["task.json", "prd.md", "decisions.md"]);
  const extra = readdirSync(directory).filter((name) => !allowedFiles.has(name));
  const references = taskReferences(directory);
  if (
    task.phase !== "prd" ||
    taskHasCommit(directory) ||
    references.length ||
    extra.length
  ) {
    throw new Error(
      "任务不满足安全删除条件；请改为标记 cancelled。条件：未提交、仍在 prd、无引用、无实施产物",
    );
  }
  console.log((options.apply ? "删除: " : "将删除: ") + relative(ROOT, directory));
  if (options.apply) {
    rmSync(ensureWithin(ITERATIONS_DIR, directory), { recursive: true, force: false });
  } else {
    console.log("确认后添加 --apply。");
  }
}

export function moveTask(reference, options) {
  const source = resolveTask(reference);
  const destinationIteration = resolveIteration(String(options.iteration || ""));
  const task = readJson(join(source, "task.json"));
  const sourceIteration = readJson(join(dirname(source), "iteration.json"));
  const destination = join(destinationIteration, basename(source));
  const destinationJson = readJson(join(destinationIteration, "iteration.json"));
  if (task.phase === "done" || task.phase === "cancelled") {
    throw new Error("终态任务不能移动");
  }
  if (sourceIteration.status !== "open" || destinationJson.status !== "open") {
    throw new Error("任务只能在开放迭代之间移动");
  }
  if (existsSync(destination)) {
    throw new Error("目标任务目录已存在");
  }
  ensureWithin(ITERATIONS_DIR, source);
  ensureWithin(ITERATIONS_DIR, destination);
  console.log(
    (options.apply ? "移动: " : "将移动: ") +
      relative(ROOT, source) +
      " -> " +
      relative(ROOT, destination),
  );
  if (!options.apply) {
    console.log("确认后添加 --apply。");
    return;
  }
  const tracked = taskHasCommit(source);
  if (tracked && isGitRepository(ROOT)) {
    runGit(["mv", relative(ROOT, source), relative(ROOT, destination)], ROOT);
  } else {
    renameSync(source, destination);
  }
}

function uncommittedTaskPaths() {
  if (!isGitRepository(ROOT)) {
    return new Set(listTaskDirectories().map((path) => resolve(path)));
  }
  const status = runGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
      "--",
      "iterations",
    ],
    ROOT,
    true,
    true,
  );
  const paths = new Set();
  for (const line of status.split("\0").filter(Boolean)) {
    const raw = line.slice(3).replaceAll("\\", "/");
    const parts = raw.split("/");
    if (parts[0] === "iterations" && parts.length >= 3) {
      const candidate = join(ROOT, parts[0], parts[1], parts[2]);
      if (existsSync(join(candidate, "task.json"))) {
        paths.add(resolve(candidate));
      }
    }
  }
  return paths;
}

function gitTaskMetadata(directory) {
  if (!isGitRepository(ROOT)) {
    return { updatedAt: null, authorEmail: null };
  }
  const rel = relative(ROOT, directory);
  const updatedAt = runGit(["log", "-1", "--format=%cI", "--", rel], ROOT, true);
  const authors = runGit(
    [
      "log",
      "--diff-filter=A",
      "--follow",
      "--format=%ae",
      "--",
      join(rel, "task.json"),
    ],
    ROOT,
    true,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    updatedAt: updatedAt || null,
    authorEmail: authors.at(-1) || null,
  };
}

export function taskCandidates() {
  const local = uncommittedTaskPaths();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const directory of listTaskDirectories()) {
    const iteration = readJson(join(dirname(directory), "iteration.json"));
    const task = readJson(join(directory, "task.json"));
    if (iteration.status !== "open" || task.phase === "cancelled") {
      continue;
    }
    const metadata = gitTaskMetadata(directory);
    const source = local.has(resolve(directory)) ? "local" : "git";
    if (
      source !== "local" &&
      (!metadata.updatedAt || new Date(metadata.updatedAt).getTime() < cutoff)
    ) {
      continue;
    }
    candidates.push({
      path: relative(ROOT, directory).replaceAll("\\", "/"),
      title: task.title,
      summary: task.summary,
      phase: task.phase,
      repositories: task.repositories || [],
      modules: task.modules || [],
      source,
      ...metadata,
    });
  }
  return candidates.sort(
    (left, right) =>
      Number(right.source === "local") - Number(left.source === "local") ||
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) ||
      left.path.localeCompare(right.path),
  );
}
