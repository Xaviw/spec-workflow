import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

function canonicalBoundaryPath(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = existsSync(ancestor)
    ? realpathSync.native(ancestor)
    : ancestor;
  return resolve(canonicalAncestor, ...missing);
}

export const ROOT = canonicalBoundaryPath(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
export const ITERATIONS_DIR = join(ROOT, "iterations");
export const LOCAL_CONFIG_FILE = join(ROOT, "AGENTS.local.md");
const LOCAL_START = "<!-- spec-driven:local-config:start -->";
const LOCAL_END = "<!-- spec-driven:local-config:end -->";
const BOOLEAN_CLI_OPTIONS = new Set([
  "help",
  "apply",
  "replace",
  "template",
  "json",
  "confirmed",
]);
const VALUE_CLI_OPTIONS = new Set([
  "config",
  "agent",
  "title",
  "goal",
  "target-version",
  "iteration",
  "summary",
  "type",
  "slug",
  "repositories",
  "modules",
  "related",
  "reason",
  "commit",
  "verification",
  "project-docs",
  "task",
  "phase",
  "expected-revision",
]);

export const PHASES = [
  "prd",
  "technical_design",
  "implementation_spec",
  "implementation",
  "verification",
  "done",
];

export const TASK_TYPES = ["feature", "bug", "change", "maintenance"];

const ITERATION_FIELDS = new Set([
  "schema_version",
  "id",
  "revision",
  "title",
  "goal",
  "status",
  "created_at",
  "target_version",
  "updated_at",
  "release_plan",
  "closed_at",
  "closure_receipt",
  "closure_reason",
]);

export function parseIterationData(raw, directory) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.schema_version !== 2 ||
    raw.id !== basename(directory) ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0 ||
    typeof raw.title !== "string" ||
    !raw.title.trim() ||
    typeof raw.goal !== "string" ||
    !raw.goal.trim() ||
    !["open", "done", "cancelled"].includes(raw.status) ||
    typeof raw.created_at !== "string" ||
    Number.isNaN(Date.parse(raw.created_at)) ||
    !Object.hasOwn(raw, "target_version") ||
    (raw.target_version !== null && typeof raw.target_version !== "string")
  ) {
    throw new Error("iteration.json 格式不受支持");
  }
  const unknownFields = Object.keys(raw).filter(
    (field) => !ITERATION_FIELDS.has(field),
  );
  if (unknownFields.length) {
    throw new Error("iteration.json 包含未知字段：" + unknownFields.join(", "));
  }
  return raw;
}

export const WORKFLOW_SKILLS = [
  "sw-setup",
  "sw-doctor",
  "sw-route-task",
  "sw-domain-modeling",
  "sw-simple-change",
  "sw-prd",
  "sw-technical-design",
  "sw-spec",
  "sw-implement",
  "sw-verify",
  "sw-release-plan",
];

export const INDEPENDENT_SKILLS = [
  "code-review",
  "grilling",
  "writing-great-skills",
];

export const SKILLS = [...WORKFLOW_SKILLS, ...INDEPENDENT_SKILLS];

export function readText(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Windows 和部分文件系统不支持打开或同步目录。
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 目录同步仅作尽力保证。
      }
    }
  }
}

export function writeText(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.spec-workflow-${process.pid}-${randomUUID()}.tmp`,
  );
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : null;
  const mode = existingMode ?? 0o666;
  const value = content.endsWith("\n") ? content : content + "\n";
  let descriptor;

  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, value, "utf8");
    if (existingMode !== null && process.platform !== "win32") {
      fchmodSync(descriptor, existingMode);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写入错误，并继续尝试清理临时文件。
      }
    }
    rmSync(temporaryPath, { force: true });
  }
}

export function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2));
}

function acquireFileLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
      "utf8",
    );
    fsyncSync(descriptor);
    return { descriptor, path };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } finally {
        rmSync(path, { force: true });
      }
    }
    if (error.code !== "EEXIST") {
      throw error;
    }
    let stale = false;
    try {
      const lock = JSON.parse(readFileSync(path, "utf8"));
      const pid = Number(lock.pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (processError) {
          stale = processError.code === "ESRCH";
        }
      } else {
        stale = Date.now() - statSync(path).mtimeMs > 5 * 60 * 1000;
      }
    } catch (readError) {
      if (!existsSync(path)) {
        return acquireFileLock(path);
      }
      stale = Date.now() - statSync(path).mtimeMs > 5 * 60 * 1000;
    }
    if (stale) {
      rmSync(path, { force: true });
      return acquireFileLock(path);
    }
    throw new Error("工作流状态正被另一个进程修改，请稍后重试: " + basename(path));
  }
}

function releaseFileLock(lock) {
  try {
    closeSync(lock.descriptor);
  } finally {
    rmSync(lock.path, { force: true });
  }
}

export function withFileLocks(paths, callback) {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  function visit(index) {
    if (index >= ordered.length) {
      return callback();
    }
    const lock = acquireFileLock(ordered[index]);
    try {
      return visit(index + 1);
    } finally {
      releaseFileLock(lock);
    }
  }
  return visit(0);
}

export function iterationLockPath(iterationDirectory) {
  const directory = resolve(iterationDirectory);
  return join(dirname(directory), "." + basename(directory) + ".iteration.lock");
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
  const resolvedBase = canonicalBoundaryPath(base);
  const absoluteTarget = resolve(target);
  const resolvedTarget = absoluteTarget === resolve(base)
    ? resolvedBase
    : resolve(canonicalBoundaryPath(dirname(absoluteTarget)), basename(absoluteTarget));
  return assertWithin(resolvedBase, resolvedTarget);
}

function assertWithin(resolvedBase, resolvedTarget) {
  const prefix = resolvedBase.endsWith(sep)
    ? resolvedBase
    : resolvedBase + sep;
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error("路径超出工作流边界: " + resolvedTarget);
  }
  return resolvedTarget;
}

export function ensureExistingWithin(base, target) {
  return assertWithin(
    canonicalBoundaryPath(base),
    canonicalBoundaryPath(target),
  );
}

export function workflowPath(path) {
  const target = resolve(ROOT, path);
  const safe = ensureWithin(ROOT, target);
  try {
    lstatSync(target);
    if (existsSync(target)) {
      ensureExistingWithin(ROOT, target);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return safe;
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
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path);
  const textExtensions = new Set([
    ".js",
    ".json",
    ".jsonl",
    ".md",
    ".sql",
    ".yaml",
    ".yml",
  ]);
  const canonical = textExtensions.has(extname(path).toLowerCase())
    ? content.toString("utf8").replace(/\r\n?/g, "\n")
    : content;
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseCliArgs(args) {
  const positionals = [];
  const options = {};

  function addOption(key, value) {
    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);

    if (BOOLEAN_CLI_OPTIONS.has(key)) {
      const next = args[index + 1];
      if (next !== undefined && /^(?:true|false)$/i.test(next)) {
        throw new Error("布尔选项不接受 true/false 值: --" + key);
      }
      addOption(key, true);
      continue;
    }
    if (VALUE_CLI_OPTIONS.has(key)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("选项缺少值: --" + key);
      }
      addOption(key, next);
      index += 1;
      continue;
    }
    throw new Error("未知选项: --" + key);
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
  const safe = ensureExistingWithin(join(root, "iterations"), path);
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
    const safe = ensureExistingWithin(join(root, "iterations"), directory);
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
