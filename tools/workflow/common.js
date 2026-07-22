import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ITERATIONS_DIR = join(ROOT, "iterations");
export const LOCAL_CONFIG_FILE = join(ROOT, "AGENTS.local.md");
const LOCAL_START = "<!-- spec-driven:local-config:start -->";
const LOCAL_END = "<!-- spec-driven:local-config:end -->";

export const PHASES = [
  "prd",
  "technical_design",
  "implementation_spec",
  "implementation",
  "verification",
  "done",
];

export const TASK_TYPES = ["feature", "bug", "change", "maintenance"];

export const SKILLS = [
  "spec-driven-setup",
  "spec-driven-doctor",
  "spec-driven-route-task",
  "spec-driven-simple-change",
  "spec-driven-prd",
  "spec-driven-technical-design",
  "spec-driven-spec",
  "spec-driven-implement",
  "spec-driven-code-review",
  "spec-driven-verify",
  "spec-driven-release-plan",
];

export function readText(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : content + "\n", "utf8");
}

export function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2));
}

export function today(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join("-");
}

export function slugify(value, fallback = "item") {
  const slug = String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function uniqueDirectory(parent, wanted) {
  let candidate = wanted;
  let number = 2;
  while (existsSync(join(parent, candidate))) {
    candidate = wanted + "-" + number;
    number += 1;
  }
  return candidate;
}

export function ensureWithin(base, target) {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("路径超出工作流边界: " + resolvedTarget);
  }
  return resolvedTarget;
}

export function workflowPath(path) {
  return ensureWithin(ROOT, resolve(ROOT, path));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function fileHash(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : null;
}

export function parseCliArgs(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    const optionValue = next && !next.startsWith("--") ? args[++index] : true;
    if (options[key] === undefined) {
      options[key] = optionValue;
    } else if (Array.isArray(options[key])) {
      options[key].push(optionValue);
    } else {
      options[key] = [options[key], optionValue];
    }
  }
  return { positionals, options };
}

export function optionList(value) {
  if (value === undefined || value === true || value === "") {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    String(item)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export function extractManagedJson(text, start = LOCAL_START, end = LOCAL_END) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt < 0 || endAt < startAt) {
    throw new Error("缺少受管配置块");
  }
  const body = text.slice(startAt + start.length, endAt).trim();
  return JSON.parse(body);
}

export function replaceManagedBlock(text, value, start = LOCAL_START, end = LOCAL_END) {
  const block = start + "\n" + JSON.stringify(value, null, 2) + "\n" + end;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt >= 0 && endAt >= startAt) {
    return (
      text.slice(0, startAt) +
      block +
      text.slice(endAt + end.length)
    ).trimEnd() + "\n";
  }
  return text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
}

export function replaceTextBlock(text, body, start, end) {
  const block = start + "\n" + body.trim() + "\n" + end;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt >= 0 && endAt >= startAt) {
    return (
      text.slice(0, startAt) +
      block +
      text.slice(endAt + end.length)
    ).trimEnd() + "\n";
  }
  return text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
}

export function findSecretPaths(value) {
  const findings = [];
  const directSecretKey =
    /(^|_)(secret|token|password|passwd|api_?key|private_?key|credential)s?$/i;
  const highConfidenceValue =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b|https?:\/\/[^\s/:@]+:[^\s/@]+@|\b(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s$%]+/i;

  function visit(current, path) {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, path + "[" + index + "]"));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        const childPath = path ? path + "." + key : key;
        if (
          directSecretKey.test(key) &&
          child !== null &&
          child !== undefined &&
          String(child).trim() !== ""
        ) {
          findings.push(childPath);
        }
        visit(child, childPath);
      }
      return;
    }
    if (typeof current === "string" && highConfidenceValue.test(current)) {
      findings.push(path || "<root>");
    }
  }

  visit(value, "");
  return [...new Set(findings)];
}

export function assertNoSecrets(value) {
  const findings = findSecretPaths(value);
  if (findings.length) {
    throw new Error("配置包含疑似密钥值，仅允许记录变量名: " + findings.join(", "));
  }
}

export function readLocalConfig(root = ROOT) {
  if (!existsSync(join(root, "AGENTS.local.md"))) {
    return null;
  }
  return extractManagedJson(readText(join(root, "AGENTS.local.md")));
}

export function runGit(args, cwd = ROOT, allowFailure = false, raw = false) {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return raw ? output : output.trim();
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error("Git 命令失败: " + detail);
  }
}

export function isGitRepository(path) {
  return runGit(["rev-parse", "--is-inside-work-tree"], path, true) === "true";
}

export function listIterationDirectories(root = ROOT) {
  const base = join(root, "iterations");
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "iteration.json")))
    .map((entry) => join(base, entry.name));
}

export function listTaskDirectories(root = ROOT) {
  const tasks = [];
  for (const iteration of listIterationDirectories(root)) {
    for (const entry of readdirSync(iteration, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(iteration, entry.name, "task.json"))) {
        tasks.push(join(iteration, entry.name));
      }
    }
  }
  return tasks;
}

export function resolveIteration(reference, root = ROOT) {
  if (!reference) {
    throw new Error("必须明确指定迭代");
  }
  const path = isAbsolute(reference)
    ? reference
    : reference.includes("/") || reference.includes("\\")
      ? resolve(root, reference)
      : join(root, "iterations", reference);
  const safe = ensureWithin(join(root, "iterations"), path);
  if (!existsSync(join(safe, "iteration.json"))) {
    throw new Error("找不到迭代: " + reference);
  }
  return safe;
}

export function resolveTask(reference, root = ROOT) {
  if (!reference) {
    throw new Error("必须明确指定任务");
  }
  const direct = isAbsolute(reference) ? reference : resolve(root, reference);
  if (existsSync(direct)) {
    const directory = basename(direct) === "task.json" ? dirname(direct) : direct;
    const safe = ensureWithin(join(root, "iterations"), directory);
    if (existsSync(join(safe, "task.json"))) {
      return safe;
    }
  }
  const matches = listTaskDirectories(root).filter(
    (directory) => basename(directory) === reference,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length ? "任务名称不唯一: " + reference : "找不到任务: " + reference,
    );
  }
  return matches[0];
}

export function pathHasCommit(directory) {
  if (!isGitRepository(ROOT)) {
    return false;
  }
  return Boolean(
    runGit(
      ["log", "-1", "--format=%H", "--", relative(ROOT, directory)],
      ROOT,
      true,
    ),
  );
}
