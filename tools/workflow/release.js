import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
  ROOT,
  fileHash,
  fingerprint,
  optionList,
  readJson,
  readText,
  resolveIteration,
  writeJson,
  writeText,
} from "./common.js";

export function addChange(options) {
  const iteration = resolveIteration(String(options.iteration || ""));
  const iterationJson = readJson(join(iteration, "iteration.json"));
  if (iterationJson.status !== "open") {
    throw new Error("只能向开放迭代追加简单变更");
  }
  if (!options.summary || !options.verification) {
    throw new Error("change add 需要 --summary、--verification 和至少一个 --commit repo=sha");
  }
  const commits = {};
  for (const item of optionList(options.commit)) {
    const at = item.indexOf("=");
    if (at < 1 || at === item.length - 1) {
      throw new Error("--commit 格式必须是 repo=sha");
    }
    commits[item.slice(0, at)] = item.slice(at + 1);
  }
  if (!Object.keys(commits).length) {
    throw new Error("至少需要一个 commit");
  }
  const item = {
    summary: String(options.summary),
    commits,
    verification: String(options.verification),
    project_docs: optionList(options["project-docs"]),
  };
  appendFileSync(join(iteration, "changes.jsonl"), JSON.stringify(item) + "\n", "utf8");
  console.log(JSON.stringify(item, null, 2));
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
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("changes.jsonl 第 " + (index + 1) + " 行不是有效 JSON");
      }
    });
}

export function aggregateRelease(iterationDirectory) {
  const iteration = readJson(join(iterationDirectory, "iteration.json"));
  const tasks = [];
  for (const entry of readdirSync(iterationDirectory, { withFileTypes: true })) {
    const taskPath = join(iterationDirectory, entry.name, "task.json");
    if (!entry.isDirectory() || !existsSync(taskPath)) {
      continue;
    }
    const task = readJson(taskPath);
    tasks.push({
      id: entry.name,
      title: task.title,
      phase: task.phase,
      repositories: task.repositories || [],
      verification_hash: fileHash(join(iterationDirectory, entry.name, "verification.md")),
    });
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  const changes = readChanges(iterationDirectory);
  const sources = { tasks, changes };
  return {
    iteration,
    done: tasks.filter((task) => task.phase === "done"),
    cancelled: tasks.filter((task) => task.phase === "cancelled"),
    unfinished: tasks.filter(
      (task) => task.phase !== "done" && task.phase !== "cancelled",
    ),
    changes,
    fingerprint: fingerprint(sources),
  };
}

function releasePlanMarkdown(aggregate) {
  const taskLines = aggregate.done.length
    ? aggregate.done.map((task) => "- " + task.id + ": " + task.title)
    : ["- 无"];
  const changeLines = aggregate.changes.length
    ? aggregate.changes.map((change) => "- " + change.summary)
    : ["- 无"];
  const blockers = aggregate.unfinished.length
    ? aggregate.unfinished.map(
        (task) => "- " + task.id + " (" + task.phase + ")",
      )
    : ["- 无"];
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
    "待补充。",
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
    ...blockers,
    "",
  ].join("\n");
}

export function writeReleasePlan(reference, options) {
  const iteration = resolveIteration(reference);
  const aggregate = aggregateRelease(iteration);
  const markdown = releasePlanMarkdown(aggregate);
  if (!options.apply) {
    console.log(markdown);
    console.log("确认写入后添加 --apply。");
    return;
  }
  const planPath = join(iteration, "release-plan.md");
  if (!existsSync(planPath)) {
    writeText(planPath, markdown);
  } else {
    console.log("release-plan.md 已存在，保留现有内容；请按本次预览手动同步。");
  }
  const iterationJson = readJson(join(iteration, "iteration.json"));
  iterationJson.release_plan = {
    status: "draft",
    fingerprint: aggregate.fingerprint,
  };
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log(relative(ROOT, planPath));
}

export function confirmReleasePlan(reference, options) {
  if (!options.confirmed) {
    throw new Error("确认发布方案需要 --confirmed");
  }
  const iteration = resolveIteration(reference);
  const aggregate = aggregateRelease(iteration);
  const iterationJson = readJson(join(iteration, "iteration.json"));
  const planPath = join(iteration, "release-plan.md");
  if (aggregate.unfinished.length) {
    throw new Error("仍有未完成任务，发布方案只能保持 draft");
  }
  if (
    !iterationJson.release_plan ||
    iterationJson.release_plan.fingerprint !== aggregate.fingerprint
  ) {
    if (iterationJson.release_plan) {
      iterationJson.release_plan.status = "draft";
      iterationJson.release_plan.fingerprint = aggregate.fingerprint;
      delete iterationJson.release_plan.plan_hash;
      writeJson(join(iteration, "iteration.json"), iterationJson);
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
  iterationJson.release_plan.status = "confirmed";
  iterationJson.release_plan.plan_hash = fileHash(planPath);
  writeJson(join(iteration, "iteration.json"), iterationJson);
  console.log("confirmed");
}
