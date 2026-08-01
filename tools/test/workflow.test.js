import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  extractManagedJson,
  findSecretPaths,
  assertPortableWorkflowText,
  parseCliArgs,
  parseIterationData,
  parseTaskData,
  replaceManagedBlock,
  withFileLocks,
} from "../workflow/common.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "spec-workflow-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeGit(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, "init");
  git(directory, "config", "user.name", "Workflow Test");
  git(directory, "config", "user.email", "workflow@example.com");
}

function createRepository(directory) {
  initializeGit(directory);
  writeFileSync(join(directory, "README.md"), `# ${basename(directory)}\n`, "utf8");
  git(directory, "add", "README.md");
  git(directory, "commit", "-m", "init");
}

function createWorkflow(t) {
  const base = temporaryDirectory(t);
  const workflow = join(base, "workflow");
  mkdirSync(join(workflow, "tools"), { recursive: true });
  mkdirSync(join(workflow, ".agents"), { recursive: true });
  cpSync(join(REPOSITORY_ROOT, "tools", "workflow.js"), join(workflow, "tools", "workflow.js"));
  cpSync(join(REPOSITORY_ROOT, "tools", "workflow"), join(workflow, "tools", "workflow"), { recursive: true });
  cpSync(join(REPOSITORY_ROOT, "tools", "package.json"), join(workflow, "tools", "package.json"));
  cpSync(join(REPOSITORY_ROOT, ".agents", "skills"), join(workflow, ".agents", "skills"), { recursive: true });
  writeFileSync(join(workflow, "AGENTS.md"), "# Test workflow\n", "utf8");
  initializeGit(workflow);

  const backend = join(base, "backend repo");
  const frontend = join(base, "frontend");
  createRepository(backend);
  createRepository(frontend);

  const invoke = (...args) => spawnSync(
    process.execPath,
    [join(workflow, "tools", "workflow.js"), ...args],
    { cwd: workflow, encoding: "utf8" },
  );
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const runJson = (...args) => JSON.parse(run(...args, "--json"));
  const fail = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 1, result.stdout);
    return result.stderr;
  };

  return { workflow, backend, frontend, invoke, run, runJson, fail };
}

test("CLI 参数、受管块和密钥检查保持最小且严格", () => {
  assert.deepEqual(parseCliArgs(["setup", "--repo", "a=x", "--repo", "b=y", "--json"]), {
    positionals: ["setup"],
    options: { repo: ["a=x", "b=y"], json: true },
  });
  assert.throws(() => parseCliArgs(["doctor", "--json", "true"]), /不接受/);
  assert.throws(() => parseCliArgs(["doctor", "--unknown"]), /未知选项/);

  const original = "用户说明\n";
  const first = replaceManagedBlock(original, { schema_version: 1 });
  const second = replaceManagedBlock(first, { schema_version: 1, agent: { id: "codex" } });
  assert.match(second, /^用户说明/m);
  assert.deepEqual(extractManagedJson(second), {
    schema_version: 1,
    agent: { id: "codex" },
  });
  assert.deepEqual(findSecretPaths({ token: "actual-value" }), ["token"]);
  assert.deepEqual(findSecretPaths({ env_var_names: ["API_TOKEN"] }), []);
  assert.throws(() => assertPortableWorkflowText("证据在 C:\\Users\\tester\\result.json", "verification.md"), /本机绝对路径/);
  assert.throws(() => assertPortableWorkflowText("证据在 `/tmp/result.json`", "verification.md"), /本机绝对路径/);
  assert.throws(() => assertPortableWorkflowText("证据在 \\\\server\\share\\result.json", "verification.md"), /本机绝对路径/);
  assert.throws(() => assertPortableWorkflowText("证据在 `/workspace/repo/result.json`", "verification.md"), /本机绝对路径/);
  assert.throws(() => assertPortableWorkflowText("证据在 `/data/build/output.txt`", "verification.md"), /本机绝对路径/);
  assert.throws(() => assertPortableWorkflowText("证据在 `file:///tmp/result.json`", "verification.md"), /本机绝对路径/);
  assert.doesNotThrow(() => assertPortableWorkflowText("证据在 `artifacts/result.json`", "verification.md"));
  assert.doesNotThrow(() => assertPortableWorkflowText("接口为 `https://example.com/root/items`", "verification.md"));
  assert.doesNotThrow(() => assertPortableWorkflowText("页面路由为 `/home/dashboard`", "technical-design.md"));
  assert.doesNotThrow(() => assertPortableWorkflowText("服务接口为 `/var/status`", "technical-design.md"));
});

