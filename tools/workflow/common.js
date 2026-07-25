import { randomUUID } from "node:crypto";
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
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonical = existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor;
  return resolve(canonical, ...missing);
}

export const ROOT = canonicalBoundaryPath(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
export const ITERATIONS_DIR = join(ROOT, "iterations");
export const LOCAL_CONFIG_FILE = join(ROOT, "AGENTS.local.md");
export const LOCAL_START = "<!-- spec-driven:local-config:start -->";
export const LOCAL_END = "<!-- spec-driven:local-config:end -->";
export const PHASES = [
  "prd",
  "technical_design",
  "implementation_spec",
  "implementation",
  "verification",
  "done",
];
export const PHASE_FILES = {
  prd: "prd.md",
  technical_design: "technical-design.md",
  implementation_spec: "spec.md",
  verification: "verification.md",
};

const BOOLEAN_OPTIONS = new Set(["help", "json", "confirmed", "replace"]);
const VALUE_OPTIONS = new Set([
  "agent",
  "entry-path",
  "skills-path",
  "repo",
  "title",
  "slug",
  "status",
  "iteration",
  "repositories",
  "summary",
]);
const ITERATION_FIELDS = new Set([
  "title",
  "status",
  "created_at",
  "ended_at",
  "simple_changes",
]);
const TASK_FIELDS = new Set([
  "title",
  "phase",
  "repositories",
  "created_at",
  "cancelled_from",
  "git",
]);
const AGENT_FIELDS = new Set(["id", "entry_path", "skills_path"]);
const REPOSITORY_FIELDS = new Set(["id", "path"]);
const PROTECTED_INTEGRATION_PATHS = [
  ".git",
  ".agents",
  "tools",
  "iterations",
  "standards",
  "project",
  "adr",
  "AGENTS.md",
  "AGENTS.local.md",
  "CONTEXT.md",
  "README.md",
  ".gitignore",
];

export function parseCliArgs(args) {
  const positionals = [];
  const options = {};
  const add = (key, value) => {
    if (options[key] === undefined) options[key] = value;
    else if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      if (/^(?:true|false)$/i.test(args[index + 1] || "")) {
        throw new Error("布尔选项不接受 true/false 值: --" + key);
      }
      add(key, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error("未知选项: --" + key);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error("选项缺少值: --" + key);
    }
    add(key, next);
    index += 1;
  }
  return { positionals, options };
}

export function assertOptions(options, allowed) {
  const valid = new Set(["json", "help", ...allowed]);
  const unknown = Object.keys(options).filter((key) => !valid.has(key));
  if (unknown.length) throw new Error("当前命令不支持选项: --" + unknown.join(", --"));
}

export function optionValues(value) {
  if (value === undefined || value === true || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

export function optionList(value) {
  return optionValues(value).flatMap((item) =>
    item.split(",").map((part) => part.trim()).filter(Boolean)
  );
}

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
    // Windows 和部分文件系统不支持同步目录。
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeText(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.spec-workflow-${process.pid}-${randomUUID()}.tmp`);
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : null;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", existingMode ?? 0o666);
    const value = content.endsWith("\n") ? content : content + "\n";
    writeFileSync(descriptor, value, "utf8");
    if (existingMode !== null && process.platform !== "win32") {
      fchmodSync(descriptor, existingMode);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2));
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, String(process.pid), "utf8");
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
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (processError) {
          stale = processError.code === "ESRCH";
        }
      } else {
        stale = Date.now() - statSync(path).mtimeMs > 5 * 60 * 1000;
      }
    } catch {
      if (!existsSync(path)) return acquireLock(path);
      stale = Date.now() - statSync(path).mtimeMs > 5 * 60 * 1000;
    }
    if (stale) {
      rmSync(path, { force: true });
      return acquireLock(path);
    }
    throw new Error("工作流状态正被另一个进程修改，请稍后重试: " + basename(path));
  }
}

export function withFileLocks(paths, callback) {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  const visit = (index) => {
    if (index === ordered.length) return callback();
    const lock = acquireLock(ordered[index]);
    try {
      return visit(index + 1);
    } finally {
      try {
        closeSync(lock.descriptor);
      } finally {
        rmSync(lock.path, { force: true });
      }
    }
  };
  return visit(0);
}

export function iterationLockPath(directory) {
  // ponytail: 每个迭代一把锁；只有实际出现写入竞争时才细分。
  return join(dirname(directory), "." + basename(directory) + ".iteration.lock");
}

export function today(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
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
  while (existsSync(join(parent, candidate))) candidate = wanted + "-" + number++;
  return candidate;
}

export function ensureWithin(base, target) {
  const safeBase = canonicalBoundaryPath(base);
  const safeTarget = canonicalBoundaryPath(target);
  const prefix = safeBase.endsWith(sep) ? safeBase : safeBase + sep;
  if (safeTarget !== safeBase && !safeTarget.startsWith(prefix)) {
    throw new Error("路径超出工作流边界: " + safeTarget);
  }
  return safeTarget;
}

export function workflowPath(path, root = ROOT) {
  if (isAbsolute(path)) throw new Error("工作流内路径必须是相对路径: " + path);
  return ensureWithin(root, resolve(root, path));
}

function sameOrWithin(base, target) {
  const path = relative(base, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}

export function extractManagedJson(text, start = LOCAL_START, end = LOCAL_END) {
  const { startAt, endAt } = blockBounds(text, start, end);
  if (startAt < 0 || endAt < startAt) throw new Error("缺少受管配置块");
  return JSON.parse(text.slice(startAt + start.length, endAt).trim());
}

function blockBounds(text, start, end) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  const duplicate = startAt >= 0 && (
    text.indexOf(start, startAt + start.length) >= 0 ||
    text.indexOf(end, endAt + end.length) >= 0
  );
  if ((startAt < 0) !== (endAt < 0) || (startAt >= 0 && endAt < startAt) || duplicate) {
    throw new Error("受管块标记不完整: " + start);
  }
  return { startAt, endAt };
}

export function replaceManagedBlock(text, value, start = LOCAL_START, end = LOCAL_END) {
  return replaceTextBlock(text, JSON.stringify(value, null, 2), start, end);
}

export function replaceTextBlock(text, body, start, end) {
  const { startAt, endAt } = blockBounds(text, start, end);
  const block = start + "\n" + body.trim() + "\n" + end;
  if (startAt < 0) return text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
  return (text.slice(0, startAt) + block + text.slice(endAt + end.length)).trimEnd() + "\n";
}

export function removeTextBlock(text, start, end) {
  const { startAt, endAt } = blockBounds(text, start, end);
  if (startAt < 0) return text;
  return (text.slice(0, startAt) + text.slice(endAt + end.length)).trim() + (text.trim() ? "\n" : "");
}

export function findSecretPaths(value) {
  const findings = [];
  const secretKey = /(^|_)(secret|token|password|passwd|api_?key|private_?key|credential)s?$/i;
  const secretValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b|https?:\/\/[^\s/:@]+:[^\s/@]+@/i;
  const visit = (current, path) => {
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        const childPath = path ? path + "." + key : key;
        if (secretKey.test(key) && child !== null && String(child).trim()) findings.push(childPath);
        visit(child, childPath);
      }
    } else if (typeof current === "string" && secretValue.test(current)) {
      findings.push(path || "<root>");
    }
  };
  visit(value, "");
  return [...new Set(findings)];
}

export function assertNoSecrets(value) {
  const findings = findSecretPaths(value);
  if (findings.length) {
    throw new Error("配置包含疑似密钥值，仅允许记录变量名: " + findings.join(", "));
  }
}

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function assertPortableId(value, label = "ID") {
  const id = String(value || "");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id) || WINDOWS_RESERVED_NAMES.test(id)) {
    throw new Error(label + " 必须是 1-64 位小写 ASCII 字母、数字、点、下划线或连字符");
  }
  return id;
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " 必须是对象");
  }
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) throw new Error(label + " 包含未知字段: " + unknown.join(", "));
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
    if (allowFailure) return "";
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error("Git 命令失败: " + detail);
  }
}

export function repositoryIdentity(path) {
  const root = realpathSync.native(resolve(path));
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], root, true);
  if (!gitRoot || realpathSync.native(resolve(gitRoot)) !== root) {
    throw new Error("目标必须是 Git 仓库根目录: " + path);
  }
  return root;
}

export function discoverSkills(root = ROOT) {
  const directory = join(root, ".agents", "skills");
  if (!existsSync(directory)) throw new Error("缺少 Skills 目录: .agents/skills");
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    if (!existsSync(join(directory, name, "SKILL.md"))) {
      throw new Error("Skill 缺少 SKILL.md: " + name);
    }
  }
  return names;
}

export function parseSetupConfig(raw, root = ROOT) {
  assertExactFields(raw, new Set(["schema_version", "agent", "repositories"]), "setup 配置");
  if (raw.schema_version !== 1) throw new Error("setup 配置 schema_version 必须为 1");
  assertExactFields(raw.agent, AGENT_FIELDS, "agent");
  if (typeof raw.agent.id !== "string" || !raw.agent.id.trim()) throw new Error("agent.id 不能为空");
  const agent = { id: raw.agent.id.trim() };
  const integrationPaths = {};
  for (const field of ["entry_path", "skills_path"]) {
    if (raw.agent[field] !== undefined) {
      if (typeof raw.agent[field] !== "string" || !raw.agent[field].trim()) {
        throw new Error("agent." + field + " 必须是非空相对路径");
      }
      const value = raw.agent[field].trim();
      const target = workflowPath(value, root);
      if (
        target === canonicalBoundaryPath(root) ||
        PROTECTED_INTEGRATION_PATHS.some((path) => sameOrWithin(workflowPath(path, root), target))
      ) {
        throw new Error("Agent 接入路径不能指向受保护的工作流路径: " + value);
      }
      integrationPaths[field] = target;
      agent[field] = value.replaceAll("\\", "/");
    }
  }
  if (
    integrationPaths.entry_path &&
    integrationPaths.skills_path &&
    (
      sameOrWithin(integrationPaths.entry_path, integrationPaths.skills_path) ||
      sameOrWithin(integrationPaths.skills_path, integrationPaths.entry_path)
    )
  ) {
    throw new Error("Agent 入口路径与 Skills 路径不能重叠");
  }
  if (!Array.isArray(raw.repositories) || !raw.repositories.length) {
    throw new Error("setup 至少需要一个仓库映射");
  }
  const ids = new Set();
  const paths = new Set();
  const repositories = raw.repositories.map((repository) => {
    assertExactFields(repository, REPOSITORY_FIELDS, "repository");
    const id = assertPortableId(repository.id, "仓库 ID");
    if (ids.has(id)) throw new Error("仓库 ID 重复: " + id);
    ids.add(id);
    const path = repositoryIdentity(repository.path);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (paths.has(key)) throw new Error("仓库路径重复: " + path);
    paths.add(key);
    return { id, path };
  });
  const config = { schema_version: 1, agent, repositories };
  assertNoSecrets(config);
  return config;
}

export function readLocalConfig(root = ROOT) {
  const path = join(root, "AGENTS.local.md");
  if (!existsSync(path)) return null;
  return parseSetupConfig(extractManagedJson(readText(path)), root);
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateSnapshot(snapshot, final) {
  if (snapshot === null) return;
  if (!Array.isArray(snapshot)) throw new Error("Git 快照必须是数组或 null");
  for (const item of snapshot) {
    const required = final
      ? ["id", "head", "tree", "dirty_paths"]
      : ["id", "root", "branch", "head", "dirty_paths"];
    assertExactFields(item, new Set(required), "Git 快照项");
    if (required.some((field) => item[field] === undefined)) throw new Error("Git 快照字段不完整");
    for (const field of required.filter((field) => field !== "dirty_paths")) {
      if (typeof item[field] !== "string") throw new Error("Git 快照字段必须是字符串: " + field);
    }
    if (!Array.isArray(item.dirty_paths) || item.dirty_paths.some((path) => typeof path !== "string")) {
      throw new Error("dirty_paths 必须是字符串数组");
    }
  }
}

export function parseIterationData(raw) {
  assertExactFields(raw, ITERATION_FIELDS, "iteration.json");
  if (!raw.title?.trim() || !["open", "closed", "cancelled"].includes(raw.status) || !validDate(raw.created_at)) {
    throw new Error("iteration.json 格式无效");
  }
  if (raw.ended_at !== null && !validDate(raw.ended_at)) throw new Error("ended_at 无效");
  if ((raw.status === "open") !== (raw.ended_at === null)) {
    throw new Error("ended_at 与 iteration status 不一致");
  }
  if (!Array.isArray(raw.simple_changes)) throw new Error("simple_changes 必须是数组");
  for (const change of raw.simple_changes) {
    assertExactFields(change, new Set(["summary", "repositories", "git", "recorded_at"]), "simple change");
    if (!change.summary?.trim() || !Array.isArray(change.repositories) || !validDate(change.recorded_at)) {
      throw new Error("simple change 格式无效");
    }
    if (change.repositories.some((id) => typeof id !== "string") || new Set(change.repositories).size !== change.repositories.length) {
      throw new Error("simple change repositories 必须是无重复字符串数组");
    }
    validateSnapshot(change.git, true);
    if (change.git.map((item) => item.id).sort().join("\0") !== [...change.repositories].sort().join("\0")) {
      throw new Error("simple change 仓库与 Git 快照不一致");
    }
  }
  return raw;
}

export function parseTaskData(raw) {
  assertExactFields(raw, TASK_FIELDS, "task.json");
  const phases = [...PHASES, "cancelled"];
  if (!raw.title?.trim() || !phases.includes(raw.phase) || !validDate(raw.created_at)) {
    throw new Error("task.json 格式无效");
  }
  if (
    !Array.isArray(raw.repositories) ||
    raw.repositories.some((id) => typeof id !== "string" || !id) ||
    new Set(raw.repositories).size !== raw.repositories.length
  ) {
    throw new Error("task.repositories 必须是无重复数组");
  }
  if (raw.cancelled_from !== null && !PHASES.slice(0, -1).includes(raw.cancelled_from)) {
    throw new Error("cancelled_from 无效");
  }
  assertExactFields(raw.git, new Set(["baseline", "final"]), "task.git");
  validateSnapshot(raw.git.baseline, false);
  validateSnapshot(raw.git.final, true);
  for (const snapshot of [raw.git.baseline, raw.git.final].filter(Boolean)) {
    if (snapshot.map((item) => item.id).sort().join("\0") !== [...raw.repositories].sort().join("\0")) {
      throw new Error("task.repositories 与 Git 快照不一致");
    }
  }
  if ((raw.phase === "cancelled") !== (raw.cancelled_from !== null)) {
    throw new Error("cancelled_from 与 phase 不一致");
  }
  const effectivePhase = raw.phase === "cancelled" ? raw.cancelled_from : raw.phase;
  const needsBaseline = PHASES.indexOf(effectivePhase) >= PHASES.indexOf("implementation");
  if (needsBaseline !== Array.isArray(raw.git.baseline)) {
    throw new Error("baseline Git 快照与 phase 不一致");
  }
  if ((raw.phase === "done") !== Array.isArray(raw.git.final)) {
    throw new Error("final Git 快照与 phase 不一致");
  }
  return raw;
}

export function listIterationDirectories(root = ROOT) {
  const base = join(root, "iterations");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "iteration.json")))
    .map((entry) => join(base, entry.name))
    .sort();
}

export function listTaskDirectories(root = ROOT) {
  return listIterationDirectories(root).flatMap((iteration) =>
    readdirSync(iteration, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(iteration, entry.name, "task.json")))
      .map((entry) => join(iteration, entry.name))
  ).sort();
}

export function resolveIteration(reference, root = ROOT) {
  if (!reference) throw new Error("必须明确指定迭代");
  const path = isAbsolute(reference)
    ? reference
    : reference.includes("/") || reference.includes("\\")
      ? resolve(root, reference)
      : join(root, "iterations", reference);
  const safe = ensureWithin(join(root, "iterations"), path);
  if (!existsSync(join(safe, "iteration.json"))) throw new Error("找不到迭代: " + reference);
  return safe;
}

export function resolveTask(reference, root = ROOT) {
  if (!reference) throw new Error("必须明确指定任务");
  const direct = isAbsolute(reference) ? reference : resolve(root, reference);
  if (existsSync(direct)) {
    const directory = basename(direct) === "task.json" ? dirname(direct) : direct;
    const safe = ensureWithin(join(root, "iterations"), directory);
    if (existsSync(join(safe, "task.json"))) return safe;
  }
  const matches = listTaskDirectories(root).filter((directory) => basename(directory) === reference);
  if (matches.length !== 1) {
    throw new Error(matches.length ? "任务名称不唯一: " + reference : "找不到任务: " + reference);
  }
  return matches[0];
}

function dirtyPaths(root) {
  const raw = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, false, true);
  const entries = raw.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[index + 1]) paths.push(entries[++index]);
  }
  return [...new Set(paths)].sort();
}

export function captureRepositories(repositoryIds, final, root = ROOT, expectedRoots = null) {
  const config = readLocalConfig(root);
  if (!config) throw new Error("缺少 setup 配置，请先执行 setup");
  const byId = new Map(config.repositories.map((repository) => [repository.id, repository]));
  const pathKey = (path) => process.platform === "win32" ? path.toLowerCase() : path;
  return repositoryIds.map((id) => {
    const repository = byId.get(id);
    if (!repository) throw new Error("未登记仓库: " + id);
    const expectedRoot = expectedRoots?.get(id);
    if (expectedRoot && pathKey(repository.path) !== pathKey(expectedRoot)) {
      throw new Error("任务执行期间仓库映射发生变化: " + id);
    }
    const snapshot = final
      ? {
          id,
          head: runGit(["rev-parse", "HEAD"], repository.path),
          tree: runGit(["rev-parse", "HEAD^{tree}"], repository.path),
        }
      : {
          id,
          root: repository.path,
          branch: runGit(["branch", "--show-current"], repository.path),
          head: runGit(["rev-parse", "HEAD"], repository.path),
        };
    snapshot.dirty_paths = dirtyPaths(repository.path);
    return snapshot;
  });
}

export function relativeWorkflowPath(path, root = ROOT) {
  return relative(root, path).replaceAll("\\", "/");
}

export function isSymbolicLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
