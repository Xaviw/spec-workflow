import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  ROOT,
  SKILLS,
  ensureWithin,
  readText,
} from "./common.js";

export function buildContextPaths(
  skill,
  taskDirectory = null,
  root = ROOT,
  iterationDirectory = null,
) {
  if (!SKILLS.includes(skill)) {
    throw new Error("未知 Skill: " + skill);
  }
  const skillPath = join(root, ".agents", "skills", skill, "SKILL.md");
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
    } else if (token === "WORKFLOW_VERSION" || token.startsWith("tools/")) {
      required.push(join(root, token));
    } else if (taskDocs.has(token)) {
      if (taskDirectory) {
        const safeTask = ensureWithin(join(root, "iterations"), taskDirectory);
        required.push(join(safeTask, token));
      } else if (iterationDirectory && token === "task.json") {
        const safeIteration = ensureWithin(
          join(root, "iterations"),
          iterationDirectory,
        );
        for (const entry of readdirSync(safeIteration, { withFileTypes: true })) {
          const path = join(safeIteration, entry.name, token);
          if (entry.isDirectory() && existsSync(path)) {
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
      const safeIteration = ensureWithin(
        join(root, "iterations"),
        inferredIteration,
      );
      required.push(join(safeIteration, token));
    } else if (/^(?:project|iterations)\//.test(token)) {
      required.push(join(root, token));
    }
  }
  return {
    required: [...new Set(required)].map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
    conditional: conditionalClause ? [conditionalClause] : [],
    forbidden_initial: forbiddenClause ? [forbiddenClause] : [],
    outputs: outputClause ? [outputClause] : [],
  };
}
