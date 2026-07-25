import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  PHASES,
  PHASE_FILES,
  captureRepositories,
  iterationLockPath,
  listTaskDirectories,
  optionList,
  parseIterationData,
  parseTaskData,
  readJson,
  readLocalConfig,
  relativeWorkflowPath,
  resolveIteration,
  resolveTask,
  slugify,
  today,
  uniqueDirectory,
  withFileLocks,
  writeJson,
} from "./common.js";

function now() {
  return new Date().toISOString();
}

function readIteration(directory) {
  return parseIterationData(readJson(join(directory, "iteration.json")));
}

function readTask(directory) {
  return parseTaskData(readJson(join(directory, "task.json")));
}

function assertOpenIteration(directory) {
  if (readIteration(directory).status !== "open") {
    throw new Error("任务操作只允许用于开放迭代");
  }
}

function assertRepositories(ids) {
  const config = readLocalConfig();
  if (!config) throw new Error("缺少 setup 配置，请先执行 setup");
  const known = new Set(config.repositories.map((repository) => repository.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error("未登记仓库: " + unknown.join(", "));
  if (new Set(ids).size !== ids.length) throw new Error("仓库 ID 不能重复");
}

export function createTask(options) {
  const title = String(options.title || "").trim();
  if (!options.iteration || !title) {
    throw new Error("task iteration 和 title 不能为空");
  }
  const iteration = resolveIteration(String(options.iteration));
  const repositories = optionList(options.repositories);
  assertRepositories(repositories);
  return withFileLocks([iterationLockPath(iteration)], () => {
    assertOpenIteration(iteration);
    const id = uniqueDirectory(
      iteration,
      today() + "-" + slugify(options.slug || title, "task"),
    );
    const directory = join(iteration, id);
    mkdirSync(directory);
    const task = {
      title,
      phase: "prd",
      repositories,
      created_at: now(),
      cancelled_from: null,
      git: { baseline: null, final: null },
    };
    writeJson(join(directory, "task.json"), task);
    return taskStatus(directory);
  });
}

export function taskStatus(reference) {
  const directory = resolveTask(reference);
  const task = readTask(directory);
  const iteration = dirname(directory);
  const artifact = PHASE_FILES[task.phase] || null;
  const phaseIndex = PHASES.indexOf(task.phase);
  return {
    id: basename(directory),
    path: relativeWorkflowPath(directory),
    iteration: basename(iteration),
    iteration_status: readIteration(iteration).status,
    ...task,
    artifact: artifact
      ? {
          path: relativeWorkflowPath(join(directory, artifact)),
          exists: existsSync(join(directory, artifact)),
        }
      : null,
    next_phase: phaseIndex >= 0 && phaseIndex < PHASES.length - 1
      ? PHASES[phaseIndex + 1]
      : null,
  };
}

export function listTasks(options = {}) {
  let directories;
  if (options.iteration) {
    const iteration = resolveIteration(String(options.iteration));
    if (readIteration(iteration).status !== "open") return [];
    directories = readdirSync(iteration, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(iteration, entry.name, "task.json")))
      .map((entry) => join(iteration, entry.name));
  } else {
    directories = listTaskDirectories().filter(
      (directory) => readIteration(dirname(directory)).status === "open",
    );
  }
  return directories.sort()
    .map((directory) => taskStatus(directory))
    .filter((task) => !["done", "cancelled"].includes(task.phase));
}

export function transitionTask(reference, targetPhase, options) {
  if (!options.confirmed) throw new Error("推进任务阶段需要用户确认和 --confirmed");
  const directory = resolveTask(reference);
  const iteration = dirname(directory);
  return withFileLocks([iterationLockPath(iteration)], () => {
    assertOpenIteration(iteration);
    const task = readTask(directory);
    const currentIndex = PHASES.indexOf(task.phase);
    if (currentIndex < 0 || currentIndex === PHASES.length - 1) {
      throw new Error("终态任务不能通过 task phase 推进");
    }
    const expected = PHASES[currentIndex + 1];
    if (targetPhase !== expected) {
      throw new Error(`只能从 ${task.phase} 推进到 ${expected}`);
    }
    const artifact = PHASE_FILES[task.phase];
    if (artifact && !existsSync(join(directory, artifact))) {
      throw new Error("缺少当前阶段产物: " + artifact);
    }
    if (targetPhase === "implementation") {
      task.git.baseline = captureRepositories(task.repositories, false);
    }
    if (targetPhase === "done") {
      task.git.final = captureRepositories(
        task.repositories,
        true,
        undefined,
        new Map(task.git.baseline.map((repository) => [repository.id, repository.root])),
      );
    }
    task.phase = targetPhase;
    writeJson(join(directory, "task.json"), task);
    return taskStatus(directory);
  });
}

export function cancelTask(reference, options) {
  if (!options.confirmed) throw new Error("取消任务需要 --confirmed");
  const directory = resolveTask(reference);
  const iteration = dirname(directory);
  return withFileLocks([iterationLockPath(iteration)], () => {
    assertOpenIteration(iteration);
    const task = readTask(directory);
    if (["done", "cancelled"].includes(task.phase)) throw new Error("任务已经是终态");
    task.cancelled_from = task.phase;
    task.phase = "cancelled";
    writeJson(join(directory, "task.json"), task);
    return taskStatus(directory);
  });
}

export function reopenTask(reference, options) {
  if (!options.confirmed) throw new Error("重开任务需要 --confirmed");
  const directory = resolveTask(reference);
  const iteration = dirname(directory);
  return withFileLocks([iterationLockPath(iteration)], () => {
    assertOpenIteration(iteration);
    const task = readTask(directory);
    if (task.phase === "cancelled") {
      task.phase = task.cancelled_from;
      task.cancelled_from = null;
    } else if (task.phase === "done") {
      task.phase = "verification";
      task.git.final = null;
    } else {
      throw new Error("只有 done 或 cancelled 任务可以重开");
    }
    writeJson(join(directory, "task.json"), task);
    return taskStatus(directory);
  });
}

export function moveTask(reference, options) {
  if (!options.iteration) throw new Error("task move 需要 --iteration");
  const source = resolveTask(reference);
  const sourceIteration = dirname(source);
  const targetIteration = resolveIteration(String(options.iteration));
  if (sourceIteration === targetIteration) throw new Error("任务已在目标迭代中");
  return withFileLocks(
    [iterationLockPath(sourceIteration), iterationLockPath(targetIteration)],
    () => {
      assertOpenIteration(sourceIteration);
      assertOpenIteration(targetIteration);
      const task = readTask(source);
      if (["done", "cancelled"].includes(task.phase)) throw new Error("终态任务不能移动");
      const target = join(targetIteration, basename(source));
      if (existsSync(target)) throw new Error("目标迭代中已存在同名任务");
      renameSync(source, target);
      return taskStatus(target);
    },
  );
}
