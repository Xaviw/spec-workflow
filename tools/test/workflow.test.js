import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
  SKILLS,
  assertNoSecrets,
  ensureExistingWithin,
  ensureWithin,
  extractManagedJson,
  fileHash,
  parseCliArgs,
  replaceManagedBlock,
  withFileLocks,
  writeText,
} from "../workflow/common.js";
import { installAdapter } from "../workflow/adapter.js";
import { buildContextPaths } from "../workflow/context.js";
import { aggregateRelease } from "../workflow/release.js";
import {
  assertRepositoryRegistration,
  assertPortableRepositoryId,
  inspectRepositoryRoot,
  sanitizeGitRemote,
  validateSetupConfig,
} from "../workflow/setup.js";
import { canTransition } from "../workflow/tasks.js";
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
  mkdirSync(join(root, ".agents", "skills", "spec-driven-prd"), {
    recursive: true,
  });
  mkdirSync(task, { recursive: true });
  mkdirSync(join(root, "project", "repositories"), { recursive: true });
  mkdirSync(join(root, "project", "knowledge"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# A", "utf8");
  writeFileSync(join(root, "AGENTS.local.md"), "# L", "utf8");
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
  writeJson(join(task, "task.json"), {
    repositories: ["backend"],
    context: [{ file: "project/knowledge/api.md" }],
  });
  writeFileSync(
    join(root, ".agents", "skills", "spec-driven-prd", "SKILL.md"),
    "# S\n\n## 上下文契约\n\n必读：`task.json`、`prd.md`、`decisions.md`。\n\n按需读取：相关项目文档。\n\n初始禁止：其他任务。\n\n输出：当前 PRD。\n",
    "utf8",
  );
  const context = buildContextPaths("spec-driven-prd", task, root);
  assert.ok(context.required.includes("iterations/i/task-a/prd.md"));
  assert.ok(context.required.includes("AGENTS.local.md"));
  assert.ok(context.required.includes("project/repositories/backend.md"));
  assert.ok(context.required.includes("project/knowledge/api.md"));
  assert.deepEqual(context.missing, [
    "iterations/i/task-a/prd.md",
    "iterations/i/task-a/decisions.md",
  ]);
  assert.ok(!context.required.some((path) => path.includes("other-task")));
  assert.deepEqual(
    context.required.filter((path) => path.startsWith("project/knowledge/")),
    ["project/knowledge/api.md"],
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

test("setup 使用 canonical Git 根并拒绝子目录、重复路径和 remote 凭据", (t) => {
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
  assert.throws(
    () =>
      validateSetupConfig({
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
    title: "发布",
    goal: "上线",
    status: "open",
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
      title: id,
      phase,
      repositories: ["backend"],
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

test("所有 Skill 只有标准 frontmatter，且没有初始化占位", () => {
  const root = join(import.meta.dirname, "..", "..");
  for (const skill of SKILLS) {
    const path = join(root, ".agents", "skills", skill, "SKILL.md");
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, skill + " 缺少 frontmatter");
    const keys = frontmatter[1]
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(":")));
    assert.deepEqual(keys, ["name", "description"]);
    assert.match(content, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(content, /\[TODO|Structuring This Skill/);
    assert.ok(content.split(/\r?\n/).length < 500);
  }
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
  for (const path of [".gitattributes", "AGENTS.md", "WORKFLOW_VERSION"]) {
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
    git_emails: ["test@example.com"],
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

  run("setup", "--config", configPath, "--apply");
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
    "spec-driven-prd",
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
  writeFileSync(
    join(workflow, taskPath, "prd.md"),
    markdownDocument("新增接口", [
      ["背景与原始需求", "需要增加一个可验证接口。"],
      ["目标", "调用方可以读取接口结果。"],
      ["非目标", "不调整认证体系。"],
      ["用户与场景", "内部调用方在联调时访问接口。"],
      ["范围和业务规则", "返回稳定的成功结果。"],
      ["异常与边界", "无效输入返回明确错误。"],
      ["验收标准", "### AC-001 接口可用\n\n调用后返回预期结果。"],
      ["约束与依赖", "涉及 backend 和 frontend 两个仓库。"],
      ["未决问题", "无。"],
    ]),
    "utf8",
  );
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
  run(
    "task",
    "cancel",
    cancelledTaskPath,
    "--reason",
    "测试过滤",
    "--confirmed",
  );
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
  writeFileSync(
    join(workflow, taskPath, "technical-design.md"),
    markdownDocument("技术方案", [
      ["目标与非目标", "实现 AC-001；不改变认证。"],
      ["当前实现与证据", "两个仓库的 README.md 表明基线存在。"],
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
    run("context", "spec-driven-code-review", "--json"),
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
  const legacyIterationPath = run(
    "iteration",
    "create",
    "--title",
    "旧任务迁移",
    "--goal",
    "验证显式迁移回执",
  );
  const legacyIterationId = legacyIterationPath.split(/[\\/]/).at(-1);
  const legacyTaskPath = join("iterations", legacyIterationId, "legacy-done");
  const legacyTaskDirectory = join(workflow, legacyTaskPath);
  mkdirSync(legacyTaskDirectory);
  for (const name of [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
    "verification.md",
  ]) {
    cpSync(join(workflow, taskPath, name), join(legacyTaskDirectory, name));
  }
  const completedTask = JSON.parse(
    readFileSync(join(workflow, taskPath, "task.json"), "utf8"),
  );
  writeJson(join(legacyTaskDirectory, "task.json"), {
    title: "旧版已完成任务",
    summary: "迁移已有交付证据",
    type: "feature",
    phase: "done",
    repositories: ["backend", "frontend"],
    modules: [],
    related_tasks: [],
    slices: completedTask.slices,
  });
  const backendBaseline = execFileSync(
    "git",
    ["rev-list", "--max-parents=0", "HEAD"],
    { cwd: target, encoding: "utf8" },
  ).trim();
  const frontendBaseline = execFileSync(
    "git",
    ["rev-list", "--max-parents=0", "HEAD"],
    { cwd: frontend, encoding: "utf8" },
  ).trim();
  run(
    "task",
    "migrate",
    legacyTaskPath,
    "--baseline",
    "backend=" + backendBaseline,
    "--baseline",
    "frontend=" + frontendBaseline,
    "--commit",
    "backend=" + backendFirstCommit,
    "--commit",
    "backend=" + deliveryCommit,
    "--commit",
    "frontend=" + frontendCommit,
    "--reason",
    "从 0.4 工作流升级",
    "--confirmed",
  );
  assert.equal(
    JSON.parse(run("task", "status", legacyTaskPath, "--json")).ready,
    true,
  );
  const legacyImplementationTaskPath = join(
    "iterations",
    legacyIterationId,
    "legacy-implementation",
  );
  const legacyImplementationDirectory = join(
    workflow,
    legacyImplementationTaskPath,
  );
  mkdirSync(legacyImplementationDirectory);
  for (const name of [
    "prd.md",
    "decisions.md",
    "technical-design.md",
    "spec.md",
  ]) {
    cpSync(
      join(workflow, taskPath, name),
      join(legacyImplementationDirectory, name),
    );
  }
  writeJson(join(legacyImplementationDirectory, "task.json"), {
    title: "旧版实施中任务",
    summary: "只迁移人工确认的实施基线",
    type: "feature",
    phase: "implementation",
    repositories: ["backend"],
    modules: [],
    related_tasks: [],
    slices: [],
  });
  run(
    "task",
    "migrate",
    legacyImplementationTaskPath,
    "--baseline",
    "backend=" + backendBaseline,
    "--reason",
    "从 0.4 工作流升级实施中任务",
    "--confirmed",
  );
  assert.equal(
    JSON.parse(
      run("task", "status", legacyImplementationTaskPath, "--json"),
    ).ready,
    true,
  );
  const legacyImplementationJsonPath = join(
    legacyImplementationDirectory,
    "task.json",
  );
  const legacyImplementationJson = JSON.parse(
    readFileSync(legacyImplementationJsonPath, "utf8"),
  );
  const missingReceipt = { ...legacyImplementationJson };
  delete missingReceipt.migration_receipt;
  writeJson(legacyImplementationJsonPath, missingReceipt);
  assert.throws(() => run("doctor"));
  writeJson(legacyImplementationJsonPath, legacyImplementationJson);
  run(
    "task",
    "cancel",
    legacyImplementationTaskPath,
    "--reason",
    "迁移路径验证完成",
    "--confirmed",
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
  assert.equal(
    JSON.parse(run("task", "status", legacyTaskPath, "--json")).ready,
    true,
  );
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
      "spec-driven-release-plan",
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