test("活动文件锁不会仅因超时被抢占", (t) => {
  const lock = join(temporaryDirectory(t), "active.lock");
  writeFileSync(lock, String(process.pid), "utf8");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lock, old, old);
  assert.throws(() => withFileLocks([lock], () => {}), /另一个进程/);
});

test("iteration/task 状态只接受最小结构", () => {
  const iteration = {
    title: "迭代",
    status: "open",
    created_at: new Date().toISOString(),
    ended_at: null,
    simple_changes: [],
  };
  assert.equal(parseIterationData(iteration), iteration);
  assert.throws(() => parseIterationData({ ...iteration, unexpected: 1 }), /未知字段/);

  const task = {
    title: "任务",
    binding_id: "task-binding",
    phase: "prd",
    repositories: [],
    created_at: new Date().toISOString(),
    cancelled_from: null,
    git: { baseline: null, final: null },
  };
  assert.equal(parseTaskData(task), task);
  assert.throws(() => parseTaskData({ ...task, unexpected: true }), /未知字段/);
  const implementationTask = {
    ...task,
    phase: "implementation",
    git: {
      baseline: [{ id: "backend", branch: "main", head: "abc", dirty_paths: [] }],
      final: null,
    },
    repositories: ["backend"],
  };
  assert.equal(parseTaskData(implementationTask), implementationTask);
  assert.throws(
    () => parseTaskData({
      ...implementationTask,
      git: { baseline: [{ ...implementationTask.git.baseline[0], root: "C:/local" }], final: null },
    }),
    /未知字段/,
  );
});

