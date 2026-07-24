import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  ITERATIONS_DIR,
  PHASES,
  ROOT,
  TASK_TYPES,
  ensureWithin,
  fileHash,
  fingerprint,
  isGitRepository,
  iterationLockPath,
  listIterationDirectories,
  listTaskDirectories,
  optionList,
  parseIterationData,
  pathHasCommit,
  readJson,
  readLocalConfig,
  resolveIteration,
  resolveTask,
  runGit,
  slugify,
  today,
  uniqueDirectory,
  withFileLocks,
  writeJson,
  writeText,
} from "./common.js";
import { memoryDependencyHashes } from "./memory.js";

const TASK_SCHEMA_VERSION = 2;
const SLICE_STATUSES = ["pending", "in_progress", "done"];
const TERMINAL_PHASES = new Set(["done", "cancelled"]);
const TASK_FIELDS = new Set([
  "schema_version",
  "revision",
  "title",
  "summary",
  "type",
  "phase",
  "repositories",
  "modules",
  "related_tasks",
  "slices",
  "checkpoints",
  "approvals",
  "delivery",
  "cancelled_from",
  "closure_reason",
  "closed_at",
  "reopen_history",
]);
const DELIVERY_REPOSITORY_FIELDS = new Set([
  "id",
  "canonical_root",
  "branch",
  "baseline_head",
  "initial_dirty_paths",
  "initial_dirty_state",
  "captured_at",
  "verification_tree",
  "commits",
  "final_head",
  "remaining_dirty_paths",
  "finalized_at",
]);
const PHASE_FILES = {
  prd: "prd.md",
  technical_design: "technical-design.md",
  implementation_spec: "spec.md",
  verification: "verification.md",
};
const REQUIRED_SECTIONS = {
  prd: [
    ["背景与原始需求"],
    ["目标"],
    ["非目标"],
    ["用户与场景"],
    ["范围和业务规则"],
    ["异常与边界"],
    ["验收标准"],
    ["约束与依赖"],
    ["未决问题"],
  ],
  technical_design: [
    ["目标与非目标"],
    ["当前实现与证据"],
    ["总体设计"],
    ["数据模型与 DDL"],
    ["API 与调用方"],
    ["后端实现"],
    ["Web/小程序实现"],
    ["权限与安全"],
    ["配置、环境与联调"],
    ["可观测性"],
    ["跨仓库依赖与顺序"],
    ["迁移、发布与回滚"],
    ["测试和验证策略"],
    ["风险与未决问题"],
  ],
  implementation_spec: [
    ["本轮实施基线"],
    ["实施顺序与依赖"],
    ["按仓库的修改计划"],
    ["数据库与配置动作"],
    ["验收标准到验证的映射"],
    ["测试与联调"],
    ["项目文档同步"],
    ["Slices"],
    ["风险和停止条件"],
  ],
  verification: [
    ["验收项与证据"],
    ["仓库检查"],
    ["集成验证"],
    ["数据库验证"],
    ["UI 证据"],
    ["项目文档同步"],
    ["提交范围"],
    ["未验证项与残余风险"],
  ],
};
const PLACEHOLDER_PATTERN =
  /(?:\b(?:TODO|TBD|FIXME)\b|\[TODO[^\]]*\]|<\s*(?:任务标题|待[^>]*|TODO)[^>]*>|待补充|待确认|待核对|待完善)/i;
const AC_PATTERN = /\bAC-\d{3}\b/gi;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseTaskData(raw) {
  if (
    !isObject(raw) ||
    raw.schema_version !== TASK_SCHEMA_VERSION ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0
  ) {
    throw new Error("task.json 格式不受支持");
  }
  const unknownFields = Object.keys(raw).filter((field) => !TASK_FIELDS.has(field));
  if (unknownFields.length) {
    throw new Error("task.json 包含未知字段：" + unknownFields.join(", "));
  }
  if (
    typeof raw.title !== "string" ||
    !raw.title.trim() ||
    typeof raw.summary !== "string" ||
    !raw.summary.trim() ||
    !TASK_TYPES.includes(raw.type) ||
    ![...PHASES, "cancelled"].includes(raw.phase)
  ) {
    throw new Error("task.json 缺少有效的 title、summary、type 或 phase");
  }
  for (const field of [
    "repositories",
    "modules",
    "related_tasks",
    "slices",
  ]) {
    if (!Array.isArray(raw[field])) {
      throw new Error("task.json 的 " + field + " 必须是数组");
    }
  }
  for (const field of ["repositories", "modules", "related_tasks"]) {
    if (raw[field].some((value) => typeof value !== "string")) {
      throw new Error("task.json 的 " + field + " 必须只包含字符串");
    }
  }
  for (const field of ["checkpoints", "approvals", "delivery"]) {
    if (!isObject(raw[field])) {
      throw new Error("task.json 的 " + field + " 必须是对象");
    }
  }
  if (!Array.isArray(raw.delivery.repositories)) {
    throw new Error("task.json 的 delivery.repositories 必须是数组");
  }
  const slices = sliceValidation(raw.slices);
  if (!slices.valid) {
    throw new Error("task.json 的 Slices 无效：" + slices.errors.join("；"));
  }
  const deliveryRepositories = raw.delivery.repositories.map((repository) => {
    if (!isObject(repository)) {
      throw new Error("task.json 的 delivery.repositories 必须只包含对象");
    }
    const unknown = Object.keys(repository).filter(
      (field) => !DELIVERY_REPOSITORY_FIELDS.has(field),
    );
    if (unknown.length) {
      throw new Error("task.json 的 delivery 包含未知字段：" + unknown.join(", "));
    }
    for (const field of ["initial_dirty_paths", "initial_dirty_state", "commits"]) {
      if (!Array.isArray(repository[field])) {
        throw new Error("task.json 的 delivery." + field + " 必须是数组");
      }
    }
    if (
      repository.initial_dirty_paths.some((value) => typeof value !== "string") ||
      repository.commits.some((value) => typeof value !== "string") ||
      repository.initial_dirty_state.some((entry) => !isObject(entry))
    ) {
      throw new Error("task.json 的 delivery 数组字段格式无效");
    }
    if (
      repository.remaining_dirty_paths !== undefined &&
      !Array.isArray(repository.remaining_dirty_paths)
    ) {
      throw new Error("task.json 的 delivery.remaining_dirty_paths 必须是数组");
    }
    return {
      ...repository,
      initial_dirty_paths: [...repository.initial_dirty_paths],
      initial_dirty_state: repository.initial_dirty_state.map((entry) => ({ ...entry })),
      commits: [...repository.commits],
      ...(repository.remaining_dirty_paths === undefined
        ? {}
        : { remaining_dirty_paths: [...repository.remaining_dirty_paths] }),
    };
  });
  const task = {
    ...raw,
    repositories: [...raw.repositories],
    modules: [...raw.modules],
    related_tasks: [...raw.related_tasks],
    slices: slices.slices,
    checkpoints: { ...raw.checkpoints },
    approvals: { ...raw.approvals },
    delivery: {
      ...raw.delivery,
      repositories: deliveryRepositories,
    },
  };
  return task;
}

