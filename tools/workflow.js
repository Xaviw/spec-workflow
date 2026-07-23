#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  parseCliArgs,
  readJson,
  readLocalConfig,
  resolveIteration,
  resolveTask,
} from "./workflow/common.js";
import {
  ensureAdapterIgnored,
  installAdapter,
} from "./workflow/adapter.js";
import { buildContextPaths } from "./workflow/context.js";
import { printDoctor, runDoctor } from "./workflow/doctor.js";
import {
  cancelIteration,
  createIteration,
  deleteIteration,
  finishIteration,
} from "./workflow/iterations.js";
import {
  addChange,
  confirmReleasePlan,
  writeReleasePlan,
} from "./workflow/release.js";
import { runSetup } from "./workflow/setup.js";
import {
  cancelTask,
  createTask,
  deleteTask,
  moveTask,
  reopenTask,
  setTaskSlices,
  taskCandidates,
  taskStatus,
  transitionTask,
  transitionSlice,
  validateTask,
} from "./workflow/tasks.js";

function help() {
  console.log(
    [
      "spec-driven-template CLI",
      "",
      "setup [--config file] [--apply]",
      "doctor [--template] [--json]",
      "adapter install --agent <id> [--apply] [--replace]",
      "iteration create --title <title> --goal <goal> [--target-version <version>]",
      "iteration release-plan <iteration-id> [--apply]",
      "iteration confirm-release-plan <iteration-id> --confirmed",
      "iteration done <iteration-id> --confirmed",
      "iteration cancel <iteration-id> --reason <reason> --confirmed",
      "iteration delete <iteration-id> [--apply]",
      "task create --iteration <id> --title <title> --summary <summary> [--type <type>]",
      "task candidates [--json]",
      "task status <task> [--json]",
      "task validate <task> [--phase <phase>] [--json]",
      "task phase <task> <phase> [--reason <reason>] [--commit <repo=sha>] [--expected-revision <n>] [--confirmed]",
      "task slices <task> --config <json-file> [--expected-revision <n>]",
      "task slice <task> <slice-id> <status> [--expected-revision <n>]",
      "task reopen <task> <phase> --reason <reason> --confirmed",
      "task move <task> --iteration <id> [--apply]",
      "task delete <task> [--apply]",
      "task cancel <task> --reason <reason> --confirmed",
      "change add --iteration <id> --summary <text> --commit <repo=sha> --verification <text>",
      "context <skill-name> [--task <task>] [--json]",
      "",
      "删除、移动和适配器替换默认只预览。CLI 不执行 push、部署或 DDL。",
    ].join("\n"),
  );
}

function assertArity(positionals, expected, usage) {
  if (positionals.length !== expected) {
    throw new Error("用法: " + usage);
  }
}

function printTaskInspection(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const lines = [
    "任务: " + result.path,
    "阶段: " + result.phase,
    "Revision: " + result.revision,
    "就绪: " + (Boolean(result.ready ?? result.valid) ? "是" : "否"),
  ];
  if (result.nextAction) {
    lines.push("下一步: " + result.nextAction);
  }
  if (result.blockers?.length) {
    lines.push("阻塞:", ...result.blockers.map((blocker) => "- " + blocker));
  }
  console.log(lines.join("\n"));
}

