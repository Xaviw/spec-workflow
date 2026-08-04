import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  ITERATIONS_DIR,
  assertPortableWorkflowFiles,
  captureRepositories,
  optionList,
  parseIterationData,
  parseTaskData,
  readJson,
  readText,
  relativeWorkflowPath,
  resolveIteration,
  slugify,
  today,
  uniqueDirectory,
  writeJson,
} from "./common.js";

const RELEASE_PLAN_MARKER = /^<!-- spec-workflow:release-plan ended_at=([^\s]+) -->(?:\r?\n|$)/;

function now() {
  return new Date().toISOString();
}

function readIteration(directory) {
  return parseIterationData(readJson(join(directory, "iteration.json")));
}

function assertOpen(iteration, action) {
  if (iteration.status !== "open") throw new Error(action + "只允许用于开放迭代");
}

function taskSummaries(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "task.json")))
    .map((entry) => {
      const task = parseTaskData(readJson(join(directory, entry.name, "task.json")));
      return {
        id: entry.name,
        path: relativeWorkflowPath(join(directory, entry.name)),
        title: task.title,
        phase: task.phase,
        repositories: task.repositories,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function releasePlanStatus(directory, iteration) {
  const path = join(directory, "release-plan.md");
  if (!existsSync(path)) {
    return { status: "missing", path: relativeWorkflowPath(path) };
  }
  const sourceEndedAt = readText(path).match(RELEASE_PLAN_MARKER)?.[1];
  return {
    status: iteration.status === "closed" && sourceEndedAt === iteration.ended_at ? "fresh" : "stale",
    path: relativeWorkflowPath(path),
  };
}

export function createIteration(options) {
  const title = String(options.title || "").trim();
  if (!title) throw new Error("iteration title 不能为空");
  mkdirSync(ITERATIONS_DIR, { recursive: true });
  const id = uniqueDirectory(
    ITERATIONS_DIR,
    today() + "-" + slugify(options.slug || title, "iteration"),
  );
  const directory = join(ITERATIONS_DIR, id);
  mkdirSync(directory);
  const iteration = {
    title,
    status: "open",
    created_at: now(),
    ended_at: null,
    simple_changes: [],
  };
  writeJson(join(directory, "iteration.json"), iteration);
  return { id, path: relativeWorkflowPath(directory), ...iteration };
}

export function listIterations(options = {}) {
  if (options.status && !["open", "closed", "cancelled"].includes(String(options.status))) {
    throw new Error("--status 必须是 open、closed 或 cancelled");
  }
  if (!existsSync(ITERATIONS_DIR)) return [];
  return readdirSync(ITERATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ITERATIONS_DIR, entry.name, "iteration.json")))
    .map((entry) => ({
      id: entry.name,
      path: relativeWorkflowPath(join(ITERATIONS_DIR, entry.name)),
      ...readIteration(join(ITERATIONS_DIR, entry.name)),
    }))
    .filter((iteration) => !options.status || iteration.status === options.status)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function iterationStatus(reference, options = {}) {
  const directory = resolveIteration(reference);
  if (options.check) assertPortableWorkflowFiles(directory);
  const iteration = readIteration(directory);
  const tasks = taskSummaries(directory);
  const result = {
    id: basename(directory),
    path: relativeWorkflowPath(directory),
    ...iteration,
    tasks,
    counts: Object.fromEntries(
      ["prd", "technical_design", "implementation_spec", "implementation", "verification", "done", "cancelled"]
        .map((phase) => [phase, tasks.filter((task) => task.phase === phase).length]),
    ),
    release_plan: releasePlanStatus(directory, iteration),
  };
  if (options.check) result.checks = { portable_files: "pass" };
  return result;
}

export function closeIteration(reference, options) {
  if (!options.confirmed) throw new Error("收口迭代需要用户确认和 --confirmed");
  const directory = resolveIteration(reference);
  const iteration = readIteration(directory);
  assertOpen(iteration, "收口迭代");
  const unfinished = taskSummaries(directory).filter(
    (task) => !["done", "cancelled"].includes(task.phase),
  );
  if (unfinished.length) throw new Error("迭代仍有未完成任务");
  assertPortableWorkflowFiles(directory);
  iteration.status = "closed";
  iteration.ended_at = now();
  writeJson(join(directory, "iteration.json"), iteration);
  return iterationStatus(directory);
}

export function cancelIteration(reference, options) {
  if (!options.confirmed) throw new Error("取消迭代需要 --confirmed");
  const directory = resolveIteration(reference);
  const iteration = readIteration(directory);
  assertOpen(iteration, "取消迭代");
  const tasks = taskSummaries(directory);
  if (tasks.some((task) => task.phase !== "cancelled") || iteration.simple_changes.length) {
    throw new Error("取消迭代前必须取消全部任务，且迭代不能包含 simple change");
  }
  iteration.status = "cancelled";
  iteration.ended_at = now();
  writeJson(join(directory, "iteration.json"), iteration);
  return iterationStatus(directory);
}

export function addSimpleChange(options) {
  const summary = String(options.summary || "").trim();
  if (!options.iteration || !summary) {
    throw new Error("simple-change iteration 和 summary 不能为空");
  }
  const repositories = optionList(options.repositories);
  if (new Set(repositories).size !== repositories.length) throw new Error("仓库 ID 不能重复");
  const directory = resolveIteration(String(options.iteration));
  const iteration = readIteration(directory);
  assertOpen(iteration, "登记 simple change");
  const change = {
    summary,
    repositories,
    git: captureRepositories(repositories, true),
    recorded_at: now(),
  };
  iteration.simple_changes.push(change);
  writeJson(join(directory, "iteration.json"), iteration);
  return change;
}
