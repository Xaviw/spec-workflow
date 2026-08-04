import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  PHASE_FILES,
  assertPortableWorkflowFiles,
  assertPortableWorkflowText,
  bindTaskRepositories,
  captureRepositories,
  listTaskDirectories,
  optionList,
  parseIterationData,
  parseTaskData,
  readJson,
  readLocalConfig,
  readText,
  relativeWorkflowPath,
  resolveIteration,
  resolveTask,
  slugify,
  taskRepositoryBindings,
  today,
  uniqueDirectory,
  writeJson,
} from "./common.js";

const ARTIFACTS_BY_PHASE = {
  technical_design: ["prd.md"],
  implementation_spec: ["prd.md"],
  implementation: ["prd.md", "spec.md"],
  verification: ["prd.md", "spec.md"],
  done: ["prd.md", "spec.md", "verification.md"],
};

const NEXT_PHASES = {
  prd: ["technical_design", "implementation_spec"],
  technical_design: ["implementation_spec"],
  implementation_spec: ["implementation"],
  implementation: ["verification"],
  verification: ["done"],
};

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

function acceptanceIds(text) {
  return [...new Set(text.match(/\bAC-\d{3}\b/g) || [])].sort();
}

function assertTaskArtifacts(directory, targetPhase) {
  if (!existsSync(join(directory, "decisions.md"))) {
    throw new Error("缺少当前阶段产物: decisions.md");
  }
  const files = ARTIFACTS_BY_PHASE[targetPhase] || [];
  const entries = files.map((file) => {
    const text = readText(join(directory, file));
    assertPortableWorkflowText(text, file);
    return { file, ids: acceptanceIds(text) };
  });
  const expected = entries[0]?.ids || [];
  if (!expected.length) throw new Error("prd.md 缺少稳定 AC ID");
  for (const entry of entries.slice(1)) {
    if (entry.ids.join("\0") !== expected.join("\0")) {
      throw new Error(`${entry.file} 的 AC ID 与 prd.md 不一致`);
    }
  }
  if (existsSync(join(directory, "decisions.md"))) {
    assertPortableWorkflowText(readText(join(directory, "decisions.md")), "decisions.md");
  }
  if (existsSync(join(directory, "technical-design.md"))) {
    assertPortableWorkflowText(readText(join(directory, "technical-design.md")), "technical-design.md");
  }
  const slices = join(directory, "slices");
  if (existsSync(slices)) assertPortableWorkflowFiles(slices);
}

export function createTask(options) {
  const title = String(options.title || "").trim();
  if (!options.iteration || !title) {
    throw new Error("task iteration 和 title 不能为空");
  }
  const iteration = resolveIteration(String(options.iteration));
  const repositories = optionList(options.repositories);
  assertRepositories(repositories);
  assertOpenIteration(iteration);
  const id = uniqueDirectory(
    iteration,
    today() + "-" + slugify(options.slug || title, "task"),
  );
  const directory = join(iteration, id);
  mkdirSync(directory);
  const task = {
    title,
    binding_id: randomUUID(),
    phase: "prd",
    repositories,
    created_at: now(),
    cancelled_from: null,
    git: { baseline: null, final: null },
  };
  writeJson(join(directory, "task.json"), task);
  return taskStatus(directory);
}

export function taskStatus(reference) {
  const directory = resolveTask(reference);
  const task = readTask(directory);
  const iteration = dirname(directory);
  const artifact = PHASE_FILES[task.phase] || null;
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
    next_phases: NEXT_PHASES[task.phase] || [],
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
  assertOpenIteration(iteration);
  const task = readTask(directory);
  const allowed = NEXT_PHASES[task.phase];
  if (!allowed) {
    throw new Error("终态任务不能通过 task phase 推进");
  }
  if (!allowed.includes(targetPhase)) {
    throw new Error(`只能从 ${task.phase} 推进到 ${allowed.join(" 或 ")}`);
  }
  const artifact = PHASE_FILES[task.phase];
  if (artifact && !existsSync(join(directory, artifact))) {
    throw new Error("缺少当前阶段产物: " + artifact);
  }
  assertTaskArtifacts(directory, targetPhase);
  if (targetPhase === "implementation") {
    const baseline = captureRepositories(task.repositories, false);
    bindTaskRepositories(task.binding_id, task.repositories);
    task.git.baseline = baseline;
  }
  if (targetPhase === "done") {
    const bindings = taskRepositoryBindings(task.binding_id, task.repositories);
    task.git.final = captureRepositories(
      task.repositories,
      true,
      undefined,
      new Map(task.git.baseline.map((repository) => [
        repository.id,
        { ...repository, path: bindings.get(repository.id) },
      ])),
    );
  }
  task.phase = targetPhase;
  writeJson(join(directory, "task.json"), task);
  return taskStatus(directory);
}

export function cancelTask(reference, options) {
  if (!options.confirmed) throw new Error("取消任务需要 --confirmed");
  const directory = resolveTask(reference);
  const iteration = dirname(directory);
  assertOpenIteration(iteration);
  const task = readTask(directory);
  if (["done", "cancelled"].includes(task.phase)) throw new Error("任务已经是终态");
  task.cancelled_from = task.phase;
  task.phase = "cancelled";
  writeJson(join(directory, "task.json"), task);
  return taskStatus(directory);
}

export function reopenTask(reference, options) {
  if (!options.confirmed) throw new Error("重开任务需要 --confirmed");
  const directory = resolveTask(reference);
  const iteration = dirname(directory);
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
}

export function moveTask(reference, options) {
  if (!options.iteration) throw new Error("task move 需要 --iteration");
  const source = resolveTask(reference);
  const sourceIteration = dirname(source);
  const targetIteration = resolveIteration(String(options.iteration));
  if (sourceIteration === targetIteration) throw new Error("任务已在目标迭代中");
  assertOpenIteration(sourceIteration);
  assertOpenIteration(targetIteration);
  const task = readTask(source);
  if (["done", "cancelled"].includes(task.phase)) throw new Error("终态任务不能移动");
  const target = join(targetIteration, basename(source));
  if (existsSync(target)) throw new Error("目标迭代中已存在同名任务");
  renameSync(source, target);
  return taskStatus(target);
}
