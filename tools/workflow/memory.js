import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  ROOT,
  assertNoSecrets,
  ensureWithin,
  fileHash,
  readJson,
  readText,
  replaceTextBlock,
  withFileLocks,
  writeJson,
  writeText,
} from "./common.js";

export const MEMORY_SCHEMA_VERSION = 1;
export const TERMS_START = "<!-- spec-driven:terms:start -->";
export const TERMS_END = "<!-- spec-driven:terms:end -->";
export const ADR_INDEX_START = "<!-- spec-driven:adr-index:start -->";
export const ADR_INDEX_END = "<!-- spec-driven:adr-index:end -->";

const MEMORY_FIELDS = new Set(["schema_version", "revision", "terms", "adrs"]);
const TERM_FIELDS = new Set(["name", "definition", "avoid"]);
const ADR_FIELDS = new Set([
  "id",
  "file",
  "title",
  "status",
  "scope",
  "summary",
  "source_task",
]);
const ADR_ID_PATTERN = /^ADR-(\d{4})$/;
const ADR_FILE_PATTERN = /^adr\/(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const ADR_STATUS_PATTERN = /^(?:accepted|deprecated|superseded by ADR-\d{4})$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw new Error(label + " 包含未知字段：" + unknown.join("、"));
  }
}

function normalizedText(value, label) {
  const text = String(value || "").trim();
  if (!text || /[\r\n]/.test(text)) {
    throw new Error(label + " 必须是非空单行文本");
  }
  return text;
}

function normalizedScope(value) {
  const scopes = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !scopes.length ||
    scopes.some(
      (scope) =>
        scope !== "project" &&
        !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:\/[A-Za-z0-9._/-]+)?$/.test(
          scope,
        ),
    )
  ) {
    throw new Error("ADR scope 必须是 project 或 repo-id[/module] 列表");
  }
  return scopes.join(", ");
}

