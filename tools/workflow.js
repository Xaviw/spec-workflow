#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertOptions, parseCliArgs } from "./workflow/common.js";
import { printDoctor, runDoctor } from "./workflow/doctor.js";
import {
  addSimpleChange,
  cancelIteration,
  closeIteration,
  createIteration,
  iterationStatus,
  listIterations,
} from "./workflow/iterations.js";
import { runSetup } from "./workflow/setup.js";
import {
  cancelTask,
  createTask,
  listTasks,
  moveTask,
  reopenTask,
  taskStatus,
  transitionTask,
} from "./workflow/tasks.js";

function help() {
  console.log([
    "spec-workflow CLI",
    "",
    "setup --agent <id> [--entry-path <path>] [--skills-path <path>] --repo <id>=<path>... [--replace] [--json]",
    "doctor [--json]",
    "iteration create --title <title> [--slug <slug>] [--json]",
    "iteration list [--status open|closed|cancelled] [--json]",
    "iteration status <iteration> [--check] [--json]",
    "iteration close <iteration> --confirmed [--json]",
    "iteration cancel <iteration> --confirmed [--json]",
    "task create --iteration <id> --title <title> [--repositories <ids>] [--json]",
    "task list [--iteration <id>] [--json]",
    "task status <task> [--json]",
    "task phase <task> <next-phase> --confirmed [--json]",
    "task cancel <task> --confirmed [--json]",
    "task reopen <task> --confirmed [--json]",
    "task move <task> --iteration <id> [--json]",
    "simple-change add --iteration <id> --summary <text> [--repositories <ids>] [--json]",
  ].join("\n"));
}

function assertArity(positionals, expected, usage) {
  if (positionals.length !== expected) throw new Error("用法: " + usage);
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (Array.isArray(result)) {
    if (!result.length) {
      console.log("没有记录。");
      return;
    }
    for (const item of result) {
      console.log([item.path || item.id, item.status || item.phase, item.title].filter(Boolean).join(" | "));
    }
    return;
  }
  if (result.path) {
    console.log([result.path, result.status || result.phase, result.title].filter(Boolean).join(" | "));
  }
  else if (result.status) console.log(result.status);
  else console.log(JSON.stringify(result, null, 2));
}

async function main(argv) {
  const { positionals, options } = parseCliArgs(argv);
  const [group, action, reference, target] = positionals;
  if (!group || group === "help" || options.help) {
    help();
    return;
  }
  const json = Boolean(options.json);

  if (group === "setup") {
    assertArity(positionals, 1, "setup --agent <id> --repo <id>=<path>...");
    assertOptions(options, ["agent", "entry-path", "skills-path", "repo", "replace"]);
    printResult(runSetup(options), json);
    return;
  }
  if (group === "doctor") {
    assertArity(positionals, 1, "doctor [--json]");
    assertOptions(options, []);
    const checks = runDoctor();
    printDoctor(checks, json);
    if (checks.some((check) => check.level === "error")) process.exitCode = 1;
    return;
  }
  if (group === "iteration" && action === "create") {
    assertArity(positionals, 2, "iteration create --title <title>");
    assertOptions(options, ["title", "slug"]);
    printResult(createIteration(options), json);
    return;
  }
  if (group === "iteration" && action === "list") {
    assertArity(positionals, 2, "iteration list [--status <status>]");
    assertOptions(options, ["status"]);
    printResult(listIterations(options), json);
    return;
  }
  if (group === "iteration" && action === "status") {
    assertArity(positionals, 3, "iteration status <iteration> [--check]");
    assertOptions(options, ["check"]);
    printResult(iterationStatus(reference, options), json);
    return;
  }
  if (group === "iteration" && action === "close") {
    assertArity(positionals, 3, "iteration close <iteration> --confirmed");
    assertOptions(options, ["confirmed"]);
    printResult(closeIteration(reference, options), json);
    return;
  }
  if (group === "iteration" && action === "cancel") {
    assertArity(positionals, 3, "iteration cancel <iteration> --confirmed");
    assertOptions(options, ["confirmed"]);
    printResult(cancelIteration(reference, options), json);
    return;
  }
  if (group === "task" && action === "create") {
    assertArity(positionals, 2, "task create --iteration <id> --title <title>");
    assertOptions(options, ["iteration", "title", "slug", "repositories"]);
    printResult(createTask(options), json);
    return;
  }
  if (group === "task" && action === "list") {
    assertArity(positionals, 2, "task list [--iteration <id>]");
    assertOptions(options, ["iteration"]);
    printResult(listTasks(options), json);
    return;
  }
  if (group === "task" && action === "status") {
    assertArity(positionals, 3, "task status <task>");
    assertOptions(options, []);
    printResult(taskStatus(reference), json);
    return;
  }
  if (group === "task" && action === "phase") {
    assertArity(positionals, 4, "task phase <task> <next-phase> --confirmed");
    assertOptions(options, ["confirmed"]);
    printResult(transitionTask(reference, target, options), json);
    return;
  }
  if (group === "task" && action === "cancel") {
    assertArity(positionals, 3, "task cancel <task> --confirmed");
    assertOptions(options, ["confirmed"]);
    printResult(cancelTask(reference, options), json);
    return;
  }
  if (group === "task" && action === "reopen") {
    assertArity(positionals, 3, "task reopen <task> --confirmed");
    assertOptions(options, ["confirmed"]);
    printResult(reopenTask(reference, options), json);
    return;
  }
  if (group === "task" && action === "move") {
    assertArity(positionals, 3, "task move <task> --iteration <id>");
    assertOptions(options, ["iteration"]);
    printResult(moveTask(reference, options), json);
    return;
  }
  if (group === "simple-change" && action === "add") {
    assertArity(positionals, 2, "simple-change add --iteration <id> --summary <text>");
    assertOptions(options, ["iteration", "summary", "repositories"]);
    printResult(addSimpleChange(options), json);
    return;
  }
  throw new Error("未知命令。运行 node tools/workflow.js help 查看用法。");
}

function canonicalPath(path) {
  return normalize(realpathSync.native(resolve(path)));
}

export function isMainModule(moduleUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  try {
    return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(argvEntry);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("错误: " + error.message);
    if (process.env.SPEC_DRIVEN_DEBUG) console.error(error.stack);
    process.exitCode = 1;
  });
}