function normalizedSlice(slice) {
  const value = slice && typeof slice === "object" && !Array.isArray(slice)
    ? slice
    : {};
  return {
    id: typeof value.id === "string" ? value.id : "",
    title: typeof value.title === "string" ? value.title : "",
    status: typeof value.status === "string" ? value.status : "",
    blocked_by: Array.isArray(value.blocked_by)
      ? [...value.blocked_by]
      : [],
  };
}

function expectedRevision(options = {}) {
  const value = options["expected-revision"];
  if (value === undefined) {
    return null;
  }
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("--expected-revision 必须是非负整数");
  }
  return revision;
}

function assertExpectedRevision(task, options) {
  const expected = expectedRevision(options);
  if (expected !== null && task.revision !== expected) {
    throw new Error(
      "任务 revision 冲突：期望 " + expected + "，当前 " + task.revision,
    );
  }
}

function taskLockPath(directory) {
  return join(dirname(directory), "." + basename(directory) + ".task.lock");
}

function mutateTask(reference, options, mutation) {
  const directory = resolveTask(reference);
  const path = join(directory, "task.json");
  return withFileLocks(
    [iterationLockPath(dirname(directory)), taskLockPath(directory)],
    () => {
      const task = parseTaskData(readJson(path));
      assertExpectedRevision(task, options);
      const result = mutation(task, directory);
      task.schema_version = TASK_SCHEMA_VERSION;
      task.revision += 1;
      writeJson(path, task);
      return { directory, task, result };
    },
  );
}

function markdownSections(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const sections = [];
  let current = null;
  let hasTitle = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (heading[1].length === 1) {
        hasTitle = true;
      }
      if (heading[1].length === 2) {
        if (current) {
          sections.push(current);
        }
        current = { title: heading[2].trim(), lines: [] };
        continue;
      }
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }
  return { hasTitle, sections };
}

