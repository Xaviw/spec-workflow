import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  ROOT,
  INDEPENDENT_SKILLS,
  SKILLS,
  ensureExistingWithin,
  readJson,
  readText,
} from "./common.js";
import { parseTaskData } from "./tasks.js";
import { memoryReferencesFromFiles } from "./memory.js";

const DEFAULT_CONTEXT_BUDGET = 128 * 1024;
const CONTEXT_FREE_SKILLS = new Set([
  "sw-setup",
  "sw-doctor",
  ...INDEPENDENT_SKILLS,
]);
const LOCAL_CONFIG_FREE_SKILLS = new Set(INDEPENDENT_SKILLS);

export function buildContextPaths(
  skill,
  taskDirectory = null,
  root = ROOT,
  iterationDirectory = null,
) {
  root = ensureExistingWithin(root, root);
  const iterationsRoot = ensureExistingWithin(root, join(root, "iterations"));
  if (!SKILLS.includes(skill)) {
    throw new Error("未知 Skill: " + skill);
  }
  const skillDirectory = ensureExistingWithin(
    root,
    join(root, ".agents", "skills", skill),
  );
  const skillPath = ensureExistingWithin(
    skillDirectory,
    join(skillDirectory, "SKILL.md"),
  );
  if (!existsSync(skillPath)) {
    throw new Error("找不到 Skill: " + skill);
  }
  const skillContent = readText(skillPath);
  const clause = (label) => {
    const match = skillContent.match(new RegExp("^" + label + "：(.+)$", "m"));
    return match ? match[1].trim() : "";
  };
  const requiredClause = clause("必读");
  const conditionalClause = clause("按需读取");
  const forbiddenClause = clause("初始禁止");
  const outputClause = clause("输出");
  const required = [
    join(root, "AGENTS.md"),
    skillPath,
  ];
  const workflowMemoryContext =
    !CONTEXT_FREE_SKILLS.has(skill) ||
    Boolean(taskDirectory && INDEPENDENT_SKILLS.includes(skill));
  if (workflowMemoryContext) {
    required.push(join(root, "CONTEXT.md"));
    required.push(join(root, "project", "index.md"));
  }
  const localConfigPath = join(root, "AGENTS.local.md");
  if (
    existsSync(localConfigPath) &&
    !LOCAL_CONFIG_FREE_SKILLS.has(skill)
  ) {
    required.push(localConfigPath);
  }
  const taskDocs = new Set([
    "task.json",
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
    "verification.md",
  ]);
  const tokens = [...requiredClause.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1],
  );
  for (const token of tokens) {
    if (token === "AGENTS.md" || token === "AGENTS.local.md") {
      required.push(join(root, token));
    } else if (token.startsWith("tools/")) {
      required.push(ensureExistingWithin(root, resolve(root, token)));
    } else if (taskDocs.has(token)) {
      if (taskDirectory) {
        const safeTask = ensureExistingWithin(
          iterationsRoot,
          taskDirectory,
        );
        required.push(ensureExistingWithin(safeTask, join(safeTask, token)));
      } else if (iterationDirectory && token === "task.json") {
        const safeIteration = ensureExistingWithin(
          iterationsRoot,
          iterationDirectory,
        );
        for (const entry of readdirSync(safeIteration, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            continue;
          }
          const task = ensureExistingWithin(
            safeIteration,
            join(safeIteration, entry.name),
          );
          const path = ensureExistingWithin(task, join(task, token));
          if (existsSync(path)) {
            required.push(path);
          }
        }
      } else {
        throw new Error(skill + " 需要 --task");
      }
    } else if (token === "iteration.json" || token === "changes.jsonl") {
      const inferredIteration =
        iterationDirectory || (taskDirectory ? dirname(taskDirectory) : null);
      if (!inferredIteration) {
        throw new Error(skill + " 需要 --iteration");
      }
      const safeIteration = ensureExistingWithin(
        iterationsRoot,
        inferredIteration,
      );
      required.push(
        ensureExistingWithin(safeIteration, join(safeIteration, token)),
      );
    } else if (/^(?:project|iterations)\//.test(token)) {
      required.push(ensureExistingWithin(root, resolve(root, token)));
    }
  }
  if (taskDirectory) {
    const safeTask = ensureExistingWithin(
      iterationsRoot,
      taskDirectory,
    );
    const taskPath = ensureExistingWithin(safeTask, join(safeTask, "task.json"));
    if (existsSync(taskPath)) {
      const task = parseTaskData(readJson(taskPath));
      const repositoriesRoot = join(root, "project", "repositories");
      for (const repository of task.repositories) {
        required.push(
          ensureExistingWithin(
            root,
            ensureExistingWithin(
              repositoriesRoot,
              join(repositoriesRoot, String(repository) + ".md"),
            ),
          ),
        );
      }
    }
    const referenceSources = INDEPENDENT_SKILLS.includes(skill)
      ? [...taskDocs]
          .map((name) => join(safeTask, name))
          .filter((path) => existsSync(path))
      : required.filter((path) => path.startsWith(safeTask));
    for (const reference of memoryReferencesFromFiles(referenceSources, root)) {
      required.push(ensureExistingWithin(root, resolve(root, reference)));
    }
  }
  const uniqueRequired = [
    ...new Set(required.map((path) => ensureExistingWithin(root, path))),
  ];
  const missing = uniqueRequired.filter((path) => !existsSync(path));
  const totalBytes = uniqueRequired.reduce(
    (total, path) => total + (existsSync(path) ? statSync(path).size : 0),
    0,
  );
  const warnings = [];
  if (missing.length) {
    warnings.push(
      "缺少必读文件: " +
        missing.map((path) => relative(root, path)).join(", "),
    );
  }
  if (totalBytes > DEFAULT_CONTEXT_BUDGET) {
    warnings.push(
      "必读上下文为 " + totalBytes + " bytes，超过默认预算 " +
        DEFAULT_CONTEXT_BUDGET + " bytes；请缩小显式 context 引用。",
    );
  }
  return {
    required: uniqueRequired.map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
    missing: missing.map((path) => relative(root, path).replaceAll("\\", "/")),
    total_bytes: totalBytes,
    warnings,
    conditional: conditionalClause ? [conditionalClause] : [],
    forbidden_initial: forbiddenClause ? [forbiddenClause] : [],
    outputs: outputClause ? [outputClause] : [],
  };
}