test("setup/doctor 保持幂等并保护 Agent 接入边界", (t) => {
  const { workflow, backend, frontend, invoke, run, runJson, fail } = createWorkflow(t);
  const repositories = ["--repo", `backend=${backend}`, "--repo", `frontend=${frontend}`];

  const setup = runJson("setup", "--agent", "codex", ...repositories);
  assert.equal(setup.config.agent.id, "codex");
  assert.deepEqual(setup.config.repositories.map((repo) => repo.id), ["backend", "frontend"]);
  assert.deepEqual(setup.actions, [
    { action: "created", path: "AGENTS.local.md" },
    { action: "updated", path: ".git/info/exclude" },
  ]);
  assert.deepEqual(runJson("setup", "--agent", "codex", ...repositories).actions, [
    { action: "unchanged", path: "AGENTS.local.md" },
    { action: "unchanged", path: ".git/info/exclude" },
  ]);
  assert.equal(runJson("doctor").some((check) => check.level === "error"), false);
  assert.deepEqual(extractManagedJson(readFileSync(join(workflow, "AGENTS.local.md"), "utf8")), setup.config);
  assert.match(fail("iteration", "create", "--title", "   "), /不能为空/);

  const adapted = runJson(
    "setup",
    "--agent",
    "claude-code",
    "--entry-path",
    "CLAUDE.md",
    "--skills-path",
    ".claude/skills",
    ...repositories,
  );
  assert.equal(adapted.config.agent.entry_path, "CLAUDE.md");
  assert.match(readFileSync(join(workflow, "CLAUDE.md"), "utf8"), /AGENTS\.md/);
  assert.ok(lstatSync(join(workflow, ".claude", "skills", "sw-prd")).isSymbolicLink());
  assert.equal(runJson("doctor").some((check) => check.level === "error"), false);

  const workflowEntry = join(workflow, "tools", "workflow.js");
  const workflowEntryBefore = readFileSync(workflowEntry, "utf8");
  assert.match(
    fail("setup", "--agent", "bad", "--entry-path", "tools/workflow.js", ...repositories),
    /受保护的工作流路径/,
  );
  assert.equal(readFileSync(workflowEntry, "utf8"), workflowEntryBefore);
  assert.match(
    fail(
      "setup",
      "--agent",
      "bad",
      "--entry-path",
      ".claude/skills/agent-entry.md",
      "--skills-path",
      ".claude/skills",
      ...repositories,
    ),
    /不能重叠/,
  );

  const invalidEntry = join(workflow, "BROKEN.md");
  writeFileSync(
    invalidEntry,
    "<!-- spec-driven:agent-entry:start -->\nA\n<!-- spec-driven:agent-entry:end -->\n" +
      "<!-- spec-driven:agent-entry:start -->\nB\n<!-- spec-driven:agent-entry:end -->\n",
    "utf8",
  );
  const currentEntryBefore = readFileSync(join(workflow, "CLAUDE.md"), "utf8");
  assert.match(
    fail(
      "setup",
      "--agent",
      "claude-code",
      "--entry-path",
      "BROKEN.md",
      "--skills-path",
      ".claude/skills",
      ...repositories,
    ),
    /受管块标记不完整/,
  );
  assert.equal(readFileSync(join(workflow, "CLAUDE.md"), "utf8"), currentEntryBefore);

  const temporarySkill = join(workflow, ".agents", "skills", "temporary-skill");
  mkdirSync(temporarySkill);
  writeFileSync(
    join(temporarySkill, "SKILL.md"),
    "---\nname: temporary-skill\ndescription: 临时测试\n---\n",
    "utf8",
  );
  run(
    "setup",
    "--agent",
    "claude-code",
    "--entry-path",
    "CLAUDE.md",
    "--skills-path",
    ".claude/skills",
    ...repositories,
  );
  const temporaryLink = join(workflow, ".claude", "skills", "temporary-skill");
  assert.ok(lstatSync(temporaryLink).isSymbolicLink());
  rmSync(temporarySkill, { recursive: true, force: true });
  let doctorResult = invoke("doctor", "--json");
  assert.equal(doctorResult.status, 1);
  assert.ok(JSON.parse(doctorResult.stdout).some((check) => check.id === "agent.skill.stale.temporary-skill"));
  run(
    "setup",
    "--agent",
    "claude-code",
    "--entry-path",
    "CLAUDE.md",
    "--skills-path",
    ".claude/skills",
    ...repositories,
  );
  assert.equal(existsSync(temporaryLink), false);

  const brokenSkill = join(workflow, ".agents", "skills", "broken-skill");
  mkdirSync(brokenSkill);
  doctorResult = invoke("doctor", "--json");
  assert.equal(doctorResult.status, 1);
  assert.ok(JSON.parse(doctorResult.stdout).some((check) => check.id === "skills.discovery"));
  rmSync(brokenSkill, { recursive: true, force: true });

  const conflict = join(workflow, ".claude", "skills", "sw-prd");
  rmSync(conflict, { recursive: true, force: true });
  mkdirSync(conflict);
  writeFileSync(join(conflict, "user.md"), "user content", "utf8");
  assert.match(
    fail(
      "setup",
      "--agent",
      "claude-code",
      "--entry-path",
      "CLAUDE.md",
      "--skills-path",
      ".claude/skills",
      ...repositories,
    ),
    /--replace/,
  );
  assert.equal(readFileSync(join(conflict, "user.md"), "utf8"), "user content");
  run(
    "setup",
    "--agent",
    "claude-code",
    "--entry-path",
    "CLAUDE.md",
    "--skills-path",
    ".claude/skills",
    ...repositories,
    "--replace",
  );
  assert.ok(lstatSync(conflict).isSymbolicLink());
  const nativeActions = runJson("setup", "--agent", "codex", ...repositories).actions;
  assert.ok(nativeActions.some((item) => item.action === "removed" && item.path === "CLAUDE.md"));
  assert.ok(nativeActions.some((item) => item.action === "updated" && item.path === "AGENTS.local.md"));
  assert.equal(existsSync(join(workflow, "CLAUDE.md")), false);
  assert.match(fail("setup", "--agent", "bad", "--entry-path", "../outside.md", ...repositories), /边界/);
});

