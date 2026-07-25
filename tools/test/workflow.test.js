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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  extractManagedJson,
  findSecretPaths,
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
  writeFileSync(join(directory, "README.md"), "# Repository\n", "utf8");
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
  assert.throws(() => parseIterationData({ ...iteration, revision: 1 }), /未知字段/);

  const task = {
    title: "任务",
    phase: "prd",
    repositories: [],
    created_at: new Date().toISOString(),
    cancelled_from: null,
    git: { baseline: null, final: null },
  };
  assert.equal(parseTaskData(task), task);
  assert.throws(() => parseTaskData({ ...task, checkpoints: {} }), /未知字段/);
});

test("公开命令面不再暴露已删除能力", () => {
  const workflowFiles = readdirSync(join(REPOSITORY_ROOT, "tools", "workflow")).sort();
  assert.deepEqual(workflowFiles, [
    "common.js",
    "doctor.js",
    "iterations.js",
    "setup.js",
    "tasks.js",
  ]);
  assert.equal(existsSync(join(REPOSITORY_ROOT, "tools", "agent-adapters.json")), false);
  const help = execFileSync(process.execPath, [join(REPOSITORY_ROOT, "tools", "workflow.js"), "help"], {
    encoding: "utf8",
  });
  for (const removed of [
    "task validate",
    "task slice",
    "task candidates",
    "memory ",
    "context ",
    "adapter install",
    "release-plan",
    " delete",
  ]) {
    assert.doesNotMatch(help, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("工作流提示词不再要求调用已删除命令", () => {
  const files = [
    "AGENTS.md",
    "README.md",
    ".agents/skills/sw-setup/SKILL.md",
    ".agents/skills/sw-doctor/SKILL.md",
    ".agents/skills/sw-route-task/SKILL.md",
    ".agents/skills/sw-prd/SKILL.md",
    ".agents/skills/sw-technical-design/SKILL.md",
    ".agents/skills/sw-spec/SKILL.md",
    ".agents/skills/sw-implement/SKILL.md",
    ".agents/skills/sw-verify/SKILL.md",
    ".agents/skills/sw-release-plan/SKILL.md",
    ".agents/skills/sw-simple-change/SKILL.md",
    ".agents/skills/sw-domain-modeling/SKILL.md",
    ".agents/skills/sw-fix-bug/SKILL.md",
    ".agents/skills/handoff/SKILL.md",
  ];
  const content = files.map((file) => readFileSync(join(REPOSITORY_ROOT, file), "utf8")).join("\n");
  for (const removed of [
    "task candidates",
    "task validate",
    "task slices",
    "task slice ",
    "expected-revision",
    "adapter install",
    "iteration release-plan",
    "confirm-release-plan",
    "iteration done",
    "changes.jsonl",
    "project/memory.json",
  ]) {
    assert.doesNotMatch(content, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("CLI 完成接入、任务状态、Git 快照、simple change 和迭代收口", (t) => {
  const { workflow, backend, frontend, invoke, run, runJson, fail } = createWorkflow(t);
  const repositories = ["--repo", `backend=${backend}`, "--repo", `frontend=${frontend}`];

  const setup = runJson("setup", "--agent", "codex", ...repositories);
  assert.equal(setup.config.agent.id, "codex");
  assert.deepEqual(setup.config.repositories.map((repo) => repo.id), ["backend", "frontend"]);
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
  run("setup", "--agent", "codex", ...repositories);
  assert.equal(existsSync(join(workflow, "CLAUDE.md")), false);
  assert.match(fail("setup", "--agent", "bad", "--entry-path", "../outside.md", ...repositories), /边界/);

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
  assert.match(
    fail("task", "create", "--iteration", iteration.id, "--title", "   "),
    /不能为空/,
  );
  assert.equal(runJson("task", "list").length, 1);
  assert.match(fail("task", "phase", task.path, "technical_design", "--confirmed"), /prd\.md/);
  writeFileSync(join(taskDirectory, "prd.md"), "", "utf8");
  writeFileSync(join(taskDirectory, "decisions.md"), "用户内容\n", "utf8");
  assert.match(fail("task", "phase", task.path, "implementation_spec", "--confirmed"), /只能从/);

  let status = runJson("task", "phase", task.path, "technical_design", "--confirmed");
  assert.equal(status.phase, "technical_design");
  writeFileSync(join(taskDirectory, "technical-design.md"), "", "utf8");
  run("task", "phase", task.path, "implementation_spec", "--confirmed");
  writeFileSync(join(taskDirectory, "spec.md"), "", "utf8");
  status = runJson("task", "phase", task.path, "implementation", "--confirmed");
  assert.equal(status.git.baseline.length, 2);
  assert.equal(status.git.baseline[0].root, resolve(backend));

  writeFileSync(join(backend, "README.md"), "# Changed but uncommitted\n", "utf8");
  run("task", "phase", task.path, "verification", "--confirmed");
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /verification\.md/);
  writeFileSync(join(taskDirectory, "verification.md"), "", "utf8");
  run(
    "setup",
    "--agent",
    "codex",
    "--repo",
    `backend=${frontend}`,
    "--repo",
    `frontend=${backend}`,
  );
  assert.match(fail("task", "phase", task.path, "done", "--confirmed"), /仓库映射.*变化/);
  run("setup", "--agent", "codex", ...repositories);
  status = runJson("task", "phase", task.path, "done", "--confirmed");
  assert.equal(status.git.final.length, 2);
  assert.ok(status.git.final.find((repo) => repo.id === "backend").dirty_paths.includes("README.md"));
  status = runJson("task", "reopen", task.path, "--confirmed");
  assert.equal(status.phase, "verification");
  assert.equal(status.git.final, null);
  run("task", "phase", task.path, "done", "--confirmed");

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
  assert.equal(iterationState.tasks[0].phase, "done");
  assert.equal(iterationState.simple_changes.length, 1);
  assert.match(fail("iteration", "close", iteration.id, "--confirmed"), /release-plan\.md/);
  writeFileSync(join(workflow, "iterations", iteration.id, "release-plan.md"), "# Release\n", "utf8");
  iterationState = runJson("iteration", "close", iteration.id, "--confirmed");
  assert.equal(iterationState.status, "closed");
  assert.ok(runJson("iteration", "list", "--status", "closed").some((item) => item.id === iteration.id));
  assert.equal(runJson("task", "list").length, 0);

  const cancelledIteration = runJson("iteration", "create", "--title", "取消迭代");
  const cancelledTask = runJson(
    "task",
    "create",
    "--iteration",
    cancelledIteration.id,
    "--title",
    "取消任务",
  );
  status = runJson("task", "cancel", cancelledTask.path, "--confirmed");
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

  const broken = join(workflow, "iterations", "broken", "bad-task");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(dirname(broken), "iteration.json"), "{}\n", "utf8");
  writeFileSync(join(broken, "task.json"), "{}\n", "utf8");
  assert.equal(runJson("doctor").some((check) => check.level === "error"), false);
  assert.match(fail("task", "validate", moved.path), /未知命令/);
});
