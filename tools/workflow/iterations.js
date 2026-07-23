import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import {
  ITERATIONS_DIR,
  ROOT,
  ensureWithin,
  fileHash,
  fingerprint,
  iterationLockPath,
  pathHasCommit,
  readJson,
  resolveIteration,
  slugify,
  today,
  uniqueDirectory,
  withFileLocks,
  writeJson,
} from "./common.js";
import {
  aggregateRelease,
  validateReleaseCommitReferences,
} from "./release.js";

function now() {
  return new Date().toISOString();
}

function assertOpenIteration(iteration, action) {
  if (iteration.status !== "open") {
    throw new Error(action + "只允许用于开放迭代；done/cancelled 是不可变终态");
  }
}

function nextIterationRevision(iteration, directory) {
  const id = directory.split(/[\\/]/).at(-1);
  if (
    iteration.schema_version !== 2 ||
    iteration.id !== id ||
    !Number.isInteger(iteration.revision) ||
    iteration.revision < 0
  ) {
    throw new Error("iteration.json 格式不受支持");
  }
  iteration.revision += 1;
  iteration.updated_at = now();
  return iteration.revision;
}

export function createIteration(options) {
  if (!options.title || !options.goal) {
    throw new Error("iteration create 需要 --title 和 --goal");
  }
  mkdirSync(ITERATIONS_DIR, { recursive: true });
  if (!options.__iterationsLocked) {
    return withFileLocks([join(ITERATIONS_DIR, ".iterations.lock")], () =>
      createIteration({ ...options, __iterationsLocked: true }),
    );
  }
  const baseId = today() + "-" + slugify(options.slug || options.title, "iteration");
  const id = uniqueDirectory(ITERATIONS_DIR, baseId);
  const directory = join(ITERATIONS_DIR, id);
  mkdirSync(directory);
  writeJson(join(directory, "iteration.json"), {
    schema_version: 2,
    id,
    revision: 0,
    title: String(options.title),
    goal: String(options.goal),
    status: "open",
    created_at: now(),
    target_version:
      options["target-version"] && options["target-version"] !== true
        ? String(options["target-version"])
        : null,
  });
  console.log(relative(ROOT, directory));
}

export function finishIteration(reference, options) {
  if (!options.confirmed) {
    throw new Error("标记迭代完成需要实际发布确认和 --confirmed");
  }
  const iteration = resolveIteration(reference);
  if (!options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      finishIteration(reference, { ...options, __iterationLocked: true }),
    );
  }
  const iterationJson = readJson(join(iteration, "iteration.json"));
  assertOpenIteration(iterationJson, "完成迭代");
  const aggregate = aggregateRelease(iteration);
  if (aggregate.unfinished.length) {
    throw new Error("迭代仍有未完成任务");
  }
  if (aggregate.integrity_errors.length) {
    throw new Error("迭代交付记录不完整: " + aggregate.integrity_errors.join("；"));
  }
  const commitErrors = validateReleaseCommitReferences(aggregate);
  if (commitErrors.length) {
    throw new Error("发布 commit 校验失败: " + commitErrors.join("；"));
  }
  const planHash = fileHash(join(iteration, "release-plan.md"));
  if (
    iterationJson.release_plan?.status !== "confirmed" ||
    iterationJson.release_plan.fingerprint !== aggregate.fingerprint ||
    iterationJson.release_plan.plan_hash !== planHash ||
    iterationJson.release_plan.confirmation_revision !== iterationJson.revision ||
    iterationJson.release_plan.confirmation_receipt?.fingerprint !==
      aggregate.fingerprint ||
    iterationJson.release_plan.confirmation_receipt?.plan_hash !== planHash ||
    iterationJson.release_plan.confirmation_receipt?.iteration_revision !==
      iterationJson.revision
  ) {
    throw new Error("发布方案未确认、确认回执已失效或方案内容已变化");
  }
  const confirmationRevision = iterationJson.revision;
  const revision = nextIterationRevision(iterationJson, iteration);
  iterationJson.status = "done";
  iterationJson.closed_at = now();
  iterationJson.closure_receipt = {
    schema_version: 1,
    status: "done",
    revision,
    confirmation_revision: confirmationRevision,
    fingerprint: aggregate.fingerprint,
    plan_hash: planHash,
    closed_at: iterationJson.closed_at,
  };
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log("done");
}

export function cancelIteration(reference, options) {
  if (!options.confirmed || !options.reason || options.reason === true) {
    throw new Error("取消迭代需要 --reason 和 --confirmed");
  }
  const iteration = resolveIteration(reference);
  if (!options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      cancelIteration(reference, { ...options, __iterationLocked: true }),
    );
  }
  const iterationJson = readJson(join(iteration, "iteration.json"));
  assertOpenIteration(iterationJson, "取消迭代");
  const aggregate = aggregateRelease(iteration);
  if (aggregate.done.length || aggregate.unfinished.length || aggregate.changes.length) {
    throw new Error("包含未取消任务或简单变更的迭代不能直接取消；请先处理交付项");
  }
  const revision = nextIterationRevision(iterationJson, iteration);
  iterationJson.status = "cancelled";
  iterationJson.closure_reason = String(options.reason);
  iterationJson.closed_at = now();
  iterationJson.closure_receipt = {
    schema_version: 1,
    status: "cancelled",
    revision,
    reason_hash: fingerprint(iterationJson.closure_reason),
    closed_at: iterationJson.closed_at,
  };
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log("cancelled");
}

export function deleteIteration(reference, options) {
  const iteration = resolveIteration(reference);
  if (options.apply && !options.__iterationLocked) {
    return withFileLocks([iterationLockPath(iteration)], () =>
      deleteIteration(reference, { ...options, __iterationLocked: true }),
    );
  }
  const iterationJson = readJson(join(iteration, "iteration.json"));
  assertOpenIteration(iterationJson, "删除迭代");
  const extra = readdirSync(iteration).filter((name) => name !== "iteration.json");
  if (
    iterationJson.release_plan ||
    extra.length ||
    pathHasCommit(iteration)
  ) {
    throw new Error(
      "迭代不满足安全删除条件；只允许删除未提交、未生成发布方案且除 iteration.json 外为空的开放迭代",
    );
  }
  console.log((options.apply ? "删除: " : "将删除: ") + relative(ROOT, iteration));
  if (options.apply) {
    rmSync(ensureWithin(ITERATIONS_DIR, iteration), { recursive: true, force: false });
  } else {
    console.log("确认后添加 --apply。");
  }
}