test("task lifecycle 支持可选技术方案并保护 Git binding", (t) => {
  const { workflow, backend, frontend, run, runJson, fail } = createWorkflow(t);
  const repositories = ["--repo", `backend=${backend}`, "--repo", `frontend=${frontend}`];
  run("setup", "--agent", "codex", ...repositories);

  const iteration = runJson("iteration", "create", "--title", "首个迭代");
  const task = runJson(
    "task",
    "create",
    "--iteration",
    iteration.id,
    "--title",
    "实现能力",
    "--repositories",
    "backend,frontend",
  );
  const taskDirectory = join(workflow, task.path);
  assert.deepEqual(readdirSync(taskDirectory), ["task.json"]);
  assert.deepEqual(task.next_phases, ["technical_design", "implementation_spec"]);
  assert.match(
    fail("task", "create", "--iteration", iteration.id, "--title", "   "),
    /不能为空/,
  );
  assert.equal(runJson("task", "list").length, 1);
  assert.match(fail("task", "phase", task.path, "implementation_spec", "--confirmed"), /prd\.md/);
  writeFileSync(join(taskDirectory, "prd.md"), "# PRD\n\n### AC-001 行为\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation_spec", "--confirmed"), /decisions\.md/);
  writeFileSync(join(taskDirectory, "decisions.md"), "用户内容\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation", "--confirmed"), /只能从/);

  let status = runJson("task", "phase", task.path, "implementation_spec", "--confirmed");
  assert.equal(status.phase, "implementation_spec");
  assert.deepEqual(status.next_phases, ["implementation"]);
  assert.equal(existsSync(join(taskDirectory, "technical-design.md")), false);
  writeFileSync(join(taskDirectory, "spec.md"), "# Spec\n\nAC-002\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation", "--confirmed"), /AC ID.*不一致/);
  writeFileSync(join(taskDirectory, "spec.md"), "# Spec\n\nAC-001\n\nC:\\Users\\tester\\repo\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation", "--confirmed"), /本机绝对路径/);
  writeFileSync(join(taskDirectory, "spec.md"), "# Spec\n\nAC-001\n", "utf8");
  mkdirSync(join(taskDirectory, "slices"));
  writeFileSync(join(taskDirectory, "slices", "01-core.md"), "证据在 C:\\Users\\tester\\repo\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation", "--confirmed"), /本机绝对路径/);
  rmSync(join(taskDirectory, "slices"), { recursive: true, force: true });
  status = runJson("task", "phase", task.path, "implementation", "--confirmed");
  assert.equal(status.git.baseline.length, 2);
  assert.deepEqual(Object.keys(status.git.baseline[0]).sort(), ["branch", "dirty_paths", "head", "id"]);
  assert.equal(readFileSync(join(taskDirectory, "task.json"), "utf8").includes(resolve(backend)), false);
  assert.equal(extractManagedJson(readFileSync(join(workflow, "AGENTS.local.md"), "utf8")).task_bindings.length, 1);

  writeFileSync(join(backend, "README.md"), "# Changed but uncommitted\n", "utf8");
  run("task", "phase", task.path, "verification", "--confirmed");
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /verification\.md/);
  writeFileSync(join(taskDirectory, "verification.md"), "# 验证\n\nAC-001\n", "utf8");
  const backendClone = join(dirname(backend), "backend clone");
  git(dirname(backend), "clone", backend, backendClone);
  runJson(
    "setup",
    "--agent",
    "codex",
    "--repo",
    `backend=${backendClone}`,
    "--repo",
    `frontend=${frontend}`,
  );
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /仓库映射.*变化/);
  const swappedSetup = runJson(
    "setup",
    "--agent",
    "codex",
    "--repo",
    `backend=${frontend}`,
    "--repo",
    `frontend=${backend}`,
  );
  assert.ok(swappedSetup.actions.some((item) => item.action === "updated" && item.path === "AGENTS.local.md"));
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /仓库映射.*变化/);
  run("setup", "--agent", "codex", ...repositories);

  const localConfigPath = join(workflow, "AGENTS.local.md");
  const originalLocalConfig = readFileSync(localConfigPath, "utf8");
  const missingBindingConfig = extractManagedJson(originalLocalConfig);
  missingBindingConfig.task_bindings = [];
  missingBindingConfig.repositories.find((repository) => repository.id === "backend").path = backendClone;
  writeFileSync(localConfigPath, replaceManagedBlock(originalLocalConfig, missingBindingConfig), "utf8");
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /绑定已丢失/);
  writeFileSync(localConfigPath, originalLocalConfig, "utf8");

  status = runJson("task", "phase", task.path, "done", "--confirmed");
  assert.equal(status.git.final.length, 2);
  assert.ok(status.git.final.find((repo) => repo.id === "backend").dirty_paths.includes("README.md"));
  assert.equal(extractManagedJson(readFileSync(join(workflow, "AGENTS.local.md"), "utf8")).task_bindings.length, 1);
  status = runJson("task", "reopen", task.path, "--confirmed");
  assert.equal(status.phase, "verification");
  assert.equal(status.git.final, null);
  run("task", "phase", task.path, "done", "--confirmed");

  const reviewedTask = runJson(
    "task",
    "create",
    "--iteration",
    iteration.id,
    "--title",
    "需要技术评审",
  );
  const reviewedDirectory = join(workflow, reviewedTask.path);
  writeFileSync(join(reviewedDirectory, "prd.md"), "# PRD\n\n### AC-001 契约\n", "utf8");
  writeFileSync(join(reviewedDirectory, "decisions.md"), "用户内容\n", "utf8");
  run("task", "phase", reviewedTask.path, "technical_design", "--confirmed");
  writeFileSync(join(reviewedDirectory, "technical-design.md"), "# 技术方案\n\n接口评审结论\n", "utf8");
  status = runJson("task", "phase", reviewedTask.path, "implementation_spec", "--confirmed");
  assert.equal(status.phase, "implementation_spec");
});

