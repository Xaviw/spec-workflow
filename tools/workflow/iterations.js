import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import {
  ITERATIONS_DIR,
  ROOT,
  ensureWithin,
  fileHash,
  pathHasCommit,
  readJson,
  resolveIteration,
  slugify,
  today,
  uniqueDirectory,
  writeJson,
} from "./common.js";
import { aggregateRelease } from "./release.js";

export function createIteration(options) {
  if (!options.title || !options.goal) {
    throw new Error("iteration create 需要 --title 和 --goal");
  }
  mkdirSync(ITERATIONS_DIR, { recursive: true });
  const baseId = today() + "-" + slugify(options.slug || options.title, "iteration");
  const id = uniqueDirectory(ITERATIONS_DIR, baseId);
  const directory = join(ITERATIONS_DIR, id);
  mkdirSync(directory);
  writeJson(join(directory, "iteration.json"), {
    title: String(options.title),
    goal: String(options.goal),
    status: "open",
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
  const aggregate = aggregateRelease(iteration);
  const iterationJson = readJson(join(iteration, "iteration.json"));
  if (aggregate.unfinished.length) {
    throw new Error("迭代仍有未完成任务");
  }
  if (
    iterationJson.release_plan?.status !== "confirmed" ||
    iterationJson.release_plan.fingerprint !== aggregate.fingerprint ||
    iterationJson.release_plan.plan_hash !==
      fileHash(join(iteration, "release-plan.md"))
  ) {
    throw new Error("发布方案未确认、来源指纹已失效或方案内容已变化");
  }
  iterationJson.status = "done";
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log("done");
}

export function cancelIteration(reference, options) {
  if (!options.confirmed || !options.reason || options.reason === true) {
    throw new Error("取消迭代需要 --reason 和 --confirmed");
  }
  const iteration = resolveIteration(reference);
  const aggregate = aggregateRelease(iteration);
  if (aggregate.done.length || aggregate.unfinished.length) {
    throw new Error("包含任务的迭代不能直接取消；请先处理各任务");
  }
  const iterationJson = readJson(join(iteration, "iteration.json"));
  iterationJson.status = "cancelled";
  iterationJson.closure_reason = String(options.reason);
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log("cancelled");
}

export function deleteIteration(reference, options) {
  const iteration = resolveIteration(reference);
  const iterationJson = readJson(join(iteration, "iteration.json"));
  const extra = readdirSync(iteration).filter((name) => name !== "iteration.json");
  if (
    !["open", "cancelled"].includes(iterationJson.status) ||
    extra.length ||
    pathHasCommit(iteration)
  ) {
    throw new Error(
      "迭代不满足安全删除条件；只允许删除未提交且除 iteration.json 外为空的开放或已取消迭代",
    );
  }
  console.log((options.apply ? "删除: " : "将删除: ") + relative(ROOT, iteration));
  if (options.apply) {
    rmSync(ensureWithin(ITERATIONS_DIR, iteration), { recursive: true, force: false });
  } else {
    console.log("确认后添加 --apply。");
  }
}