function meaningfulSection(lines) {
  return lines.some((line) => {
    const text = line
      .replace(/^#{3,6}\s+/, "")
      .replace(/^\s*[-*+]\s*/, "")
      .replace(/[`*_>#|:-]/g, "")
      .trim();
    return Boolean(text);
  });
}

function phaseDocumentValidation(directory, phase, acceptanceIds = []) {
  const file = PHASE_FILES[phase];
  const path = file ? join(directory, file) : null;
  const result = {
    path: file ? relative(ROOT, path).replaceAll("\\", "/") : null,
    exists: Boolean(path && existsSync(path)),
    valid: true,
    hash: path ? fileHash(path) : null,
    errors: [],
    acceptance_ids: [],
    acceptance: [],
  };
  if (!file) {
    return result;
  }
  if (!result.exists) {
    result.valid = false;
    result.errors.push("缺少阶段文档 " + file);
    return result;
  }
  const content = readFileSync(path, "utf8");
  const parsed = markdownSections(content);
  if (!parsed.hasTitle) {
    result.errors.push(file + " 缺少一级标题");
  }
  for (const names of REQUIRED_SECTIONS[phase] || []) {
    const section = parsed.sections.find((candidate) =>
      names.some((name) => candidate.title === name),
    );
    if (!section) {
      result.errors.push(file + " 缺少章节：" + names[0]);
    } else if (!meaningfulSection(section.lines)) {
      result.errors.push(file + " 章节为空：" + section.title);
    }
  }
  const placeholderLines = content
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => PLACEHOLDER_PATTERN.test(line));
  if (placeholderLines.length) {
    result.errors.push(
      file +
        " 仍含占位内容（行 " +
        placeholderLines.slice(0, 5).map(({ number }) => number).join(", ") +
        (placeholderLines.length > 5 ? " 等" : "") +
        "）",
    );
  }
  if (phase === "prd") {
    const acceptanceSection = parsed.sections.find(
      (section) => section.title === "验收标准",
    );
    const acceptanceIds = (acceptanceSection?.lines || [])
      .map((line) => line.match(/^###\s+(AC-\d{3})\b/i)?.[1]?.toUpperCase())
      .filter(Boolean);
    const uniqueIds = new Set();
    const duplicates = new Set();
    for (const id of acceptanceIds) {
      if (uniqueIds.has(id)) {
        duplicates.add(id);
      }
      uniqueIds.add(id);
    }
    result.acceptance_ids = [...uniqueIds].sort();
    if (result.acceptance_ids.length === 0) {
      result.errors.push("prd.md 的验收标准章节至少需要一个 AC-001 格式的三级标题");
    }
    if (duplicates.size) {
      result.errors.push("prd.md 包含重复验收 ID：" + [...duplicates].join(", "));
    }
  } else {
    result.acceptance_ids = [
      ...new Set((content.match(AC_PATTERN) || []).map((id) => id.toUpperCase())),
    ].sort();
  }
  if (phase === "technical_design" || phase === "implementation_spec") {
    const missing = acceptanceIds.filter(
      (id) => !result.acceptance_ids.includes(id),
    );
    if (missing.length) {
      result.errors.push(file + " 未覆盖验收项：" + missing.join(", "));
    }
  }
  if (phase === "verification") {
    const headingPattern = /^###\s+(AC-\d{3})\b[^\n]*$/gim;
    const headings = [...content.matchAll(headingPattern)];
    const seen = new Set();
    for (let index = 0; index < headings.length; index += 1) {
      const id = headings[index][1].toUpperCase();
      const start = headings[index].index + headings[index][0].length;
      const end = headings[index + 1]?.index ?? content.length;
      const body = content.slice(start, end);
      const statusMatch = body.match(
        /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?状态(?:\*\*)?\s*[:：]\s*(pass|human-confirmed|waived|failed|unverified)\b/i,
      );
      if (seen.has(id)) {
        result.errors.push("verification.md 重复验收小节：" + id);
      }
      seen.add(id);
      if (!statusMatch) {
        result.errors.push("verification.md 的 " + id + " 缺少合法状态");
        result.acceptance.push({ id, status: null });
        continue;
      }
      const status = statusMatch[1].toLowerCase();
      if (
        ["pass", "human-confirmed"].includes(status) &&
        !/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?证据(?:\*\*)?\s*[:：]\s*\S+/i.test(body)
      ) {
        result.errors.push(
          "verification.md 的 " + id + " 为 " + status + " 时必须写明证据",
        );
      }
      if (
        status === "waived" &&
        !/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:理由|豁免理由)(?:\*\*)?\s*[:：]\s*\S+/i.test(body)
      ) {
        result.errors.push("verification.md 的 " + id + " 为 waived 时必须写明理由");
      }
      result.acceptance.push({ id, status });
    }
    const missing = acceptanceIds.filter((id) => !seen.has(id));
    const unknown = [...seen].filter((id) => !acceptanceIds.includes(id));
    if (missing.length) {
      result.errors.push("verification.md 缺少验收小节：" + missing.join(", "));
    }
    if (unknown.length) {
      result.errors.push("verification.md 包含未知验收项：" + unknown.join(", "));
    }
  }
  result.valid = result.errors.length === 0;
  return result;
}

function repositoryStatusEntries(root) {
  const output = runGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ],
    root,
    true,
    true,
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
}

function repositoryDirtyState(root) {
  return repositoryStatusEntries(root)
    .map((entry) => ({
      ...entry,
      index_hash:
        runGit(["rev-parse", "--verify", ":" + entry.path], root, true) || null,
      worktree_hash:
        runGit(["hash-object", "--", entry.path], root, true) || null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalRepository(configured) {
  if (!configured || typeof configured !== "object" || !configured.id) {
    throw new Error("AGENTS.local.md 包含无效仓库配置");
  }
  const configuredPath = resolve(ROOT, String(configured.path || ""));
  if (!existsSync(configuredPath) || !isGitRepository(configuredPath)) {
    throw new Error("任务仓库不存在或不是 Git 仓库：" + configured.id);
  }
  const topLevel = runGit(["rev-parse", "--show-toplevel"], configuredPath);
  return {
    id: String(configured.id),
    canonical_root: realpathSync(topLevel),
  };
}

function configuredRepositoryMap() {
  const config = readLocalConfig();
  const repositories = Array.isArray(config?.repositories)
    ? config.repositories
    : [];
  return new Map(repositories.map((repository) => [String(repository.id), repository]));
}

function repositorySelectionValidation(task) {
  const errors = [];
  const ids = task.repositories.map(String);
  if (new Set(ids).size !== ids.length) {
    errors.push("task.repositories 包含重复仓库 ID");
  }
  let configured = new Map();
  try {
    configured = configuredRepositoryMap();
  } catch (error) {
    if (ids.length) {
      errors.push("无法读取 AGENTS.local.md：" + error.message);
    }
  }
  for (const id of ids) {
    if (!configured.has(id)) {
      errors.push("任务引用了未登记仓库：" + id);
      continue;
    }
    try {
      canonicalRepository(configured.get(id));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { errors, configured };
}

function repositoryBranch(root) {
  return runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root, true) || null;
}

function repositoryHead(root) {
  return runGit(["rev-parse", "--verify", "HEAD^{commit}"], root);
}

function repositoryState(root) {
  const entries = repositoryStatusEntries(root);
  const diff = runGit(["diff", "--binary", "HEAD", "--"], root, true, true);
  const untracked = entries
    .filter((entry) => entry.status === "??")
    .map((entry) => ({
      path: entry.path,
      hash: runGit(["hash-object", "--", entry.path], root, true),
    }));
  const head = repositoryHead(root);
  return {
    head,
    tree: runGit(["rev-parse", "HEAD^{tree}"], root),
    branch: repositoryBranch(root),
    dirty_paths: entries.map((entry) => entry.path).sort(),
    dirty_state: repositoryDirtyState(root),
    state_hash: fingerprint({
      tree: runGit(["rev-parse", "HEAD^{tree}"], root),
      diff_hash: fingerprint(diff),
      untracked,
    }),
  };
}

function captureRepositories(task) {
  const selection = repositorySelectionValidation(task);
  if (selection.errors.length) {
    throw new Error(selection.errors.join("；"));
  }
  const capturedAt = new Date().toISOString();
  task.delivery.repositories = task.repositories.map((id) => {
    const repository = canonicalRepository(selection.configured.get(String(id)));
    const state = repositoryState(repository.canonical_root);
    return {
      id: String(id),
      canonical_root: repository.canonical_root,
      branch: state.branch,
      baseline_head: state.head,
      initial_dirty_paths: state.dirty_paths,
      initial_dirty_state: state.dirty_state,
      captured_at: capturedAt,
      verification_tree: null,
      commits: [],
      final_head: null,
    };
  });
}

function commitExists(root, value) {
  return runGit(
    ["rev-parse", "--verify", String(value) + "^{commit}"],
    root,
    true,
  );
}

function isAncestor(root, ancestor, descendant) {
  return runGit(["merge-base", ancestor, descendant], root, true) === ancestor;
}

function commitsBetween(root, baseline, finalHead) {
  return runGit(
    ["rev-list", "--reverse", "--topo-order", baseline + ".." + finalHead],
    root,
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function deliveryRepositoryValidation(task, options = {}) {
  const errors = [];
  const selection = repositorySelectionValidation(task);
  errors.push(...selection.errors);
  const delivery = new Map(
    task.delivery.repositories.map((repository) => [String(repository.id), repository]),
  );
  const historical = task.phase === "done";
  if (delivery.size !== task.delivery.repositories.length) {
    errors.push("delivery.repositories 包含重复仓库 ID");
  }
  for (const id of task.repositories.map(String)) {
    const recorded = delivery.get(id);
    const configured = selection.configured.get(id);
    if (!recorded) {
      errors.push("仓库尚未捕获实施基线：" + id);
      continue;
    }
    try {
      const current = canonicalRepository(configured);
      if (realpathSync(recorded.canonical_root) !== current.canonical_root) {
        errors.push("仓库 canonical root 已变化：" + id);
        continue;
      }
      const baseline = commitExists(current.canonical_root, recorded.baseline_head);
      if (!baseline) {
        errors.push("仓库基线 commit 不存在：" + id);
        continue;
      }
      const head = repositoryHead(current.canonical_root);
      const currentBranch = repositoryBranch(current.canonical_root);
      if (!historical) {
        if (!isAncestor(current.canonical_root, baseline, head)) {
          errors.push("仓库 HEAD 不再是实施基线的后代：" + id);
        }
        if (currentBranch !== (recorded.branch || null)) {
          errors.push("仓库分支与实施基线不一致：" + id);
        }
      }
      if (options.requireFinal) {
        const commits = Array.isArray(recorded.commits) ? recorded.commits : [];
        if (!commits.length) {
          errors.push("仓库缺少交付 commit：" + id);
        }
        const finalHead = recorded.final_head
          ? commitExists(current.canonical_root, recorded.final_head)
          : "";
        if (!finalHead || !isAncestor(current.canonical_root, baseline, finalHead)) {
          errors.push("仓库最终 HEAD 记录无效：" + id);
          continue;
        }
        const tree = runGit(
          ["rev-parse", finalHead + "^{tree}"],
          current.canonical_root,
        );
        if (!recorded.verification_tree || recorded.verification_tree !== tree) {
          errors.push("仓库验证 tree 与最终 commit 不一致：" + id);
        }
        const expectedCommits = commitsBetween(
          current.canonical_root,
          baseline,
          finalHead,
        );
        if (fingerprint(commits) !== fingerprint(expectedCommits)) {
          errors.push("仓库交付 commits 未完整覆盖 baseline..final：" + id);
        }
        if (historical) {
          if (
            currentBranch === (recorded.branch || null) &&
            !isAncestor(current.canonical_root, finalHead, head)
          ) {
            errors.push("仓库当前同名分支已偏离任务最终 commit：" + id);
          }
        } else {
          if (finalHead !== head) {
            errors.push("仓库最后一个交付 commit 必须等于当前 HEAD：" + id);
          }
          const currentDirty = repositoryDirtyState(current.canonical_root);
          if (fingerprint(currentDirty) !== fingerprint(recorded.initial_dirty_state)) {
            errors.push("仓库初始脏文件内容或状态已变化：" + id);
          }
        }
      }
    } catch (error) {
      errors.push("仓库 " + id + " 校验失败：" + error.message);
    }
  }
  for (const id of delivery.keys()) {
    if (!task.repositories.map(String).includes(id)) {
      errors.push("delivery.repositories 包含任务范围外仓库：" + id);
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseCommitOptions(value) {
  const result = new Map();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [id, commits] of Object.entries(value)) {
      result.set(id, Array.isArray(commits) ? commits.map(String) : [String(commits)]);
    }
    return result;
  }
  for (const item of optionList(value)) {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error("--commit 必须使用 repo=sha 格式");
    }
    const id = item.slice(0, separator).trim();
    const sha = item.slice(separator + 1).trim();
    result.set(id, [...(result.get(id) || []), sha]);
  }
  return result;
}

function finalizeDelivery(task, commitOption) {
  const supplied = parseCommitOptions(commitOption);
  const expected = new Set(task.repositories.map(String));
  for (const id of supplied.keys()) {
    if (!expected.has(id)) {
      throw new Error("--commit 包含任务范围外仓库：" + id);
    }
  }
  for (const id of expected) {
    if (!supplied.get(id)?.length) {
      throw new Error("完成任务必须提供每个仓库的 --commit " + id + "=<sha>");
    }
  }
  const delivery = new Map(
    task.delivery.repositories.map((repository) => [String(repository.id), repository]),
  );
  for (const id of expected) {
    const recorded = delivery.get(id);
    if (!recorded) {
      throw new Error("仓库尚未捕获实施基线：" + id);
    }
    const root = realpathSync(recorded.canonical_root);
    const baseline = commitExists(root, recorded.baseline_head);
    if (!baseline) {
      throw new Error("仓库基线 commit 不存在：" + id);
    }
    const commits = [];
    for (const value of supplied.get(id)) {
      const commit = commitExists(root, value);
      if (!commit) {
        throw new Error("仓库 commit 不存在：" + id + "=" + value);
      }
      if (commit === baseline || !isAncestor(root, baseline, commit)) {
        throw new Error("仓库 commit 不是基线的严格后代：" + id + "=" + value);
      }
      commits.push(commit);
    }
    const finalHead = repositoryHead(root);
    if (commits.at(-1) !== finalHead) {
      throw new Error("仓库最后一个 --commit 必须等于当前 HEAD：" + id);
    }
    const expectedCommits = commitsBetween(root, baseline, finalHead);
    if (fingerprint(commits) !== fingerprint(expectedCommits)) {
      throw new Error(
        "--commit 必须完整、按顺序列出 baseline..HEAD 的全部 commit：" + id,
      );
    }
    const dirtyState = repositoryDirtyState(root);
    if (fingerprint(dirtyState) !== fingerprint(recorded.initial_dirty_state)) {
      throw new Error("仓库初始脏文件内容或状态已变化：" + id);
    }
    recorded.commits = expectedCommits;
    recorded.final_head = finalHead;
    recorded.verification_tree = runGit(["rev-parse", "HEAD^{tree}"], root);
    recorded.remaining_dirty_paths = dirtyState.map((entry) => entry.path);
    recorded.finalized_at = new Date().toISOString();
  }
}

function sliceValidation(slices) {
  const errors = [];
  const byId = new Map();
  const allowedFields = new Set(["id", "title", "status", "blocked_by"]);
  for (const raw of slices) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("Slice 必须是对象");
    }
    const value = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : {};
    const unsupported = Object.keys(value).filter((key) => !allowedFields.has(key));
    if (unsupported.length) {
      errors.push("Slice 包含未知字段：" + unsupported.join(", "));
    }
    if (!Array.isArray(value.blocked_by)) {
      errors.push("Slice blocked_by 必须是数组：" + String(value.id || "<unknown>"));
    } else if (value.blocked_by.some((dependency) => typeof dependency !== "string")) {
      errors.push("Slice blocked_by 必须只包含字符串：" + String(value.id || "<unknown>"));
    }
    const slice = normalizedSlice(value);
    if (!slice.id.trim()) {
      errors.push("Slice ID 不能为空");
    }
    if (!slice.title.trim()) {
      errors.push("Slice title 不能为空：" + (slice.id || "<unknown>"));
    }
    if (byId.has(slice.id)) {
      errors.push("Slice ID 重复：" + slice.id);
    }
    if (!SLICE_STATUSES.includes(slice.status)) {
      errors.push("Slice 状态无效：" + slice.id + "=" + slice.status);
    }
    if (new Set(slice.blocked_by).size !== slice.blocked_by.length) {
      errors.push("Slice blocked_by 重复：" + slice.id);
    }
    byId.set(slice.id, slice);
  }
  const active = [...byId.values()].filter((slice) => slice.status === "in_progress");
  if (active.length > 1) {
    errors.push("最多只能有一个 in_progress Slice");
  }
  for (const slice of byId.values()) {
    for (const dependency of slice.blocked_by) {
      if (!byId.has(dependency)) {
        errors.push("Slice " + slice.id + " 引用了不存在的 blocker：" + dependency);
      }
      if (dependency === slice.id) {
        errors.push("Slice 不能阻塞自身：" + slice.id);
      }
    }
    if (
      slice.status === "in_progress" &&
      slice.blocked_by.some((dependency) => byId.get(dependency)?.status !== "done")
    ) {
      errors.push("Slice 的 blocker 未完成，不能处于 in_progress：" + slice.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      errors.push("Slice blocked_by 存在环：" + id);
      return;
    }
    if (visited.has(id) || !byId.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id).blocked_by) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) {
    visit(id);
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    slices: [...byId.values()],
  };
}

function phaseDependencies(task, directory, phase) {
  const hashes = { decisions: fileHash(join(directory, "decisions.md")) };
  const phaseIndex = PHASES.indexOf(phase);
  for (const dependency of ["prd", "technical_design", "implementation_spec"]) {
    if (PHASES.indexOf(dependency) < phaseIndex) {
      hashes[dependency] = fileHash(join(directory, PHASE_FILES[dependency]));
    }
  }
  if (phase === "verification") {
    hashes.implementation = task.phase === "done"
      ? task.checkpoints.implementation?.content_hash || null
      : phaseSnapshot(task, directory, "implementation").content_hash;
  }
  hashes.memory = memoryDependencyHashes(
    memorySourceFiles(directory, phase),
    ROOT,
  );
  return hashes;
}

function memorySourceFiles(directory, phase) {
  const effectivePhase = phase === "done" ? "verification" : phase;
  const phaseIndex = PHASES.indexOf(effectivePhase);
  const files = [join(directory, "decisions.md")];
  for (const [candidate, file] of Object.entries(PHASE_FILES)) {
    if (PHASES.indexOf(candidate) <= phaseIndex) {
      files.push(join(directory, file));
    }
  }
  return files;
}

function memoryDependencyErrors(directory, phase) {
  return Object.entries(
    memoryDependencyHashes(memorySourceFiles(directory, phase), ROOT),
  )
    .filter(([, hash]) => hash === null)
    .map(([path]) => "长期记忆依赖不存在：" + path);
}

function phaseSnapshot(task, directory, phase) {
  if (PHASE_FILES[phase]) {
    return {
      artifact: PHASE_FILES[phase],
      content_hash: fileHash(join(directory, PHASE_FILES[phase])),
      dependency_hashes: phaseDependencies(task, directory, phase),
    };
  }
  if (phase === "implementation") {
    const repositories = task.delivery.repositories.map((repository) => {
      try {
        const state = repositoryState(realpathSync(repository.canonical_root));
        return {
          id: String(repository.id),
          state_hash: state.state_hash,
          branch: state.branch,
        };
      } catch {
        return { id: String(repository.id), state_hash: null, branch: null };
      }
    });
    return {
      artifact: null,
      content_hash: fingerprint({
        repositories,
        slices: task.slices.map((slice) => ({
          id: slice.id,
          status: slice.status,
          blocked_by: slice.blocked_by,
        })),
      }),
      dependency_hashes: phaseDependencies(task, directory, phase),
    };
  }
  return { artifact: null, content_hash: null, dependency_hashes: {} };
}

function checkpointIdentity(phase, checkpoint) {
  return fingerprint({
    phase,
    artifact: checkpoint.artifact ?? null,
    content_hash: checkpoint.content_hash ?? null,
    dependency_hashes: checkpoint.dependency_hashes || {},
  });
}

function checkpointState(task, directory, phase) {
  const checkpoint = task.checkpoints[phase];
  const approval = task.approvals[phase];
  if (!checkpoint || !approval) {
    return "missing";
  }
  const current = task.phase === "done" && phase === "implementation"
    ? {
        artifact: null,
        content_hash: checkpoint.content_hash,
        dependency_hashes: phaseDependencies(task, directory, phase),
      }
    : phaseSnapshot(task, directory, phase);
  const identity = checkpointIdentity(phase, checkpoint);
  if (
    checkpoint.content_hash !== current.content_hash ||
    fingerprint(checkpoint.dependency_hashes || {}) !==
      fingerprint(current.dependency_hashes || {}) ||
    approval.checkpoint_hash !== identity
  ) {
    return "stale";
  }
  return "fresh";
}

function recordCheckpoint(task, directory, phase) {
  const now = new Date().toISOString();
  const snapshot = phaseSnapshot(task, directory, phase);
  const checkpoint = {
    ...snapshot,
    recorded_at: now,
    revision: task.revision + 1,
  };
  task.checkpoints[phase] = checkpoint;
  task.approvals[phase] = {
    status: "confirmed",
    confirmed_at: now,
    checkpoint_hash: checkpointIdentity(phase, checkpoint),
    revision: task.revision + 1,
  };
}

function invalidateFrom(task, phase) {
  const start = PHASES.indexOf(phase);
  for (const candidate of PHASES) {
    if (PHASES.indexOf(candidate) >= start) {
      delete task.checkpoints[candidate];
      delete task.approvals[candidate];
    }
  }
  if (start <= PHASES.indexOf("implementation")) {
    for (const repository of task.delivery.repositories) {
      repository.verification_tree = null;
      repository.commits = [];
      repository.final_head = null;
      delete repository.remaining_dirty_paths;
      delete repository.finalized_at;
    }
  }
}

function artifactStates(task, directory, acceptanceIds) {
  const result = {};
  for (const phase of [
    "prd",
    "technical_design",
    "implementation_spec",
    "implementation",
    "verification",
  ]) {
    const document = phaseDocumentValidation(directory, phase, acceptanceIds);
    result[phase] = {
      ...document,
      checkpoint: checkpointState(task, directory, phase),
    };
    if (phase === "implementation") {
      const slices = sliceValidation(task.slices);
      const repositories = deliveryRepositoryValidation(task);
      result[phase].valid = slices.valid && repositories.valid;
      result[phase].errors = [...slices.errors, ...repositories.errors];
      result[phase].hash = phaseSnapshot(task, directory, phase).content_hash;
    }
  }
  return result;
}

function uniqueErrors(errors) {
  return [...new Set(errors.filter(Boolean))];
}

function gateForPhase(task, directory, phase, artifacts) {
  const blockers = [];
  const phaseIndex = PHASES.indexOf(phase);
  if (phaseIndex < 0 && phase !== "cancelled") {
    blockers.push("任务 phase 无效：" + phase);
    return blockers;
  }
  const requiredCheckpoints = [];
  if (phaseIndex >= PHASES.indexOf("technical_design")) {
    requiredCheckpoints.push("prd");
  }
  if (phaseIndex >= PHASES.indexOf("implementation_spec")) {
    requiredCheckpoints.push("technical_design");
  }
  if (phaseIndex >= PHASES.indexOf("implementation")) {
    requiredCheckpoints.push("implementation_spec");
  }
  if (phaseIndex >= PHASES.indexOf("verification")) {
    requiredCheckpoints.push("implementation");
  }
  if (phaseIndex >= PHASES.indexOf("done")) {
    requiredCheckpoints.push("verification");
  }
  for (const checkpointPhase of requiredCheckpoints) {
    const state = artifacts[checkpointPhase]?.checkpoint || "missing";
    if (state !== "fresh") {
      blockers.push("阶段 checkpoint " + checkpointPhase + " 为 " + state);
    }
  }
  const artifactPhase = phase === "done" ? "verification" : phase;
  if (artifacts[artifactPhase] && !artifacts[artifactPhase].valid) {
    blockers.push(...artifacts[artifactPhase].errors);
  }
  if (phase === "implementation") {
    const slices = sliceValidation(task.slices);
    const incomplete = slices.slices
      .filter((slice) => slice.status !== "done")
      .map((slice) => slice.id);
    if (incomplete.length) {
      blockers.push("进入 verification 前必须完成所有 Slice：" + incomplete.join(", "));
    }
  }
  if (phase === "verification" || phase === "done") {
    const failed = artifacts.verification.acceptance
      .filter((item) => item.status === "failed" || item.status === "unverified")
      .map((item) => item.id + "=" + item.status);
    if (failed.length) {
      blockers.push("验收项尚未通过或豁免：" + failed.join(", "));
    }
  }
  if (phase === "done") {
    blockers.push(...deliveryRepositoryValidation(task, { requireFinal: true }).errors);
  }
  return uniqueErrors(blockers);
}

function nextActionFor(task, ready, blockers) {
  if (task.phase === "done") {
    return ready ? "任务已完成" : "修复已完成任务的完整性问题";
  }
  if (task.phase === "cancelled") {
    return "任务已取消；需要时显式重开";
  }
  if (!ready) {
    return blockers[0] || "补齐当前阶段产物";
  }
  const next = PHASES[PHASES.indexOf(task.phase) + 1];
  return next ? "确认当前产物并推进到 " + next : "";
}

function validateTaskObject(task, directory, requestedPhase) {
  const prd = phaseDocumentValidation(directory, "prd");
  const acceptanceIds = prd.acceptance_ids;
  const artifacts = artifactStates(task, directory, acceptanceIds);
  const selection = repositorySelectionValidation(task);
  let blockers = [...selection.errors];
  if (task.phase === "cancelled" && requestedPhase === "cancelled") {
    blockers.push("任务已取消");
  } else {
    blockers.push(...gateForPhase(task, directory, requestedPhase, artifacts));
    blockers.push(...memoryDependencyErrors(directory, requestedPhase));
  }
  blockers = uniqueErrors(blockers);
  const ready = blockers.length === 0;
  return { artifacts, acceptanceIds, blockers, ready };
}

function inspectTask(reference, options = {}) {
  const directory = resolveTask(reference);
  const task = parseTaskData(readJson(join(directory, "task.json")));
  const requestedPhase = String(options.phase || task.phase);
  return {
    directory,
    task,
    ...validateTaskObject(task, directory, requestedPhase),
  };
}

export function validateTask(reference, options = {}) {
  const inspected = inspectTask(reference, options);
  return {
    valid: inspected.ready,
    path: relative(ROOT, inspected.directory).replaceAll("\\", "/"),
    phase: String(options.phase || inspected.task.phase),
    revision: inspected.task.revision,
    blockers: inspected.blockers,
    acceptance_ids: inspected.acceptanceIds,
    artifacts: inspected.artifacts,
    repositories: inspected.task.delivery.repositories,
    slices: inspected.task.slices,
  };
}

export function taskStatus(reference) {
  const inspected = inspectTask(reference);
  const repositoryStatuses = inspected.task.delivery.repositories.map((repository) => ({
    id: repository.id,
    canonical_root: repository.canonical_root,
    branch: repository.branch,
    baseline_head: repository.baseline_head,
    initial_dirty_paths: repository.initial_dirty_paths,
    captured_at: repository.captured_at,
    commits: repository.commits,
    final_head: repository.final_head,
    verification_tree: repository.verification_tree,
  }));
  return {
    path: relative(ROOT, inspected.directory).replaceAll("\\", "/"),
    phase: inspected.task.phase,
    revision: inspected.task.revision,
    ready: inspected.ready,
    nextAction: nextActionFor(inspected.task, inspected.ready, inspected.blockers),
    blockers: inspected.blockers,
    artifacts: inspected.artifacts,
    repositories: repositoryStatuses,
    slices: inspected.task.slices,
  };
}

function assertConfirmed(options) {
  if (options.confirmed !== true) {
    throw new Error("向前推进阶段需要用户明确确认，并添加 --confirmed");
  }
}

function assertTaskGate(task, directory, phase) {
  const validation = validateTaskObject(task, directory, phase);
  if (!validation.ready) {
    throw new Error("阶段产物未通过完整性检查：" + validation.blockers.join("；"));
  }
}

export function canTransition(from, to, reason = "") {
  if (TERMINAL_PHASES.has(from) || to === "cancelled") {
    return false;
  }
  const fromIndex = PHASES.indexOf(from);
  const toIndex = PHASES.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || from === to) {
    return false;
  }
  if (toIndex === fromIndex + 1) {
    return true;
  }
  return toIndex < fromIndex && Boolean(String(reason).trim());
}

function phaseTemplate(phase, title, acceptanceIds = []) {
  if (phase === "technical_design") {
    return "# 技术方案\n\n## 目标与非目标\n\n## 当前实现与证据\n\n## 总体设计\n\n## 数据模型与 DDL\n\n## API 与调用方\n\n## 后端实现\n\n## Web/小程序实现\n\n## 权限与安全\n\n## 配置、环境与联调\n\n## 可观测性\n\n## 跨仓库依赖与顺序\n\n## 迁移、发布与回滚\n\n## 测试和验证策略\n\n## 风险与未决问题\n";
  }
  if (phase === "implementation_spec") {
    return "# 实施方案\n\n## 本轮实施基线\n\n## 实施顺序与依赖\n\n## 按仓库的修改计划\n\n## 数据库与配置动作\n\n## 验收标准到验证的映射\n\n## 测试与联调\n\n## 项目文档同步\n\n## Slices\n\n## 风险和停止条件\n";
  }
  if (phase === "verification") {
    const acceptance = acceptanceIds.length
      ? acceptanceIds
          .map(
            (id) =>
              "### " + id + "\n\n状态：unverified\n\n证据：\n",
          )
          .join("\n")
      : "";
    return "# 验证记录\n\n## 验收项与证据\n\n" + acceptance + "\n## 仓库检查\n\n## 集成验证\n\n## 数据库验证\n\n## UI 证据\n\n## 项目文档同步\n\n## 提交范围\n\n## 未验证项与残余风险\n";
  }
  return "# " + title + "\n";
}

export function createTask(options = {}) {
  const iteration = resolveIteration(String(options.iteration || ""));
  if (!options.title || !options.summary) {
    throw new Error("task create 需要 --iteration、--title 和 --summary");
  }
  const type = String(options.type || "feature");
  if (!TASK_TYPES.includes(type)) {
    throw new Error("任务类型必须是: " + TASK_TYPES.join(", "));
  }
  const repositories = optionList(options.repositories);
  const repositoryValidation = repositorySelectionValidation({ repositories });
  if (repositoryValidation.errors.length) {
    throw new Error(repositoryValidation.errors.join("；"));
  }
  return withFileLocks([iterationLockPath(iteration)], () => {
    const iterationJson = parseIterationData(
      readJson(join(iteration, "iteration.json")),
      iteration,
    );
    if (iterationJson.status !== "open") {
      throw new Error("只能在开放迭代中创建任务");
    }
    const baseId = today() + "-" + slugify(options.slug || options.title, "task");
    const id = uniqueDirectory(iteration, baseId);
    const directory = join(iteration, id);
    mkdirSync(directory);
    writeJson(join(directory, "task.json"), {
      schema_version: TASK_SCHEMA_VERSION,
      revision: 0,
      title: String(options.title),
      summary: String(options.summary),
      type,
      phase: "prd",
      repositories,
      modules: optionList(options.modules),
      related_tasks: optionList(options.related),
      slices: [],
      checkpoints: {},
      approvals: {},
      delivery: { repositories: [] },
    });
    writeText(
      join(directory, "prd.md"),
      "# " +
        options.title +
        "\n\n## 背景与原始需求\n\n" +
        options.summary +
        "\n\n## 目标\n\n## 非目标\n\n## 用户与场景\n\n## 范围和业务规则\n\n## 异常与边界\n\n## 验收标准\n\n## 约束与依赖\n\n## 未决问题\n",
    );
    writeText(join(directory, "decisions.md"), "# 决策记录\n");
    console.log(relative(ROOT, directory));
    return directory;
  });
}

export function transitionTask(reference, phase, options = {}) {
  const result = mutateTask(reference, options, (task, directory) => {
    const reason = options.reason === true ? "" : String(options.reason || "");
    if (!canTransition(task.phase, phase, reason)) {
      throw new Error("非法阶段转换: " + task.phase + " -> " + phase);
    }
    const forward = PHASES.indexOf(phase) > PHASES.indexOf(task.phase);
    if (forward) {
      assertConfirmed(options);
      if (task.phase === "verification") {
        finalizeDelivery(task, options.commit);
        assertTaskGate(task, directory, "implementation");
        recordCheckpoint(task, directory, "implementation");
      }
      assertTaskGate(task, directory, task.phase);
      recordCheckpoint(task, directory, task.phase);
      if (task.phase === "implementation_spec") {
        captureRepositories(task);
      }
    } else {
      invalidateFrom(task, phase);
    }
    task.phase = phase;
    const file = PHASE_FILES[phase];
    if (file) {
      const document = join(directory, file);
      if (!existsSync(document)) {
        const acceptanceIds = phase === "verification"
          ? phaseDocumentValidation(directory, "prd").acceptance_ids
          : [];
        writeText(document, phaseTemplate(phase, task.title, acceptanceIds));
      }
    }
  });
  console.log(result.task.phase);
}

export function cancelTask(reference, options = {}) {
  if (options.confirmed !== true || !options.reason || options.reason === true) {
    throw new Error("取消任务需要 --reason 和 --confirmed");
  }
  mutateTask(reference, options, (task) => {
    if (TERMINAL_PHASES.has(task.phase)) {
      throw new Error("任务已处于终态");
    }
    task.cancelled_from = task.phase;
    task.phase = "cancelled";
    task.closure_reason = String(options.reason);
    task.closed_at = new Date().toISOString();
  });
  console.log("cancelled");
}

export function reopenTask(reference, phase, options = {}) {
  if (options.confirmed !== true || !options.reason || options.reason === true) {
    throw new Error("重开任务需要 --reason 和显式 confirmed=true");
  }
  const result = mutateTask(reference, options, (task, directory) => {
    if (!TERMINAL_PHASES.has(task.phase)) {
      throw new Error("只有 done/cancelled 任务可以显式重开");
    }
    if (!PHASES.includes(phase) || phase === "done") {
      throw new Error("重开目标阶段必须是 prd 到 verification");
    }
    const iterationDirectory = dirname(directory);
    const iteration = parseIterationData(
      readJson(join(iterationDirectory, "iteration.json")),
      iterationDirectory,
    );
    if (iteration.status !== "open") {
      throw new Error("已结束迭代中的任务不能重开；请在新迭代创建关联任务");
    }
    task.reopen_history = Array.isArray(task.reopen_history)
      ? task.reopen_history
      : [];
    task.reopen_history.push({
      from: task.phase,
      to: phase,
      reason: String(options.reason),
      reopened_at: new Date().toISOString(),
    });
    invalidateFrom(task, phase);
    task.phase = phase;
    delete task.closure_reason;
    delete task.closed_at;
    delete task.cancelled_from;
  });
  console.log(result.task.phase);
}

export function setTaskSlices(reference, slices, options = {}) {
  if (!Array.isArray(slices)) {
    throw new Error("slices 必须是数组");
  }
  const result = mutateTask(reference, options, (task) => {
    if (task.phase !== "implementation_spec") {
      throw new Error("只能在 implementation_spec 阶段定义 Slices");
    }
    const validation = sliceValidation(slices);
    if (!validation.valid) {
      throw new Error("Slices 无效：" + validation.errors.join("；"));
    }
    if (validation.slices.some((slice) => slice.status !== "pending")) {
      throw new Error("定义 Slices 时初始状态必须全部为 pending");
    }
    task.slices = validation.slices;
  });
  return result.task.slices;
}

export function transitionSlice(reference, id, status, options = {}) {
  if (!SLICE_STATUSES.includes(status)) {
    throw new Error("Slice 状态必须是: " + SLICE_STATUSES.join(", "));
  }
  const result = mutateTask(reference, options, (task) => {
    if (task.phase !== "implementation") {
      throw new Error("只能在 implementation 阶段更新 Slice 状态");
    }
    const validation = sliceValidation(task.slices);
    if (!validation.valid) {
      throw new Error("Slices 无效：" + validation.errors.join("；"));
    }
    task.slices = validation.slices;
    const slice = task.slices.find((candidate) => candidate.id === id);
    if (!slice) {
      throw new Error("找不到 Slice：" + id);
    }
    const allowed =
      (slice.status === "pending" && status === "in_progress") ||
      (slice.status === "in_progress" && status === "done");
    if (!allowed) {
      throw new Error("非法 Slice 状态转换：" + slice.status + " -> " + status);
    }
    if (status === "in_progress") {
      if (task.slices.some((candidate) => candidate.status === "in_progress")) {
        throw new Error("最多只能有一个 in_progress Slice");
      }
      const blockers = slice.blocked_by.filter(
        (dependency) =>
          task.slices.find((candidate) => candidate.id === dependency)?.status !== "done",
      );
      if (blockers.length) {
        throw new Error("Slice blocker 尚未完成：" + blockers.join(", "));
      }
    }
    slice.status = status;
  });
  const slice = result.task.slices.find((candidate) => candidate.id === id);
  console.log(slice.status);
  return slice;
}

function taskReferences(taskDirectory) {
  const id = basename(taskDirectory);
  const rel = relative(ROOT, taskDirectory).replaceAll("\\", "/");
  return listTaskDirectories().filter((directory) => {
    if (directory === taskDirectory) {
      return false;
    }
    const related = parseTaskData(
      readJson(join(directory, "task.json")),
    ).related_tasks;
    return related.includes(id) || related.includes(rel);
  });
}

function taskHasCommit(taskDirectory) {
  return pathHasCommit(taskDirectory);
}

export function deleteTask(reference, options = {}) {
  const directory = resolveTask(reference);
  function assertDeletable() {
    const task = parseTaskData(readJson(join(directory, "task.json")));
    assertExpectedRevision(task, options);
    const allowedFiles = new Set(["task.json", "prd.md", "decisions.md"]);
    const extra = readdirSync(directory).filter((name) => !allowedFiles.has(name));
    const references = taskReferences(directory);
    if (
      task.phase !== "prd" ||
      taskHasCommit(directory) ||
      references.length ||
      extra.length
    ) {
      throw new Error(
        "任务不满足安全删除条件；请改为标记 cancelled。条件：未提交、仍在 prd、无引用、无实施产物",
      );
    }
  }
  assertDeletable();
  console.log((options.apply === true ? "删除: " : "将删除: ") + relative(ROOT, directory));
  if (options.apply !== true) {
    console.log("确认后添加 --apply。");
    return;
  }
  const iterationLocks = listIterationDirectories().map((iteration) =>
    iterationLockPath(iteration),
  );
  withFileLocks(
    [join(ITERATIONS_DIR, ".iterations.lock"), ...iterationLocks, taskLockPath(directory)],
    () => {
      assertDeletable();
      rmSync(ensureWithin(ITERATIONS_DIR, directory), {
        recursive: true,
        force: false,
      });
    },
  );
}

export function moveTask(reference, options = {}) {
  const source = resolveTask(reference);
  const destinationIteration = resolveIteration(String(options.iteration || ""));
  const destination = join(destinationIteration, basename(source));
  function currentTask() {
    const task = parseTaskData(readJson(join(source, "task.json")));
    assertExpectedRevision(task, options);
    const sourceIterationDirectory = dirname(source);
    const sourceIteration = parseIterationData(
      readJson(join(sourceIterationDirectory, "iteration.json")),
      sourceIterationDirectory,
    );
    const destinationJson = parseIterationData(
      readJson(join(destinationIteration, "iteration.json")),
      destinationIteration,
    );
    if (TERMINAL_PHASES.has(task.phase)) {
      throw new Error("终态任务不能移动");
    }
    if (sourceIteration.status !== "open" || destinationJson.status !== "open") {
      throw new Error("任务只能在开放迭代之间移动");
    }
    if (existsSync(destination)) {
      throw new Error("目标任务目录已存在");
    }
    return task;
  }
  currentTask();
  ensureWithin(ITERATIONS_DIR, source);
  ensureWithin(ITERATIONS_DIR, destination);
  console.log(
    (options.apply === true ? "移动: " : "将移动: ") +
      relative(ROOT, source) +
      " -> " +
      relative(ROOT, destination),
  );
  if (options.apply !== true) {
    console.log("确认后添加 --apply。");
    return;
  }
  withFileLocks(
    [
      iterationLockPath(dirname(source)),
      iterationLockPath(destinationIteration),
      taskLockPath(source),
    ],
    () => {
      const task = currentTask();
      task.schema_version = TASK_SCHEMA_VERSION;
      task.revision += 1;
      writeJson(join(source, "task.json"), task);
      const tracked = taskHasCommit(source);
      if (tracked && isGitRepository(ROOT)) {
        runGit(["mv", relative(ROOT, source), relative(ROOT, destination)], ROOT);
      } else {
        renameSync(source, destination);
      }
    },
  );
}

function uncommittedTaskPaths() {
  if (!isGitRepository(ROOT)) {
    return new Set(listTaskDirectories().map((path) => resolve(path)));
  }
  const status = runGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
      "--",
      "iterations",
    ],
    ROOT,
    true,
    true,
  );
  const paths = new Set();
  for (const line of status.split("\0").filter(Boolean)) {
    const raw = line.slice(3).replaceAll("\\", "/");
    const parts = raw.split("/");
    if (parts[0] === "iterations" && parts.length >= 3) {
      const candidate = join(ROOT, parts[0], parts[1], parts[2]);
      if (existsSync(join(candidate, "task.json"))) {
        paths.add(resolve(candidate));
      }
    }
  }
  return paths;
}

function gitTaskMetadata(directory) {
  if (!isGitRepository(ROOT)) {
    return { updatedAt: null, authorEmail: null };
  }
  const rel = relative(ROOT, directory);
  const updatedAt = runGit(["log", "-1", "--format=%cI", "--", rel], ROOT, true);
  const authors = runGit(
    [
      "log",
      "--diff-filter=A",
      "--follow",
      "--format=%ae",
      "--",
      join(rel, "task.json"),
    ],
    ROOT,
    true,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    updatedAt: updatedAt || null,
    authorEmail: authors.at(-1) || null,
  };
}

export function taskCandidates() {
  const local = uncommittedTaskPaths();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const directory of listTaskDirectories()) {
    const iterationDirectory = dirname(directory);
    const iteration = parseIterationData(
      readJson(join(iterationDirectory, "iteration.json")),
      iterationDirectory,
    );
    const task = parseTaskData(readJson(join(directory, "task.json")));
    if (
      iteration.status !== "open" ||
      task.phase === "cancelled" ||
      task.phase === "done"
    ) {
      continue;
    }
    const metadata = gitTaskMetadata(directory);
    const source = local.has(resolve(directory)) ? "local" : "git";
    if (
      source !== "local" &&
      (!metadata.updatedAt || new Date(metadata.updatedAt).getTime() < cutoff)
    ) {
      continue;
    }
    candidates.push({
      path: relative(ROOT, directory).replaceAll("\\", "/"),
      title: task.title,
      summary: task.summary,
      phase: task.phase,
      repositories: task.repositories,
      modules: task.modules,
      source,
      ...metadata,
    });
  }
  return candidates.sort(
    (left, right) =>
      Number(right.source === "local") - Number(left.source === "local") ||
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) ||
      left.path.localeCompare(right.path),
  );
}
