import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  INDEPENDENT_SKILLS,
  SKILLS,
  WORKFLOW_SKILLS,
  assertNoSecrets,
  ensureExistingWithin,
  ensureWithin,
  extractManagedJson,
  fileHash,
  fingerprint,
  parseCliArgs,
  replaceManagedBlock,
  withFileLocks,
  writeText,
} from "../workflow/common.js";
import { installAdapter } from "../workflow/adapter.js";
import { buildContextPaths } from "../workflow/context.js";
import { aggregateRelease } from "../workflow/release.js";
import {
  createAdr,
  deprecateAdr,
  initializeMemory,
  inspectMemory,
  memoryDependencyHashes,
  memoryStatus,
  upsertTerm,
} from "../workflow/memory.js";
import {
  assertRepositoryRegistration,
  assertPortableRepositoryId,
  collectRepositoryConfig,
  inspectRepositoryRoot,
  sanitizeGitRemote,
  validateSetupConfig,
} from "../workflow/setup.js";
import { canTransition, parseTaskData } from "../workflow/tasks.js";
import { isMainModule } from "../workflow.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "spec-driven-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function markdownDocument(title, sections) {
  return [
    "# " + title,
    "",
    ...sections.flatMap(([heading, body]) => [
      "## " + heading,
      "",
      body,
      "",
    ]),
  ].join("\n");
}

test("阶段只能顺序前进，回退必须说明原因", () => {
  assert.equal(canTransition("prd", "technical_design"), true);
  assert.equal(canTransition("prd", "implementation"), false);
  assert.equal(canTransition("verification", "implementation", ""), false);
  assert.equal(
    canTransition("verification", "implementation", "验收发现方案需要调整"),
    true,
  );
  assert.equal(canTransition("cancelled", "prd", "重开"), false);
});

test("上下文 dry-run 不带入其他任务或全部项目知识", (t) => {
  const root = temporaryDirectory(t);
  const task = join(root, "iterations", "i", "task-a");
  mkdirSync(join(root, ".agents", "skills", "sw-prd"), {
    recursive: true,
  });
  mkdirSync(task, { recursive: true });
  mkdirSync(join(root, "project", "repositories"), { recursive: true });
  mkdirSync(join(root, "project", "knowledge"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# A", "utf8");
  writeFileSync(join(root, "AGENTS.local.md"), "# L", "utf8");
  writeFileSync(
    join(root, "CONTEXT.md"),
    "# 项目\n\n## 专业术语\n\n无。\n\n## 关键决策\n\n无。\n",
    "utf8",
  );
  writeFileSync(
    join(root, "project", "index.md"),
    "# 项目索引\n",
    "utf8",
  );
  writeFileSync(
    join(root, "project", "repositories", "backend.md"),
    "# Backend",
    "utf8",
  );
  writeFileSync(
    join(root, "project", "knowledge", "api.md"),
    "# API",
    "utf8",
  );
  const taskData = {
    schema_version: 2,
    revision: 0,
    title: "Task A",
    summary: "测试上下文范围",
    type: "feature",
    phase: "prd",
    repositories: ["backend"],
    modules: [],
    related_tasks: [],
    slices: [],
    checkpoints: {},
    approvals: {},
    delivery: { repositories: [] },
  };
  writeJson(join(task, "task.json"), taskData);
  writeFileSync(
    join(root, ".agents", "skills", "sw-prd", "SKILL.md"),
    "# S\n\n## 上下文契约\n\n必读：`task.json`、`prd.md`、`decisions.md`。\n\n按需读取：相关项目文档。\n\n初始禁止：其他任务。\n\n输出：当前 PRD。\n",
    "utf8",
  );
  const context = buildContextPaths("sw-prd", task, root);
  assert.ok(context.required.includes("iterations/i/task-a/prd.md"));
  assert.ok(context.required.includes("AGENTS.local.md"));
  assert.ok(context.required.includes("CONTEXT.md"));
  assert.ok(context.required.includes("project/index.md"));
  assert.ok(context.required.includes("project/repositories/backend.md"));
  assert.ok(!context.required.includes("project/knowledge/api.md"));
  assert.deepEqual(context.missing, [
    "iterations/i/task-a/prd.md",
    "iterations/i/task-a/decisions.md",
  ]);
  assert.ok(!context.required.some((path) => path.includes("other-task")));
  assert.deepEqual(
    context.required.filter((path) => path.startsWith("project/knowledge/")),
    [],
  );
  mkdirSync(join(root, ".agents", "skills", "code-review"), {
    recursive: true,
  });
  writeFileSync(
    join(root, ".agents", "skills", "code-review", "SKILL.md"),
    "# 代码审查\n\n必读：用户提供的审查范围。\n",
    "utf8",
  );
  const reviewContext = buildContextPaths("code-review", null, root);
  assert.ok(reviewContext.required.includes("AGENTS.md"));
  assert.ok(!reviewContext.required.includes("CONTEXT.md"));
  assert.ok(!reviewContext.required.includes("AGENTS.local.md"));
  writeFileSync(
    join(task, "decisions.md"),
    "审查依据：`project/repositories/backend.md`。\n",
    "utf8",
  );
  const taskReviewContext = buildContextPaths("code-review", task, root);
  assert.ok(taskReviewContext.required.includes("CONTEXT.md"));
  assert.ok(taskReviewContext.required.includes("project/index.md"));
  assert.ok(
    taskReviewContext.required.includes("project/repositories/backend.md"),
  );
  const outside = temporaryDirectory(t);
  const linkedPrd = join(task, "prd.md");
  symlinkSync(
    outside,
    linkedPrd,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => buildContextPaths("sw-prd", task, root),
    /路径超出/,
  );
  rmSync(linkedPrd, { recursive: true, force: true });
  writeJson(join(task, "task.json"), {
    ...taskData,
    repositories: ["../outside"],
  });
  assert.throws(
    () => buildContextPaths("sw-prd", task, root),
    /路径超出/,
  );
});

test("CLI 参数严格区分布尔和值选项", () => {
  assert.deepEqual(parseCliArgs(["doctor", "--json"]), {
    positionals: ["doctor"],
    options: { json: true },
  });
  assert.deepEqual(parseCliArgs(["change", "add", "--commit", "a=1", "--commit", "b=2"]), {
    positionals: ["change", "add"],
    options: { commit: ["a=1", "b=2"] },
  });
  assert.throws(() => parseCliArgs(["doctor", "--json", "false"]), /不接受/);
  assert.throws(() => parseCliArgs(["setup", "--config"]), /缺少值/);
  assert.throws(() => parseCliArgs(["setup", "--detailed"]), /未知选项/);
  assert.throws(() => parseCliArgs(["doctor", "--unknown"]), /未知选项/);
});

test("原子写入替换内容且不遗留临时文件", (t) => {
  const root = temporaryDirectory(t);
  const path = join(root, "state.json");
  writeText(path, "first");
  writeText(path, "second");
  assert.equal(readFileSync(path, "utf8"), "second\n");
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".spec-workflow-")),
    [],
  );
  if (process.platform !== "win32") {
    chmodSync(path, 0o660);
    writeText(path, "third");
    assert.equal(statSync(path).mode & 0o777, 0o660);
  }
});