test("iteration lifecycle 支持无发布方案收口和可移植性检查", (t) => {
  const { workflow, backend, frontend, run, runJson, fail } = createWorkflow(t);
  const repositories = ["--repo", `backend=${backend}`, "--repo", `frontend=${frontend}`];
  run("setup", "--agent", "codex", ...repositories);
  const iteration = runJson("iteration", "create", "--title", "首个迭代");

  const unfinishedIteration = runJson("iteration", "create", "--title", "未完成迭代");
  runJson("task", "create", "--iteration", unfinishedIteration.id, "--title", "未完成任务");
  assert.match(fail("iteration", "close", unfinishedIteration.id, "--confirmed"), /未完成任务/);

  const change = runJson(
    "simple-change",
    "add",
    "--iteration",
    iteration.id,
    "--summary",
    "补充局部修改",
    "--repositories",
    "backend",
  );
  assert.equal(change.git[0].id, "backend");
  assert.match(
    fail("simple-change", "add", "--iteration", iteration.id, "--summary", "   "),
    /不能为空/,
  );
  let iterationState = runJson("iteration", "status", iteration.id);
  assert.equal(iterationState.tasks.length, 0);
  assert.equal(iterationState.simple_changes.length, 1);
  writeFileSync(join(workflow, "iterations", iteration.id, "release-plan.md"), "# Release\n\nC:\\Users\\tester\\artifact\n", "utf8");
  assert.match(fail("iteration", "status", iteration.id, "--check"), /本机绝对路径/);
  assert.match(fail("iteration", "close", iteration.id, "--confirmed"), /本机绝对路径/);
  writeFileSync(join(workflow, "iterations", iteration.id, "release-plan.md"), "# Release\n", "utf8");
  const releaseArtifacts = join(workflow, "iterations", iteration.id, "artifacts");
  mkdirSync(releaseArtifacts);
  writeFileSync(join(releaseArtifacts, "evidence.html"), "<p>C:\\Users\\tester\\result.json</p>\n", "utf8");
  assert.match(fail("iteration", "status", iteration.id, "--check"), /本机绝对路径/);
  rmSync(join(releaseArtifacts, "evidence.html"));
  const linkedArtifacts = join(dirname(workflow), "linked artifacts");
  mkdirSync(linkedArtifacts);
  symlinkSync(linkedArtifacts, join(releaseArtifacts, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.match(fail("iteration", "status", iteration.id, "--check"), /符号链接/);
  rmSync(join(releaseArtifacts, "linked"), { recursive: true, force: true });
  rmSync(linkedArtifacts, { recursive: true, force: true });
  assert.equal(runJson("iteration", "status", iteration.id, "--check").checks.portable_files, "pass");
  rmSync(releaseArtifacts, { recursive: true, force: true });
  rmSync(join(workflow, "iterations", iteration.id, "release-plan.md"));
  assert.equal(runJson("iteration", "status", iteration.id).release_plan.exists, false);
  iterationState = runJson("iteration", "close", iteration.id, "--confirmed");
  assert.equal(iterationState.status, "closed");
  assert.ok(runJson("iteration", "list", "--status", "closed").some((item) => item.id === iteration.id));
  assert.equal(runJson("task", "list").length, 1);

  const cancelledIteration = runJson("iteration", "create", "--title", "取消迭代");
  const cancelledTask = runJson(
    "task",
    "create",
    "--iteration",
    cancelledIteration.id,
    "--title",
    "取消任务",
  );
  let status = runJson("task", "cancel", cancelledTask.path, "--confirmed");
  assert.equal(status.cancelled_from, "prd");
  status = runJson("task", "reopen", cancelledTask.path, "--confirmed");
  assert.equal(status.phase, "prd");
  run("task", "cancel", cancelledTask.path, "--confirmed");
  assert.equal(runJson("iteration", "cancel", cancelledIteration.id, "--confirmed").status, "cancelled");

  const sourceIteration = runJson("iteration", "create", "--title", "来源迭代");
  const targetIteration = runJson("iteration", "create", "--title", "目标迭代");
  const movedTask = runJson("task", "create", "--iteration", sourceIteration.id, "--title", "移动任务");
  const moved = runJson("task", "move", movedTask.path, "--iteration", targetIteration.id);
  assert.equal(moved.iteration, targetIteration.id);
});