function validateTerms(terms) {
  if (!Array.isArray(terms)) {
    throw new Error("memory.json 的 terms 必须是数组");
  }
  const names = new Set();
  const normalized = terms.map((term) => {
    if (!isObject(term)) {
      throw new Error("memory.json 的 term 必须是对象");
    }
    rejectUnknown(term, TERM_FIELDS, "memory.json 的 term");
    const name = normalizedText(term.name, "专业术语名称");
    const definition = normalizedText(term.definition, "专业术语定义");
    if (names.has(name)) {
      throw new Error("memory.json 包含重复专业术语：" + name);
    }
    names.add(name);
    if (!Array.isArray(term.avoid)) {
      throw new Error("专业术语 avoid 必须是数组");
    }
    const avoid = [...new Set(term.avoid.map((item) => normalizedText(item, "避免用语")))];
    return { name, definition, avoid };
  });
  for (const term of normalized) {
    const conflict = term.avoid.find((value) => names.has(value));
    if (conflict) {
      throw new Error("避免用语不能同时是规范术语：" + conflict);
    }
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function validateAdrs(adrs) {
  if (!Array.isArray(adrs)) {
    throw new Error("memory.json 的 adrs 必须是数组");
  }
  const ids = new Set();
  const files = new Set();
  const normalized = adrs.map((adr) => {
    if (!isObject(adr)) {
      throw new Error("memory.json 的 ADR 必须是对象");
    }
    rejectUnknown(adr, ADR_FIELDS, "memory.json 的 ADR");
    const id = normalizedText(adr.id, "ADR ID");
    const file = normalizedText(adr.file, "ADR 文件");
    const idMatch = id.match(ADR_ID_PATTERN);
    const fileMatch = file.match(ADR_FILE_PATTERN);
    if (!idMatch || !fileMatch || idMatch[1] !== fileMatch[1]) {
      throw new Error("ADR ID 与文件名不一致：" + id + " / " + file);
    }
    if (ids.has(id) || files.has(file)) {
      throw new Error("memory.json 包含重复 ADR：" + id);
    }
    ids.add(id);
    files.add(file);
    const status = normalizedText(adr.status, "ADR 状态");
    if (!ADR_STATUS_PATTERN.test(status)) {
      throw new Error("ADR 状态无效：" + status);
    }
    return {
      id,
      file,
      title: normalizedText(adr.title, "ADR 标题"),
      status,
      scope: normalizedScope(adr.scope),
      summary: normalizedText(adr.summary, "ADR 摘要"),
      source_task: adr.source_task
        ? normalizedText(adr.source_task, "ADR 来源任务")
        : null,
    };
  });
  for (const adr of normalized) {
    const superseded = adr.status.match(/^superseded by (ADR-\d{4})$/)?.[1];
    if (superseded && !ids.has(superseded)) {
      throw new Error(adr.id + " 引用了不存在的替代 ADR：" + superseded);
    }
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseMemoryData(raw) {
  if (!isObject(raw)) {
    throw new Error("project/memory.json 格式不受支持");
  }
  rejectUnknown(raw, MEMORY_FIELDS, "project/memory.json");
  if (
    raw.schema_version !== MEMORY_SCHEMA_VERSION ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0
  ) {
    throw new Error("project/memory.json schema 或 revision 无效");
  }
  const memory = {
    schema_version: MEMORY_SCHEMA_VERSION,
    revision: raw.revision,
    terms: validateTerms(raw.terms),
    adrs: validateAdrs(raw.adrs),
  };
  assertNoSecrets(memory);
  return memory;
}

export function renderTerms(memory) {
  if (!memory.terms.length) {
    return "当前没有已确认的专业术语。";
  }
  return memory.terms
    .map((term) =>
      [
        "**" + term.name + "**：",
        term.definition,
        ...(term.avoid.length ? ["_避免使用_：" + term.avoid.join("、")] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderAdrIndex(memory) {
  if (!memory.adrs.length) {
    return "当前没有已确认的关键决策。";
  }
  return memory.adrs
    .map(
      (adr) =>
        "- [" + adr.id + " " + adr.title + "](./" + adr.file + ") — " +
        adr.status + " · " + adr.scope + " · " + adr.summary,
    )
    .join("\n");
}

function extractTextBlock(text, start, end) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt < 0 || endAt < startAt) {
    return null;
  }
  return text.slice(startAt + start.length, endAt).trim();
}

function renderContext(context, memory) {
  if (
    extractTextBlock(context, TERMS_START, TERMS_END) === null ||
    extractTextBlock(context, ADR_INDEX_START, ADR_INDEX_END) === null
  ) {
    throw new Error("CONTEXT.md 缺少受管专业术语或 ADR 索引块");
  }
  return replaceTextBlock(
    replaceTextBlock(context, renderTerms(memory), TERMS_START, TERMS_END),
    renderAdrIndex(memory),
    ADR_INDEX_START,
    ADR_INDEX_END,
  );
}

function initialContext(project, memory) {
  return (
    "# " + project.name + "\n\n" +
    project.goal + "\n\n" +
    "## 专业术语\n\n" + TERMS_START + "\n" + renderTerms(memory) + "\n" + TERMS_END +
    "\n\n## 关键决策\n\n" + ADR_INDEX_START + "\n" + renderAdrIndex(memory) + "\n" + ADR_INDEX_END + "\n"
  );
}

function paths(root) {
  return {
    state: join(root, "project", "memory.json"),
    context: join(root, "CONTEXT.md"),
    adrDirectory: join(root, "adr"),
    lock: join(root, ".spec-workflow-memory.lock"),
  };
}

export function initializeMemory(project, root = ROOT) {
  const target = paths(root);
  return withFileLocks([target.lock], () => {
    if (existsSync(target.state)) {
      parseMemoryData(readJson(target.state));
      if (!existsSync(target.context)) {
        throw new Error("project/memory.json 已存在但缺少 CONTEXT.md");
      }
      return;
    }
    if (existsSync(target.context)) {
      throw new Error("CONTEXT.md 已存在但缺少 project/memory.json");
    }
    const memory = {
      schema_version: MEMORY_SCHEMA_VERSION,
      revision: 0,
      terms: [],
      adrs: [],
    };
    mkdirSync(join(root, "project"), { recursive: true });
    const snapshots = [snapshot(target.state), snapshot(target.context)];
    try {
      writeJson(target.state, memory);
      writeText(target.context, initialContext(project, memory));
    } catch (error) {
      for (const old of snapshots.reverse()) {
        restore(old);
      }
      throw error;
    }
  });
}

function expectedRevision(options, required) {
  const raw = options["expected-revision"];
  if (raw === undefined) {
    if (required) {
      throw new Error("写入长期记忆需要 --expected-revision <n>");
    }
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("--expected-revision 必须是非负整数");
  }
  return value;
}

function replaceStatus(content, status) {
  if (!/^状态：.+$/m.test(content)) {
    throw new Error("ADR 正文缺少状态行");
  }
  return content.replace(/^状态：.+$/m, "状态：" + status);
}

function snapshot(path) {
  return existsSync(path)
    ? { path, existed: true, content: readFileSync(path) }
    : { path, existed: false, content: null };
}

function restore(snapshotValue) {
  if (snapshotValue.existed) {
    writeText(snapshotValue.path, snapshotValue.content.toString("utf8"));
  } else {
    rmSync(snapshotValue.path, { force: true });
  }
}

function mutateMemory(root, options, operation, build) {
  const target = paths(root);
  return withFileLocks([target.lock], () => {
    const memory = parseMemoryData(readJson(target.state));
    const expected = expectedRevision(options, options.apply === true);
    if (expected !== null && expected !== memory.revision) {
      throw new Error(
        "长期记忆 revision 冲突：期望 " + expected + "，当前 " + memory.revision,
      );
    }
    const next = structuredClone(memory);
    const writes = build(next, target);
    next.schema_version = MEMORY_SCHEMA_VERSION;
    next.revision += 1;
    const normalized = parseMemoryData(next);
    const context = renderContext(readText(target.context), normalized);
    const plan = {
      operation,
      current_revision: memory.revision,
      next_revision: normalized.revision,
      files: [...new Set([target.context, ...writes.map((item) => item.path), target.state])]
        .map((path) => path.slice(root.length + 1)),
    };
    if (options.apply !== true) {
      return plan;
    }
    const targets = [
      { path: target.context, content: context },
      ...writes,
      { path: target.state, json: normalized },
    ];
    const snapshots = targets.map((item) => snapshot(item.path));
    try {
      for (const item of targets) {
        if (item.json) {
          writeJson(item.path, item.json);
        } else {
          writeText(item.path, item.content);
        }
      }
    } catch (error) {
      for (const old of snapshots.reverse()) {
        restore(old);
      }
      throw error;
    }
    return plan;
  });
}

export function memoryStatus(root = ROOT) {
  return parseMemoryData(readJson(paths(root).state));
}

export function upsertTerm(config, options = {}, root = ROOT) {
  if (!isObject(config)) {
    throw new Error("专业术语配置必须是对象");
  }
  rejectUnknown(config, new Set(["name", "definition", "avoid", "replaces"]), "专业术语配置");
  assertNoSecrets(config);
  const term = validateTerms([
    {
      name: config.name,
      definition: config.definition,
      avoid: config.avoid || [],
    },
  ])[0];
  const replaces = config.replaces
    ? normalizedText(config.replaces, "被替代专业术语")
    : null;
  return mutateMemory(root, options, "term-upsert", (memory) => {
    if (replaces && !memory.terms.some((item) => item.name === replaces)) {
      throw new Error("找不到被替代专业术语：" + replaces);
    }
    memory.terms = memory.terms.filter(
      (item) => item.name !== term.name && item.name !== replaces,
    );
    memory.terms.push(term);
    memory.terms = validateTerms(memory.terms);
    return [];
  });
}

function renderAdr(adr, body) {
  return [
    "# " + adr.title,
    "",
    "状态：" + adr.status,
    "范围：" + adr.scope,
    ...(adr.source_task ? ["来源任务：" + adr.source_task] : []),
    "",
    body.trim(),
  ].join("\n");
}

export function createAdr(config, options = {}, root = ROOT) {
  if (!isObject(config)) {
    throw new Error("ADR 配置必须是对象");
  }
  rejectUnknown(
    config,
    new Set(["title", "slug", "scope", "summary", "body", "source_task", "supersedes"]),
    "ADR 配置",
  );
  assertNoSecrets(config);
  const title = normalizedText(config.title, "ADR 标题");
  const slug = normalizedText(config.slug, "ADR slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("ADR slug 必须是小写 ASCII kebab-case");
  }
  const scope = normalizedScope(config.scope);
  const summary = normalizedText(config.summary, "ADR 摘要");
  const body = String(config.body || "").trim();
  if (!body) {
    throw new Error("ADR body 不能为空");
  }
  const sourceTask = config.source_task
    ? normalizedText(config.source_task, "ADR 来源任务")
    : null;
  const supersedes = config.supersedes
    ? normalizedText(config.supersedes, "被替代 ADR")
    : null;
  return mutateMemory(root, options, "adr-create", (memory, target) => {
    const number = memory.adrs.reduce(
      (maximum, adr) => Math.max(maximum, Number(adr.id.slice(4))),
      0,
    ) + 1;
    if (number > 9999) {
      throw new Error("ADR 编号已耗尽");
    }
    const digits = String(number).padStart(4, "0");
    const adr = {
      id: "ADR-" + digits,
      file: "adr/" + digits + "-" + slug + ".md",
      title,
      status: "accepted",
      scope,
      summary,
      source_task: sourceTask,
    };
    const writes = [];
    if (supersedes) {
      const old = memory.adrs.find((item) => item.id === supersedes);
      if (!old || old.status !== "accepted") {
        throw new Error("只能替代当前 accepted ADR：" + supersedes);
      }
      old.status = "superseded by " + adr.id;
      const oldPath = ensureWithin(root, resolve(root, old.file));
      writes.push({
        path: oldPath,
        content: replaceStatus(readText(oldPath), old.status),
      });
    }
    memory.adrs.push(adr);
    memory.adrs = validateAdrs(memory.adrs);
    writes.push({
      path: ensureWithin(target.adrDirectory, resolve(root, adr.file)),
      content: renderAdr(adr, body),
    });
    return writes;
  });
}

export function deprecateAdr(config, options = {}, root = ROOT) {
  if (!isObject(config)) {
    throw new Error("ADR 弃用配置必须是对象");
  }
  rejectUnknown(config, new Set(["id", "reason"]), "ADR 弃用配置");
  assertNoSecrets(config);
  const id = normalizedText(config.id, "ADR ID");
  const reason = normalizedText(config.reason, "ADR 弃用原因");
  return mutateMemory(root, options, "adr-deprecate", (memory) => {
    const adr = memory.adrs.find((item) => item.id === id);
    if (!adr || adr.status !== "accepted") {
      throw new Error("只能弃用当前 accepted ADR：" + id);
    }
    adr.status = "deprecated";
    const path = ensureWithin(root, resolve(root, adr.file));
    const content = replaceStatus(readText(path), adr.status).trimEnd() +
      "\n\n弃用原因：" + reason + "\n";
    return [{ path, content }];
  });
}

export function inspectMemory(root = ROOT) {
  const target = paths(root);
  const errors = [];
  const warnings = [];
  if (!existsSync(target.state)) {
    return { errors: ["缺少 project/memory.json"], warnings, memory: null };
  }
  if (!existsSync(target.context)) {
    return { errors: ["缺少项目长期记忆 CONTEXT.md"], warnings, memory: null };
  }
  let memory;
  try {
    memory = parseMemoryData(readJson(target.state));
  } catch (error) {
    return { errors: [error.message], warnings, memory: null };
  }
  const context = readText(target.context);
  if (!/^## 专业术语\s*$/m.test(context) || !/^## 关键决策\s*$/m.test(context)) {
    errors.push("CONTEXT.md 缺少专业术语或关键决策章节");
  }
  if (extractTextBlock(context, TERMS_START, TERMS_END) !== renderTerms(memory)) {
    errors.push("CONTEXT.md 的专业术语与 project/memory.json 不一致");
  }
  if (extractTextBlock(context, ADR_INDEX_START, ADR_INDEX_END) !== renderAdrIndex(memory)) {
    errors.push("CONTEXT.md 的 ADR 索引与 project/memory.json 不一致");
  }
  try {
    assertNoSecrets(context);
  } catch {
    errors.push("CONTEXT.md 含疑似密钥值");
  }

  const expectedFiles = new Set(memory.adrs.map((adr) => basename(adr.file)));
  const entries = existsSync(target.adrDirectory)
    ? readdirSync(target.adrDirectory, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (!entry.isFile() || !expectedFiles.has(entry.name)) {
      errors.push("adr/ 包含未登记文件：" + entry.name);
    }
  }
  for (const adr of memory.adrs) {
    const path = ensureWithin(root, resolve(root, adr.file));
    if (!existsSync(path)) {
      errors.push("缺少 ADR 正文：" + adr.file);
      continue;
    }
    const content = readText(path);
    const expectedSource = adr.source_task ? "来源任务：" + adr.source_task : null;
    if (!content.startsWith("# " + adr.title + "\n")) {
      errors.push(adr.file + " 的标题与 memory.json 不一致");
    }
    if (!content.includes("\n状态：" + adr.status + "\n")) {
      errors.push(adr.file + " 的状态与 memory.json 不一致");
    }
    if (!content.includes("\n范围：" + adr.scope + "\n")) {
      errors.push(adr.file + " 的范围与 memory.json 不一致");
    }
    if (expectedSource && !content.includes("\n" + expectedSource + "\n")) {
      errors.push(adr.file + " 的来源任务与 memory.json 不一致");
    }
    try {
      assertNoSecrets(content);
    } catch {
      errors.push(adr.file + " 含疑似密钥值");
    }
  }
  if (!memory.adrs.length && entries.length) {
    warnings.push("没有已登记 ADR，但 adr/ 不是空目录");
  }
  return { errors, warnings, memory };
}

export function memoryReferencesFromFiles(files, root = ROOT) {
  const references = new Set();
  const pattern = /`(CONTEXT\.md|(?:adr|project)\/[A-Za-z0-9._/-]+\.md)`/g;
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    const content = readText(file);
    for (const match of content.matchAll(pattern)) {
      const relativePath = match[1];
      if (relativePath.includes("..")) {
        throw new Error("长期记忆引用不能包含 ..：" + relativePath);
      }
      ensureWithin(root, resolve(root, relativePath));
      references.add(relativePath);
    }
  }
  return [...references].sort();
}

export function memoryDependencyHashes(files, root = ROOT) {
  return Object.fromEntries(
    memoryReferencesFromFiles(files, root).map((path) => [
      path,
      fileHash(ensureWithin(root, resolve(root, path))),
    ]),
  );
}
