#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ROOT,
  parseCliArgs,
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
  taskCandidates,
  transitionTask,
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
      "task phase <task> <phase> [--reason <reason>] [--confirmed]",
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

async function main(argv) {
  const { positionals, options } = parseCliArgs(argv);
  const [group, action, third] = positionals;
  if (!group || group === "help" || options.help) {
    help();
    return;
  }
  if (group === "setup") {
    await runSetup(options);
    return;
  }
  if (group === "doctor") {
    const checks = runDoctor(options);
    printDoctor(checks, Boolean(options.json));
    if (checks.some((check) => check.level === "error")) {
      process.exitCode = 1;
    }
    return;
  }
  if (group === "adapter" && action === "install") {
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
    createIteration(options);
    return;
  }
  if (group === "iteration" && action === "release-plan") {
    writeReleasePlan(third, options);
    return;
  }
  if (group === "iteration" && action === "confirm-release-plan") {
    confirmReleasePlan(third, options);
    return;
  }
  if (group === "iteration" && action === "done") {
    finishIteration(third, options);
    return;
  }
  if (group === "iteration" && action === "cancel") {
    cancelIteration(third, options);
    return;
  }
  if (group === "iteration" && action === "delete") {
    deleteIteration(third, options);
    return;
  }
  if (group === "task" && action === "create") {
    createTask(options);
    return;
  }
  if (group === "task" && action === "candidates") {
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
  if (group === "task" && action === "phase") {
    transitionTask(third, positionals[3], options);
    return;
  }
  if (group === "task" && action === "move") {
    moveTask(third, options);
    return;
  }
  if (group === "task" && action === "delete") {
    deleteTask(third, options);
    return;
  }
  if (group === "task" && action === "cancel") {
    cancelTask(third, options);
    return;
  }
  if (group === "change" && action === "add") {
    addChange(options);
    return;
  }
  if (group === "context") {
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
          ].join("\n"),
    );
    return;
  }
  throw new Error("未知命令。运行 node tools/workflow.js help 查看用法。");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("错误: " + error.message);
    if (process.env.SPEC_DRIVEN_DEBUG) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}