test("文本 hash 忽略平台换行差异", (t) => {
  const root = temporaryDirectory(t);
  const path = join(root, "artifact.md");
  writeFileSync(path, "# Title\n\nContent\n", "utf8");
  const lfHash = fileHash(path);
  writeFileSync(path, "# Title\r\n\r\nContent\r\n", "utf8");
  assert.equal(fileHash(path), lfHash);
});

test("长期记忆 CLI 状态使用 revision 串行化并驱动引用 hash", (t) => {
  const root = temporaryDirectory(t);
  mkdirSync(join(root, "project"), { recursive: true });
  initializeMemory({ name: "测试项目", goal: "验证长期记忆" }, root);
  assert.equal(memoryStatus(root).revision, 0);

  const term = {
    name: "订单",
    definition: "用户确认后进入履约流程的购买意图。",
    avoid: ["交易单"],
  };
  const preview = upsertTerm(term, {}, root);
  assert.equal(preview.current_revision, 0);
  assert.equal(memoryStatus(root).terms.length, 0);
  upsertTerm(term, { apply: true, "expected-revision": "0" }, root);
  assert.equal(memoryStatus(root).revision, 1);
  assert.throws(
    () => upsertTerm(term, { apply: true, "expected-revision": "0" }, root),
    /revision 冲突/,
  );

  const adrConfig = {
    title: "服务端决定身份归属",
    slug: "server-owned-identity",
    scope: "backend/auth",
    summary: "客户端不得声明用户或租户归属。",
    body: "身份归属由服务端可信会话决定，避免客户端伪造。",
  };
  createAdr(adrConfig, { apply: true, "expected-revision": "1" }, root);
  const memory = memoryStatus(root);
  assert.equal(memory.revision, 2);
  assert.equal(memory.adrs[0].id, "ADR-0001");
  assert.deepEqual(inspectMemory(root).errors, []);

  const taskDoc = join(root, "spec.md");
  writeFileSync(taskDoc, "依赖 `adr/0001-server-owned-identity.md`。\n", "utf8");
  const before = memoryDependencyHashes([taskDoc], root);
  const adrPath = join(root, "adr", "0001-server-owned-identity.md");
  const original = readFileSync(adrPath, "utf8");
  writeFileSync(adrPath, original + "\n补充约束。\n", "utf8");
  const after = memoryDependencyHashes([taskDoc], root);
  assert.notEqual(
    before["adr/0001-server-owned-identity.md"],
    after["adr/0001-server-owned-identity.md"],
  );
  writeFileSync(adrPath, original.replace("范围：backend/auth", "范围：frontend"), "utf8");
  assert.match(inspectMemory(root).errors.join("；"), /范围与 memory\.json 不一致/);
  writeFileSync(adrPath, original, "utf8");

  createAdr(
    {
      title: "会话决定身份归属",
      slug: "session-owned-identity",
      scope: "backend/auth",
      summary: "身份归属改由可信会话统一决定。",
      body: "可信会话成为唯一身份来源。",
      supersedes: "ADR-0001",
    },
    { apply: true, "expected-revision": "2" },
    root,
  );
  assert.equal(memoryStatus(root).adrs[0].status, "superseded by ADR-0002");
  deprecateAdr(
    { id: "ADR-0002", reason: "项目不再包含身份系统。" },
    { apply: true, "expected-revision": "3" },
    root,
  );
  assert.equal(memoryStatus(root).adrs[1].status, "deprecated");
  assert.deepEqual(inspectMemory(root).errors, []);
});

test("文件锁拒绝活跃竞争并自动回收死亡进程锁", (t) => {
  const root = temporaryDirectory(t);
  const lock = join(root, "state.lock");
  withFileLocks([lock], () => {
    assert.throws(() => withFileLocks([lock], () => {}), /另一个进程/);
  });
  writeJson(lock, { pid: 2147483647, created_at: new Date().toISOString() });
  assert.doesNotThrow(() => withFileLocks([lock], () => {}));
});