async function main(argv) {
  const { positionals, options } = parseCliArgs(argv);
  const [group, action, third] = positionals;
  if (!group || group === "help" || options.help) {
    help();
    return;
  }
  if (group === "setup") {
    assertArity(positionals, 1, "setup [--config file] [--apply]");
    await runSetup(options);
    return;
  }
  if (group === "doctor") {
    assertArity(positionals, 1, "doctor [--template] [--json]");
    const checks = runDoctor(options);
    printDoctor(checks, Boolean(options.json));
    if (checks.some((check) => check.level === "error")) {
      process.exitCode = 1;
    }
    return;
  }
  if (group === "adapter" && action === "install") {
    assertArity(positionals, 2, "adapter install --agent <id> [--apply] [--replace]");
    const config = readLocalConfig();
    const agentId = String(options.agent || config?.agent?.id || "");
    const actions = installAdapter(agentId, config, {
      apply: options.apply,
      replace: options.replace,
    });
    if (options.apply) {
      ensureAdapterIgnored(agentId, config);
    }
    console.log(JSON.stringify(actions, null, 2));
    if (!options.apply && actions.some((item) => item.action !== "native")) {
      console.log("确认后添加 --apply；替换冲突项还需添加 --replace。");
    }
    return;
  }
  if (group === "iteration" && action === "create") {
    assertArity(positionals, 2, "iteration create --title <title> --goal <goal>");
    createIteration(options);
    return;
  }
  if (group === "iteration" && action === "release-plan") {
    assertArity(positionals, 3, "iteration release-plan <iteration-id> [--apply]");
    writeReleasePlan(third, options);
    return;
  }
  if (group === "iteration" && action === "confirm-release-plan") {
    assertArity(positionals, 3, "iteration confirm-release-plan <iteration-id> --confirmed");
    confirmReleasePlan(third, options);
    return;
  }
  if (group === "iteration" && action === "done") {
    assertArity(positionals, 3, "iteration done <iteration-id> --confirmed");
    finishIteration(third, options);
    return;
  }
  if (group === "iteration" && action === "cancel") {
    assertArity(positionals, 3, "iteration cancel <iteration-id> --reason <reason> --confirmed");
    cancelIteration(third, options);
    return;
  }
  if (group === "iteration" && action === "delete") {
    assertArity(positionals, 3, "iteration delete <iteration-id> [--apply]");
    deleteIteration(third, options);
    return;
  }
  if (group === "task" && action === "create") {
    assertArity(positionals, 2, "task create --iteration <id> --title <title> --summary <summary>");
    createTask(options);
    return;
  }
  if (group === "task" && action === "candidates") {
    assertArity(positionals, 2, "task candidates [--json]");
    const candidates = taskCandidates();
    if (options.json) {
      console.log(JSON.stringify(candidates, null, 2));
    } else if (!candidates.length) {
      console.log("没有可用任务。");
    } else {
      candidates.forEach((candidate, index) => {
        console.log(
          String(index + 1) +
            ". " +
            candidate.path +
            " | " +
            candidate.title +
            " | " +
            candidate.phase +
            " | " +
            candidate.source +
            " | author=" +
            (candidate.authorEmail || "unknown"),
        );
      });
    }
    return;
  }
  if (group === "task" && action === "status") {
    assertArity(positionals, 3, "task status <task> [--json]");
    printTaskInspection(taskStatus(third), Boolean(options.json));
    return;
  }
  if (group === "task" && action === "validate") {
    assertArity(positionals, 3, "task validate <task> [--phase <phase>] [--json]");
    const result = validateTask(third, options);
    printTaskInspection(result, Boolean(options.json));
    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (group === "task" && action === "phase") {
    assertArity(positionals, 4, "task phase <task> <phase> [--confirmed]");
    transitionTask(third, positionals[3], options);
    return;
  }
  if (group === "task" && action === "slices") {
    assertArity(positionals, 3, "task slices <task> --config <json-file>");
    if (!options.config) {
      throw new Error("task slices 需要 --config <json-file>");
    }
    const value = readJson(resolve(process.cwd(), String(options.config)));
    const slices = Array.isArray(value) ? value : value.slices;
    console.log(JSON.stringify(setTaskSlices(third, slices, options), null, 2));
    return;
  }
  if (group === "task" && action === "slice") {
    assertArity(positionals, 5, "task slice <task> <slice-id> <status>");
    transitionSlice(third, positionals[3], positionals[4], options);
    return;
  }
  if (group === "task" && action === "reopen") {
    assertArity(positionals, 4, "task reopen <task> <phase> --reason <reason> --confirmed");
    reopenTask(third, positionals[3], options);
    return;
  }
  if (group === "task" && action === "move") {
    assertArity(positionals, 3, "task move <task> --iteration <id> [--apply]");
    moveTask(third, options);
    return;
  }
  if (group === "task" && action === "delete") {
    assertArity(positionals, 3, "task delete <task> [--apply]");
    deleteTask(third, options);
    return;
  }
  if (group === "task" && action === "cancel") {
    assertArity(positionals, 3, "task cancel <task> --reason <reason> --confirmed");
    cancelTask(third, options);
    return;
  }
  if (group === "change" && action === "add") {
    assertArity(positionals, 2, "change add --iteration <id> --summary <text> --commit <repo=sha> --verification <text>");
    addChange(options);
    return;
  }
  if (group === "context") {
    assertArity(positionals, 2, "context <skill-name> [--task <task>] [--json]");
    const task = options.task ? resolveTask(String(options.task)) : null;
    const iteration = options.iteration
      ? resolveIteration(String(options.iteration))
      : null;
    const result = buildContextPaths(action, task, ROOT, iteration);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : [
            "必读:",
            ...result.required.map((path) => "- " + path),
            "按需:",
            ...result.conditional.map((item) => "- " + item),
            "初始禁止:",
            ...result.forbidden_initial.map((item) => "- " + item),
            "输出:",
            ...result.outputs.map((item) => "- " + item),
            ...(result.warnings.length
              ? ["警告:", ...result.warnings.map((item) => "- " + item)]
              : []),
          ].join("\n"),
    );
    return;
  }
  throw new Error("未知命令。运行 node tools/workflow.js help 查看用法。");
}

function canonicalPath(path) {
  return normalize(realpathSync.native(resolve(path)));
}

export function isMainModule(moduleUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) {
    return false;
  }
  try {
    return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(argvEntry);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("错误: " + error.message);
    if (process.env.SPEC_DRIVEN_DEBUG) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}