test("主入口判断解析符号链接与 macOS 临时目录别名", (t) => {
  const root = temporaryDirectory(t);
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  mkdirSync(realDirectory);
  writeFileSync(join(realDirectory, "entry.js"), "", "utf8");
  symlinkSync(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  const throughAlias = join(aliasDirectory, "entry.js");
  const canonical = realpathSync.native(throughAlias);
  assert.equal(isMainModule(pathToFileURL(throughAlias).href, canonical), true);
});

test("setup 使用 canonical Git 根并拒绝子目录、重复路径和 remote 凭据", async (t) => {
  const root = temporaryDirectory(t);
  const repository = join(root, "repository");
  const alias = join(root, "repository-alias");
  const child = join(repository, "packages", "api");
  mkdirSync(child, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  symlinkSync(
    repository,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const identity = inspectRepositoryRoot(repository);
  assert.equal(inspectRepositoryRoot(alias).path_key, identity.path_key);
  assert.throws(() => inspectRepositoryRoot(child), /根目录/);
  assert.equal(
    sanitizeGitRemote("https://user:secret@example.com/team/repo.git"),
    "https://example.com/team/repo.git",
  );
  for (const id of ["../escape", "API", "con", "com1.log", "repo/child"]) {
    assert.throws(() => assertPortableRepositoryId(id), /仓库 ID/);
  }
  assert.throws(
    () =>
      assertRepositoryRegistration({
        id: "api",
        path: repository,
        remote: "https://user:do-not-echo@example.com/team/repo.git",
      }),
    (error) => /疑似凭据/.test(error.message) && !/do-not-echo/.test(error.message),
  );
  const repositoryConfig = (id, path) => ({
    id,
    path,
    role: "test",
    modules: [],
    start: { command: "unknown", port: null, runtime: null },
    dependencies: { env_var_names: [], config_center: "unknown" },
    integration: { mode: "direct" },
    environments: {
      available: ["local"],
      local_operable: ["local"],
      remote_read: [],
      remote_write: [],
      switch_method: "unknown",
    },
  });
  const validSetupConfig = {
    schema_version: 1,
    project: { name: "test", goal: "test" },
    agent: { id: "codex" },
    repositories: [repositoryConfig("api", repository)],
    permissions: {
      production_write: false,
      deploy: false,
      ddl_execute: false,
    },
  };
  assert.doesNotThrow(() => validateSetupConfig(validSetupConfig));
  assert.throws(
    () => validateSetupConfig({ ...validSetupConfig, workflow_version: "0.1.0" }),
    /未知字段：workflow_version/,
  );
  assert.throws(
    () =>
      validateSetupConfig({
        schema_version: 1,
        project: { name: "test", goal: "test" },
        agent: { id: "codex" },
        repositories: [
          repositoryConfig("api", repository),
          repositoryConfig("api-alias", alias),
        ],
        permissions: {
          production_write: false,
          deploy: false,
          ddl_execute: false,
        },
      }),
    /同一个 Git 仓库根目录/,
  );
  const answers = [
    "",
    "",
    "3100",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ];
  const configured = await collectRepositoryConfig(
    { question: async () => answers.shift() },
    {
      ...repositoryConfig("api", repository),
      start: { command: "npm start", port: 3000, runtime: ">=22" },
    },
    { startCommand: "npm start", runtime: ">=22", envVarNames: [] },
  );
  assert.equal(configured.start.port, 3100);
  assert.equal(configured.id, "api");
  const clearAnswers = [
    "-", "", "-", "-", "-", "", "", "", "", "", "", "",
  ];
  const cleared = await collectRepositoryConfig(
    { question: async () => clearAnswers.shift() },
    { ...configured, modules: ["server"] },
    { startCommand: "npm start", runtime: ">=22", envVarNames: [] },
  );
  assert.deepEqual(cleared.modules, []);
  assert.equal(cleared.start.port, null);
  assert.equal(cleared.start.runtime, null);
});

test("既有读取路径不能通过最终符号链接逃逸", (t) => {
  const root = temporaryDirectory(t);
  const inside = join(root, "inside");
  const outside = temporaryDirectory(t);
  mkdirSync(inside);
  const link = join(inside, "external");
  symlinkSync(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => ensureExistingWithin(inside, link), /超出/);
});

test("任务移动和删除的路径守卫拒绝逃逸", (t) => {
  const root = temporaryDirectory(t);
  const iterations = join(root, "iterations");
  mkdirSync(iterations);
  assert.equal(
    ensureWithin(iterations, join(iterations, "i", "task")),
    join(realpathSync.native(root), "iterations", "i", "task"),
  );
  assert.throws(() => ensureWithin(iterations, join(root, "AGENTS.md")), /超出/);
});

test("发布聚合只纳入 done，并在来源变化时改变指纹", (t) => {
  const iteration = temporaryDirectory(t);
  writeJson(join(iteration, "iteration.json"), {
    schema_version: 2,
    id: iteration.split(/[\\/]/).at(-1),
    revision: 0,
    title: "发布",
    goal: "上线",
    status: "open",
    created_at: "2026-07-24T00:00:00.000Z",
    target_version: null,
  });
  for (const [id, phase] of [
    ["task-done", "done"],
    ["task-cancelled", "cancelled"],
    ["task-active", "verification"],
  ]) {
    const directory = join(iteration, id);
    mkdirSync(directory);
    writeJson(join(directory, "task.json"), {
      schema_version: 2,
      revision: 0,
      title: id,
      summary: id + " summary",
      type: "feature",
      phase,
      repositories: [],
      modules: [],
      related_tasks: [],
      slices: [],
      checkpoints: {},
      approvals: {},
      delivery: { repositories: [] },
    });
  }
  writeFileSync(
    join(iteration, "task-done", "verification.md"),
    "通过",
    "utf8",
  );
  writeFileSync(
    join(iteration, "changes.jsonl"),
    JSON.stringify({
      schema_version: 2,
      id: "change-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      summary: "小修复",
      commits: { backend: "abc" },
      verification: "test",
      project_docs: [],
    }) + "\n",
    "utf8",
  );
  const before = aggregateRelease(iteration);
  assert.deepEqual(before.done.map((task) => task.id), ["task-done"]);
  assert.deepEqual(before.cancelled.map((task) => task.id), ["task-cancelled"]);
  assert.deepEqual(before.unfinished.map((task) => task.id), ["task-active"]);
  writeFileSync(
    join(iteration, "task-done", "verification.md"),
    "通过，补充证据",
    "utf8",
  );
  assert.notEqual(aggregateRelease(iteration).fingerprint, before.fingerprint);

  const iterationPath = join(iteration, "iteration.json");
  const invalidIteration = JSON.parse(readFileSync(iterationPath, "utf8"));
  delete invalidIteration.id;
  writeJson(iterationPath, invalidIteration);
  assert.throws(() => aggregateRelease(iteration), /iteration\.json 格式不受支持/);
  invalidIteration.id = iteration.split(/[\\/]/).at(-1);
  invalidIteration.source_revision = 0;
  writeJson(iterationPath, invalidIteration);
  assert.throws(() => aggregateRelease(iteration), /未知字段：source_revision/);
});

test("本地受管块保留用户文字，并拒绝保存密钥值", () => {
  const start = "<!-- spec-driven:local-config:start -->";
  const end = "<!-- spec-driven:local-config:end -->";
  const original = "# 我的说明\n\n不要删除。\n";
  const updated = replaceManagedBlock(
    original,
    { env_var_names: ["API_TOKEN"], repositories: [] },
    start,
    end,
  );
  assert.match(updated, /不要删除/);
  assert.deepEqual(extractManagedJson(updated, start, end).env_var_names, [
    "API_TOKEN",
  ]);
  assert.doesNotThrow(() =>
    assertNoSecrets({ env_var_names: ["API_TOKEN"] }),
  );
  assert.throws(() => assertNoSecrets({ token: "actual-value" }), /疑似密钥/);
});

test("工作流与独立 Skill 命名分层，且只有标准 frontmatter", () => {
  const root = join(import.meta.dirname, "..", "..");
  const skillRoot = join(root, ".agents", "skills");
  assert.ok(WORKFLOW_SKILLS.every((skill) => /^sw-/.test(skill)));
  assert.ok(INDEPENDENT_SKILLS.every((skill) => !/^sw-/.test(skill)));
  assert.deepEqual(
    [...new Set([...WORKFLOW_SKILLS, ...INDEPENDENT_SKILLS])],
    SKILLS,
  );
  assert.deepEqual(
    readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    [...SKILLS].sort(),
  );
  for (const skill of SKILLS) {
    const path = join(skillRoot, skill, "SKILL.md");
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, skill + " 缺少 frontmatter");
    const keys = frontmatter[1]
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(":")));
    assert.deepEqual(keys, ["name", "description"]);
    assert.match(frontmatter[1], new RegExp("^name: " + skill + "$", "m"));
    assert.match(content, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(content, /\[TODO|Structuring This Skill/);
    assert.ok(content.split(/\r?\n/).length < 500);
  }
  for (const skill of INDEPENDENT_SKILLS) {
    const context = buildContextPaths(skill, null, root);
    assert.deepEqual(context.required, [
      "AGENTS.md",
      ".agents/skills/" + skill + "/SKILL.md",
    ]);
  }
});

test("未发布工作流不保留历史兼容层", () => {
  const root = join(import.meta.dirname, "..", "..");
  const compatibilitySources = [
    "tools/workflow/common.js",
    "tools/workflow/adapter.js",
    "tools/workflow/doctor.js",
    "tools/workflow/setup.js",
    ".agents/skills/sw-doctor/SKILL.md",
    ".agents/skills/sw-setup/SKILL.md",
    "AGENTS.md",
    "README.md",
  ].map((path) => readFileSync(join(root, path), "utf8")).join("\n");
  assert.doesNotMatch(
    compatibilitySources,
    /legacySkill|旧 Skill 名称|schema v1|task migrate|workflow_version|升级模板时/,
  );

  const tasks = readFileSync(
    join(root, "tools", "workflow", "tasks.js"),
    "utf8",
  );
  assert.doesNotMatch(
    tasks,
    /Slices（如需要）|value\.blockedBy|value\.summary|options\.expectedRevision|initial_dirty_state \?\? null/,
  );
});

test("当前 task schema 缺失字段时直接拒绝，不静默补齐", () => {
  const task = {
    schema_version: 2,
    revision: 0,
    title: "严格任务",
    summary: "验证当前数据契约",
    type: "feature",
    phase: "prd",
    repositories: [],
    modules: [],
    related_tasks: [],
    slices: [],
    checkpoints: {},
    approvals: {},
    delivery: { repositories: [] },
  };
  assert.deepEqual(parseTaskData(task).related_tasks, []);

  for (const field of [
    "repositories",
    "modules",
    "related_tasks",
    "slices",
    "checkpoints",
    "approvals",
    "delivery",
  ]) {
    const invalid = structuredClone(task);
    delete invalid[field];
    assert.throws(() => parseTaskData(invalid), new RegExp(field));
  }

  const invalidDelivery = structuredClone(task);
  invalidDelivery.delivery.repositories = [{
    id: "backend",
    initial_dirty_paths: [],
    initial_dirty_state: null,
    commits: [],
  }];
  assert.throws(() => parseTaskData(invalidDelivery), /initial_dirty_state/);

  const unknownField = { ...task, migration_receipt: {} };
  assert.throws(() => parseTaskData(unknownField), /未知字段：migration_receipt/);

  const invalidDependency = structuredClone(task);
  invalidDependency.slices = [{
    id: "01-api",
    title: "实现接口",
    status: "pending",
    blocked_by: [1],
  }];
  assert.throws(() => parseTaskData(invalidDependency), /只包含字符串/);
});

test("阶段 Skill 显式交接到下一阶段", () => {
  const root = join(import.meta.dirname, "..", "..", ".agents", "skills");
  for (const [current, next] of [
    ["sw-prd", "sw-technical-design"],
    ["sw-technical-design", "sw-spec"],
    ["sw-spec", "sw-implement"],
    ["sw-implement", "sw-verify"],
  ]) {
    const content = readFileSync(join(root, current, "SKILL.md"), "utf8");
    assert.match(content, new RegExp("`" + next + "`"));
  }
});

test("代码审查独立确定范围，按风险加载参考并由工作流限定范围", () => {
  const root = join(import.meta.dirname, "..", "..", ".agents", "skills");
  const reviewRoot = join(root, "code-review");
  const review = readFileSync(join(reviewRoot, "SKILL.md"), "utf8");
  const metadata = readFileSync(
    join(reviewRoot, "agents", "openai.yaml"),
    "utf8",
  );

  assert.match(review, /当前请求明确的仓库、路径、符号、diff、提交范围/);
  assert.match(review, /暂存.*未暂存.*未跟踪/);
  assert.match(review, /只有明确要求完整审查或审计时才检查完整内容/);
  assert.match(review, /提交或分支审查只使用请求中明确的比较基线/);
  assert.match(review, /references\/security-reliability\.md/);
  assert.match(review, /references\/correctness-quality\.md/);
  assert.match(review, /references\/architecture-design\.md/);
  assert.match(review, /严重级别只描述风险，不决定工作流门禁/);
  assert.doesNotMatch(
    review,
    /调用方按以下字段|调用方可以注入|审查目标：|task status|delivery|sw-domain-modeling/,
  );
  assert.match(metadata, /\$code-review/);
  assert.doesNotMatch(metadata, /allow_implicit_invocation: false/);

  const referenceChecks = new Map([
    ["security-reliability.md", [/SSRF/, /租户隔离/, /乐观锁/, /重试/]],
    ["correctness-quality.md", [/异常是否被吞掉/, /Unicode/, /循环内查询/, /缓存/]],
    ["architecture-design.md", [/加强前置条件/, /空方法/, /假设需求/, /大型重写/]],
  ]);
  for (const [file, patterns] of referenceChecks) {
    const content = readFileSync(join(reviewRoot, "references", file), "utf8");
    for (const pattern of patterns) {
      assert.match(content, pattern);
    }
  }

  const agentInstructions = readFileSync(
    join(root, "..", "..", "AGENTS.md"),
    "utf8",
  );
  assert.match(agentInstructions, /明确要求只做代码审查/);
  assert.match(agentInstructions, /直接调用 `code-review`/);
  assert.match(agentInstructions, /不要求选择、新建或推进工作流任务/);

  for (const skill of ["sw-implement", "sw-verify"]) {
    const content = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    assert.match(content, /调用 `code-review`/);
    assert.match(content, /task delivery/);
    assert.match(content, /baseline_head -> HEAD\/worktree/);
    assert.match(content, /初始脏文件/);
    assert.match(content, /同一范围复审/);
  }

  const simpleChange = readFileSync(
    join(root, "sw-simple-change", "SKILL.md"),
    "utf8",
  );
  assert.match(simpleChange, /HEAD -> worktree/);
  assert.match(simpleChange, /用户请求和适用约束作为审查依据/);
  assert.match(simpleChange, /初始脏文件/);
  assert.match(simpleChange, /同一范围复审/);

  const verify = readFileSync(join(root, "sw-verify", "SKILL.md"), "utf8");
  assert.match(verify, /复用代码审查结论作为静态证据/);
});

test("领域建模 Skill 管理专业术语和 ADR，并接入关键阶段", () => {
  const root = join(import.meta.dirname, "..", "..", ".agents", "skills");
  const domainModeling = readFileSync(
    join(root, "sw-domain-modeling", "SKILL.md"),
    "utf8",
  );
  assert.match(domainModeling, /专业术语/);
  assert.match(domainModeling, /难以逆转/);
  assert.match(domainModeling, /根目录 `adr\//);
  assert.match(domainModeling, /memory status --json/);
  assert.match(domainModeling, /--expected-revision <n> --apply/);
  assert.match(domainModeling, /编号由锁内 CLI 分配/);
  assert.match(domainModeling, /不要直接编辑/);
  for (const skill of ["sw-prd", "sw-technical-design", "sw-implement"]) {
    const content = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    assert.match(content, /`sw-domain-modeling`/);
  }
});

test("grilling Skill 集中维护追问协议并接入需要决策的阶段", () => {
  const root = join(import.meta.dirname, "..", "..", ".agents", "skills");
  const grilling = readFileSync(
    join(root, "grilling", "SKILL.md"),
    "utf8",
  );
  const metadata = readFileSync(
    join(root, "grilling", "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(grilling, /事实自行调查/);
  assert.match(grilling, /当前前沿/);
  assert.match(grilling, /推荐答案/);
  assert.match(grilling, /用户已经确认/);
  assert.doesNotMatch(grilling, /task\.json|task status|工作流阶段|调用方/);
  assert.match(metadata, /\$grilling/);
  assert.doesNotMatch(metadata, /allow_implicit_invocation: false/);
  for (const skill of [
    "sw-prd",
    "sw-technical-design",
    "sw-spec",
    "sw-implement",
  ]) {
    const content = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    assert.match(content, /`grilling`/);
    for (const field of ["访谈主题", "已知事实", "待决范围", "完成标准"]) {
      assert.match(content, new RegExp(field), skill + " 缺少 " + field);
    }
    assert.doesNotMatch(
      content,
      /当前前沿|推荐答案|每轮只问一题|重新计算前沿/,
    );
  }
});

test("writing-great-skills 独立创建任意 Skill 且仅由用户显式调用", () => {
  const root = join(import.meta.dirname, "..", "..");
  const skill = join(
    root,
    ".agents",
    "skills",
    "writing-great-skills",
  );
  const instructions = readFileSync(join(skill, "SKILL.md"), "utf8");
  const glossary = readFileSync(join(skill, "GLOSSARY.md"), "utf8");
  const metadata = readFileSync(join(skill, "agents", "openai.yaml"), "utf8");
  assert.match(instructions, /description: 仅当用户明确调用/);
  assert.match(instructions, /目标运行时/);
  assert.match(instructions, /真实用例/);
  assert.match(instructions, /触发不过宽/);
  assert.doesNotMatch(
    instructions + glossary,
    /本工作流|工作流 Skill|task\.json|delivery/,
  );
  assert.match(metadata, /\$writing-great-skills/);
  assert.match(
    metadata,
    /\npolicy:\r?\n  allow_implicit_invocation: false\r?\n?$/,
  );
});

test("Trae 和 OpenCode 原生接入标准入口与 Skills", () => {
  const table = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "agent-adapters.json"), "utf8"),
  );
  for (const id of ["trae", "opencode"]) {
    const agent = table.agents.find((item) => item.id === id);
    assert.ok(agent.entry_paths.includes("AGENTS.md"));
    assert.ok(agent.skills_paths.includes(".agents/skills"));
    assert.equal(installAdapter(id)[0].action, "native");
  }
  assert.match(installAdapter("trae")[0].detail, /Enable \.agents Skills Directory/);
});

test("CLI 可在临时 Git 仓库完成 setup 到迭代收口", (t) => {
  const sandbox = temporaryDirectory(t);
  const sourceRoot = join(import.meta.dirname, "..", "..");
  const workflow = join(sandbox, "workflow");
  const target = join(sandbox, "backend");
  const frontend = join(sandbox, "frontend");
  mkdirSync(join(workflow, "tools"), { recursive: true });
  mkdirSync(target);
  mkdirSync(frontend);
  cpSync(join(sourceRoot, ".agents"), join(workflow, ".agents"), {
    recursive: true,
  });
  for (const path of [".gitattributes", "AGENTS.md"]) {
    cpSync(join(sourceRoot, path), join(workflow, path));
  }
  for (const path of ["workflow.js", "agent-adapters.json", "package.json"]) {
    cpSync(join(sourceRoot, "tools", path), join(workflow, "tools", path));
  }
  cpSync(
    join(sourceRoot, "tools", "workflow"),
    join(workflow, "tools", "workflow"),
    { recursive: true },
  );
  cpSync(join(sourceRoot, "standards"), join(workflow, "standards"), {
    recursive: true,
  });
  for (const directory of [workflow, target, frontend]) {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: directory,
    });
  }
  for (const [directory, title] of [
    [target, "Backend"],
    [frontend, "Frontend"],
  ]) {
    writeFileSync(join(directory, "README.md"), "# " + title + "\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: directory });
    execFileSync("git", ["commit", "-q", "-m", "chore: initial"], {
      cwd: directory,
    });
  }
  const configPath = join(workflow, "setup.json");
  writeJson(configPath, {
    schema_version: 1,
    project: { name: "测试项目", goal: "验证完整 CLI" },
    agent: { id: "claude-code" },
    repositories: [
      {
        id: "backend",
        path: target,
        remote: "",
        role: "后端",
        modules: ["api"],
        start: { command: "node server.js", port: 3000, runtime: ">=22.12.0" },
        dependencies: { env_var_names: ["DATABASE_URL"], config_center: "none" },
        integration: { mode: "direct" },
        environments: {
          available: ["local"],
          local_operable: ["local"],
          remote_read: [],
          remote_write: [],
          switch_method: "环境变量",
        },
      },
      {
        id: "frontend",
        path: frontend,
        remote: "",
        role: "前端",
        modules: ["client"],
        start: { command: "node client.js", port: 3001, runtime: ">=22.12.0" },
        dependencies: { env_var_names: [], config_center: "none" },
        integration: { mode: "direct" },
        environments: {
          available: ["local"],
          local_operable: ["local"],
          remote_read: [],
          remote_write: [],
          switch_method: "环境变量",
        },
      },
    ],
    permissions: {
      production_write: false,
      deploy: false,
      ddl_execute: false,
    },
  });
  const cli = join(workflow, "tools", "workflow.js");
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: workflow,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const setupOutput = run("setup", "--config", configPath, "--apply");
  assert.doesNotMatch(setupOutput, /test@example\.com/);
  const localConfig = extractManagedJson(
    readFileSync(join(workflow, "AGENTS.local.md"), "utf8"),
  );
  assert.deepEqual(localConfig.git_emails, ["test@example.com"]);
  assert.equal(localConfig.schema_version, 1);
  assert.equal(Object.hasOwn(localConfig, "workflow_version"), false);
  assert.match(run("doctor"), /阻塞 0/);
  const ignoredSkills = execFileSync(
    "git",
    [
      "check-ignore",
      "--",
      ".claude/skills/code-review",
      ".claude/skills/sw-prd",
    ],
    { cwd: workflow, encoding: "utf8" },
  ).trim().split(/\r?\n/);
  assert.deepEqual(ignoredSkills, [
    ".claude/skills/code-review",
    ".claude/skills/sw-prd",
  ]);
  const contextPath = join(workflow, "CONTEXT.md");
  const initialContext = readFileSync(contextPath, "utf8");
  assert.match(initialContext, /^# 测试项目$/m);
  assert.match(initialContext, /^## 专业术语$/m);
  assert.match(initialContext, /^## 关键决策$/m);
  assert.equal(JSON.parse(run("memory", "status", "--json")).revision, 0);
  const termConfigPath = join(workflow, "term.json");
  writeJson(termConfigPath, {
    name: "接口",
    definition: "供不同模块交互的公开契约。",
    avoid: ["内部实现"],
  });
  run("memory", "term", "--config", termConfigPath);
  assert.equal(readFileSync(contextPath, "utf8"), initialContext);
  run(
    "memory",
    "term",
    "--config",
    termConfigPath,
    "--expected-revision",
    "0",
    "--apply",
  );
  run("setup", "--config", configPath, "--apply");
  const preservedContext = readFileSync(contextPath, "utf8");
  assert.match(preservedContext, /\*\*接口\*\*/);
  const adrName = "0001-server-owned-identity.md";
  const adrConfigPath = join(workflow, "adr.json");
  writeJson(adrConfigPath, {
    title: "服务端决定身份归属",
    slug: "server-owned-identity",
    scope: "backend/auth",
    summary: "客户端不得声明身份归属。",
    body: "身份归属由服务端可信会话决定。",
  });
  run(
    "memory",
    "adr",
    "--config",
    adrConfigPath,
    "--expected-revision",
    "1",
    "--apply",
  );
  assert.match(run("doctor"), /CONTEXT\.md 与 ADR 结构化索引/);
  const adrPath = join(workflow, "adr", adrName);
  const validAdr = readFileSync(adrPath, "utf8");
  writeFileSync(
    adrPath,
    validAdr.replace("范围：backend/auth", "范围：frontend"),
    "utf8",
  );
  assert.throws(() => run("doctor"));
  writeFileSync(adrPath, validAdr, "utf8");
  const validContext = readFileSync(contextPath, "utf8");
  writeFileSync(
    contextPath,
    validContext.replace("accepted · backend/auth", "deprecated · backend/auth"),
    "utf8",
  );
  assert.throws(() => run("doctor"));
  writeFileSync(contextPath, validContext, "utf8");
  assert.match(run("doctor"), /阻塞 0/);
  const projectIndex = join(workflow, "project", "index.md");
  const projectIndexContent = readFileSync(projectIndex, "utf8");
  rmSync(projectIndex);
  assert.throws(() => run("doctor"));
  writeFileSync(projectIndex, projectIndexContent, "utf8");

  const claudeEntry = join(workflow, "CLAUDE.md");
  const conflictingSkill = join(
    workflow,
    ".claude",
    "skills",
    "sw-prd",
  );
  rmSync(conflictingSkill, { recursive: true, force: true });
  mkdirSync(conflictingSkill, { recursive: true });
  writeFileSync(join(conflictingSkill, "SKILL.md"), "冲突内容\n", "utf8");
  writeFileSync(claudeEntry, "用户入口\n", "utf8");
  assert.throws(() =>
    run("adapter", "install", "--agent", "claude-code", "--apply"),
  );
  assert.equal(readFileSync(claudeEntry, "utf8"), "用户入口\n");
  rmSync(conflictingSkill, { recursive: true, force: true });
  run("adapter", "install", "--agent", "claude-code", "--apply");
  assert.match(readFileSync(claudeEntry, "utf8"), /@AGENTS\.md/);
  assert.match(run("doctor"), /阻塞 0/);

  const iterationPath = run(
    "iteration",
    "create",
    "--title",
    "首个迭代",
    "--goal",
    "交付测试功能",
  );
  const iterationId = iterationPath.split(/[\\/]/).at(-1);
  const taskPath = run(
    "task",
    "create",
    "--iteration",
    iterationId,
    "--title",
    "新增接口",
    "--summary",
    "增加一个可验证接口",
    "--repositories",
    "backend,frontend",
  );
  const normalizedTaskPath = taskPath.replaceAll("\\", "/");
  assert.throws(() =>
    run("task", "phase", taskPath, "technical_design", "--confirmed"),
  );
  const prdDocument = markdownDocument("新增接口", [
    ["背景与原始需求", "需要增加一个可验证接口。"],
    ["目标", "调用方可以读取接口结果。"],
    ["非目标", "不调整认证体系。"],
    ["用户与场景", "内部调用方在联调时访问接口。"],
    ["范围和业务规则", "返回稳定的成功结果。"],
    ["异常与边界", "无效输入返回明确错误。"],
    ["验收标准", "### AC-001 接口可用\n\n调用后返回预期结果。"],
    ["约束与依赖", "涉及 backend 和 frontend 两个仓库。"],
    ["未决问题", "无。"],
  ]);
  const prdPath = join(workflow, taskPath, "prd.md");
  writeFileSync(
    prdPath,
    prdDocument.replace(
      "### AC-001 接口可用\n\n调用后返回预期结果。",
      "验收项引用 AC-001，但没有使用三级标题。",
    ),
    "utf8",
  );
  assert.throws(() =>
    run("task", "phase", taskPath, "technical_design", "--confirmed"),
  );
  writeFileSync(
    prdPath,
    prdDocument.replace(
      "调用后返回预期结果。",
      "调用后返回预期结果。\n\n### AC-001 重复验收\n\n不得重复。",
    ),
    "utf8",
  );
  assert.throws(() =>
    run("task", "phase", taskPath, "technical_design", "--confirmed"),
  );
  writeFileSync(prdPath, prdDocument, "utf8");
  const cancelledTaskPath = run(
    "task",
    "create",
    "--iteration",
    iterationId,
    "--title",
    "已取消任务",
    "--summary",
    "不应成为可用候选",
  );
  const cancelledPrdPath = join(workflow, cancelledTaskPath, "prd.md");
  writeFileSync(cancelledPrdPath, prdDocument, "utf8");
  run(
    "task",
    "phase",
    cancelledTaskPath,
    "technical_design",
    "--confirmed",
  );
  writeFileSync(cancelledPrdPath, prdDocument + "\n取消前需求变化。\n", "utf8");
  run(
    "task",
    "cancel",
    cancelledTaskPath,
    "--reason",
    "测试过滤",
    "--confirmed",
  );
  assert.doesNotThrow(() => run("doctor"));
  const cancelledDecisionsPath = join(
    workflow,
    cancelledTaskPath,
    "decisions.md",
  );
  const cancelledDecisions = readFileSync(cancelledDecisionsPath, "utf8");
  rmSync(cancelledDecisionsPath);
  assert.throws(() => run("doctor"));
  writeFileSync(cancelledDecisionsPath, cancelledDecisions, "utf8");
  assert.doesNotThrow(() => run("doctor"));
  execFileSync("git", ["add", "iterations"], { cwd: workflow });
  execFileSync("git", ["commit", "-q", "-m", "test: add tasks"], {
    cwd: workflow,
  });
  writeFileSync(
    join(workflow, taskPath, "prd.md"),
    readFileSync(join(workflow, taskPath, "prd.md"), "utf8") +
      "\n本地更新说明。\n",
    "utf8",
  );
  const candidates = JSON.parse(
    run("task", "candidates", "--json"),
  );
  const candidate = candidates.find(
    (item) => item.path === normalizedTaskPath,
  );
  assert.equal(candidate.source, "local");
  assert.equal(candidate.authorEmail, "test@example.com");
  assert.equal(candidate.title, "新增接口");
  assert.ok(!("score" in candidate));
  assert.ok(
    !candidates.some(
      (item) => item.path === cancelledTaskPath.replaceAll("\\", "/"),
    ),
  );
  const prdStatus = JSON.parse(run("task", "status", taskPath, "--json"));
  assert.equal(prdStatus.ready, true);
  assert.equal(JSON.parse(run("task", "validate", taskPath, "--json")).valid, true);

  assert.throws(() => run("task", "phase", taskPath, "technical_design"));
  assert.throws(() =>
    run(
      "task",
      "phase",
      taskPath,
      "technical_design",
      "--expected-revision",
      String(prdStatus.revision + 1),
      "--confirmed",
    ),
  );
  run(
    "task",
    "phase",
    taskPath,
    "technical_design",
    "--expected-revision",
    String(prdStatus.revision),
    "--confirmed",
  );
  const taskJsonPath = join(workflow, taskPath, "task.json");
  const confirmedTask = JSON.parse(readFileSync(taskJsonPath, "utf8"));
  const missingDecisionsDependency = structuredClone(confirmedTask);
  const prdCheckpoint = missingDecisionsDependency.checkpoints.prd;
  delete prdCheckpoint.dependency_hashes.decisions;
  missingDecisionsDependency.approvals.prd.checkpoint_hash = fingerprint({
    phase: "prd",
    artifact: prdCheckpoint.artifact,
    content_hash: prdCheckpoint.content_hash,
    dependency_hashes: prdCheckpoint.dependency_hashes,
  });
  writeJson(taskJsonPath, missingDecisionsDependency);
  assert.throws(
    () => run("doctor"),
    (error) => /缺少 decisions 依赖/.test(String(error.stdout)),
  );
  writeJson(taskJsonPath, confirmedTask);
  const confirmedPrd = readFileSync(join(workflow, taskPath, "prd.md"), "utf8");
  writeFileSync(
    join(workflow, taskPath, "prd.md"),
    confirmedPrd + "\n确认后发生变化。\n",
    "utf8",
  );
  assert.ok(
    JSON.parse(run("task", "status", taskPath, "--json")).blockers.some(
      (blocker) => /checkpoint prd 为 stale/.test(blocker),
    ),
  );
  writeFileSync(join(workflow, taskPath, "prd.md"), confirmedPrd, "utf8");
  const decisionsPath = join(workflow, taskPath, "decisions.md");
  const confirmedDecisions = readFileSync(decisionsPath, "utf8");
  writeFileSync(decisionsPath, confirmedDecisions + "\n新增决策。\n", "utf8");
  assert.ok(
    JSON.parse(run("task", "status", taskPath, "--json")).blockers.some(
      (blocker) => /checkpoint prd 为 stale/.test(blocker),
    ),
  );
  writeFileSync(decisionsPath, confirmedDecisions, "utf8");
  writeFileSync(
    join(workflow, taskPath, "technical-design.md"),
    markdownDocument("技术方案", [
      ["目标与非目标", "实现 AC-001；不改变认证。"],
      [
        "当前实现与证据",
        "两个仓库的 README.md 表明基线存在；身份边界遵循 `adr/" + adrName + "`。",
      ],
      ["总体设计", "增加一个独立接口实现。"],
      ["数据模型与 DDL", "不适用，不涉及数据库。"],
      ["API 与调用方", "AC-001 由内部调用方验证。"],
      ["后端实现", "在 backend 增加接口文件。"],
      ["Web/小程序实现", "frontend 增加调用方文件。"],
      ["权限与安全", "沿用现有边界。"],
      ["配置、环境与联调", "使用 local 环境。"],
      ["可观测性", "通过测试输出确认。"],
      ["跨仓库依赖与顺序", "先 backend，后 frontend。"],
      ["迁移、发布与回滚", "回滚对应 commit。"],
      ["测试和验证策略", "执行自动化检查并验证 AC-001。"],
      ["风险与未决问题", "无。"],
    ]),
    "utf8",
  );
  assert.throws(() => run("task", "phase", taskPath, "implementation_spec"));
  run("task", "phase", taskPath, "implementation_spec", "--confirmed");
  const technicalCheckpoint = JSON.parse(readFileSync(taskJsonPath, "utf8"))
    .checkpoints.technical_design;
  assert.ok(
    technicalCheckpoint.dependency_hashes.memory["adr/" + adrName],
  );
  const stableAdr = readFileSync(adrPath, "utf8");
  writeFileSync(adrPath, stableAdr + "\n确认后改变决定正文。\n", "utf8");
  assert.ok(
    JSON.parse(run("task", "status", taskPath, "--json")).blockers.some(
      (blocker) => /checkpoint technical_design 为 stale/.test(blocker),
    ),
  );
  writeFileSync(adrPath, stableAdr, "utf8");
  writeFileSync(
    join(workflow, taskPath, "spec.md"),
    markdownDocument("实施方案", [
      ["本轮实施基线", "以 task.json 捕获的 backend HEAD 为准。"],
      ["实施顺序与依赖", "先实现接口，再完成调用方验证。"],
      ["按仓库的修改计划", "backend 增加 feature.txt，frontend 增加 client.txt。"],
      ["数据库与配置动作", "不适用。"],
      ["验收标准到验证的映射", "AC-001 对应文件检查。"],
      ["测试与联调", "检查 feature.txt 内容。"],
      ["项目文档同步", "无需更新长期文档。"],
      ["Slices", "01-api 完成后执行 02-client。"],
      ["风险和停止条件", "基线漂移时停止。"],
    ]),
    "utf8",
  );
  const slicesPath = join(workflow, "slices.json");
  writeJson(slicesPath, [
    {
      id: "01-api",
      summary: "实现接口",
      status: "pending",
      blockedBy: [],
    },
  ]);
  assert.throws(() =>
    run("task", "slices", taskPath, "--config", slicesPath),
  );
  writeJson(slicesPath, [
    { id: "01-api", title: "实现接口", status: "pending", blocked_by: [] },
    {
      id: "02-client",
      title: "验证调用方",
      status: "pending",
      blocked_by: ["01-api"],
    },
  ]);
  run("task", "slices", taskPath, "--config", slicesPath);
  run("task", "phase", taskPath, "implementation", "--confirmed");
  assert.throws(() =>
    run("task", "slice", taskPath, "02-client", "in_progress"),
  );
  run("task", "slice", taskPath, "01-api", "in_progress");
  run("task", "slice", taskPath, "01-api", "done");
  run("task", "slice", taskPath, "02-client", "in_progress");
  run("task", "slice", taskPath, "02-client", "done");
  writeFileSync(join(target, "feature.txt"), "implemented\n", "utf8");
  writeFileSync(join(target, "feature-proof.txt"), "verified\n", "utf8");
  writeFileSync(join(frontend, "client.txt"), "integrated\n", "utf8");
  run("task", "phase", taskPath, "verification", "--confirmed");
  const verificationDocument = markdownDocument("验证记录", [
    [
      "验收项与证据",
      "### AC-001 接口可用\n\n状态：pass\n\n证据：feature.txt 内容检查通过。",
    ],
    ["仓库检查", "backend 与 frontend 工作树范围符合实施方案。"],
    ["集成验证", "调用链检查通过。"],
    ["数据库验证", "不适用。"],
    ["UI 证据", "不适用。"],
    ["项目文档同步", "无需同步。"],
    ["提交范围", "backend 两个功能文件与 frontend/client.txt。"],
    ["未验证项与残余风险", "无。"],
  ]);
  writeFileSync(
    join(workflow, taskPath, "verification.md"),
    verificationDocument.replace("\n\n证据：feature.txt 内容检查通过。", ""),
    "utf8",
  );
  assert.throws(() => run("task", "validate", taskPath, "--json"));
  writeFileSync(
    join(workflow, taskPath, "verification.md"),
    verificationDocument,
    "utf8",
  );
  assert.equal(JSON.parse(run("task", "validate", taskPath, "--json")).valid, true);
  assert.doesNotThrow(() =>
    run("context", "code-review", "--json"),
  );
  execFileSync("git", ["add", "feature.txt"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "feat: add interface"], {
    cwd: target,
  });
  const backendFirstCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["add", "feature-proof.txt"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "test: add proof"], {
    cwd: target,
  });
  execFileSync("git", ["add", "client.txt"], { cwd: frontend });
  execFileSync("git", ["commit", "-q", "-m", "feat: add client"], {
    cwd: frontend,
  });
  const deliveryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  const frontendCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: frontend,
    encoding: "utf8",
  }).trim();
  assert.throws(() => run("task", "phase", taskPath, "done", "--confirmed"));
  assert.throws(() =>
    run(
      "task",
      "phase",
      taskPath,
      "done",
      "--commit",
      "backend=" + deliveryCommit,
      "--commit",
      "frontend=" + frontendCommit,
      "--confirmed",
    ),
  );
  run(
    "task",
    "phase",
    taskPath,
    "done",
    "--commit",
    "backend=" + backendFirstCommit,
    "--commit",
    "backend=" + deliveryCommit,
    "--commit",
    "frontend=" + frontendCommit,
    "--confirmed",
  );
  assert.equal(JSON.parse(run("task", "status", taskPath, "--json")).ready, true);
  assert.throws(() =>
    run(
      "task",
      "phase",
      taskPath,
      "verification",
      "--reason",
      "终态测试",
      "--confirmed",
    ),
  );
  writeFileSync(join(target, "follow-up.txt"), "small change\n", "utf8");
  execFileSync("git", ["add", "follow-up.txt"], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "fix: follow-up"], {
    cwd: target,
  });
  const followUpCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  assert.equal(JSON.parse(run("task", "status", taskPath, "--json")).ready, true);
  run(
    "change",
    "add",
    "--iteration",
    iterationId,
    "--summary",
    "完成后的独立修复",
    "--commit",
    "backend=" + followUpCommit,
    "--verification",
    "文件检查通过",
  );
  const releaseContext = JSON.parse(
    run(
      "context",
      "sw-release-plan",
      "--iteration",
      iterationId,
      "--json",
    ),
  );
  assert.ok(releaseContext.required.includes(normalizedTaskPath + "/task.json"));
  assert.ok(!releaseContext.required.some((path) => path.includes("<task-id>")));
  run("iteration", "release-plan", iterationId, "--apply");
  assert.throws(() =>
    run("iteration", "confirm-release-plan", iterationId, "--confirmed"),
  );
  const releasePlanPath = join(
    workflow,
    "iterations",
    iterationId,
    "release-plan.md",
  );
  const completedPlan = readFileSync(releasePlanPath, "utf8")
    .replace("目标版本或批次：待确认", "目标版本或批次：测试发布")
    .replaceAll("待补充；", "无；")
    .replaceAll("待补充。", "无。")
    .replaceAll("待核对。", "无。") + "\n人工发布说明。\n";
  writeFileSync(releasePlanPath, completedPlan, "utf8");
  run("iteration", "release-plan", iterationId, "--apply");
  assert.equal(readFileSync(releasePlanPath, "utf8"), completedPlan);
  const stableVerification = readFileSync(
    join(workflow, taskPath, "verification.md"),
    "utf8",
  );
  writeFileSync(
    join(workflow, taskPath, "verification.md"),
    stableVerification + "\n完成后篡改。\n",
    "utf8",
  );
  assert.equal(JSON.parse(run("task", "status", taskPath, "--json")).ready, false);
  assert.throws(() =>
    run("iteration", "confirm-release-plan", iterationId, "--confirmed"),
  );
  writeFileSync(
    join(workflow, taskPath, "verification.md"),
    stableVerification,
    "utf8",
  );
  assert.equal(JSON.parse(run("task", "status", taskPath, "--json")).ready, true);
  run("iteration", "confirm-release-plan", iterationId, "--confirmed");
  writeFileSync(releasePlanPath, completedPlan + "确认后修改。\n", "utf8");
  assert.throws(() => run("iteration", "done", iterationId, "--confirmed"));
  writeFileSync(releasePlanPath, completedPlan, "utf8");
  run("iteration", "done", iterationId, "--confirmed");
  assert.throws(() => run("iteration", "done", iterationId, "--confirmed"));
  assert.throws(() =>
    run(
      "task",
      "reopen",
      taskPath,
      "verification",
      "--reason",
      "已发布后不允许原地重开",
      "--confirmed",
    ),
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        join(workflow, "iterations", iterationId, "iteration.json"),
        "utf8",
      ),
    ).status,
    "done",
  );
  assert.deepEqual(JSON.parse(run("task", "candidates", "--json")), []);
  assert.match(run("doctor"), /阻塞 0/);
});
