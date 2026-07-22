import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SKILLS,
  assertNoSecrets,
  ensureWithin,
  extractManagedJson,
  replaceManagedBlock,
} from "../workflow/common.js";
import { installAdapter } from "../workflow/adapter.js";
import { buildContextPaths } from "../workflow/context.js";
import { aggregateRelease } from "../workflow/release.js";
import { canTransition } from "../workflow/tasks.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "spec-driven-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
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
  writeFileSync(join(root, "AGENTS.md"), "# A", "utf8");
  writeFileSync(join(root, "AGENTS.local.md"), "# L", "utf8");
  writeFileSync(
    join(root, ".agents", "skills", "spec-driven-prd", "SKILL.md"),
    "# S\n\n## 上下文契约\n\n必读：`task.json`、`prd.md`、`decisions.md`。\n\n按需读取：相关项目文档。\n\n初始禁止：其他任务。\n\n输出：当前 PRD。\n",
    "utf8",
  );
  const context = buildContextPaths("spec-driven-prd", task, root);
  assert.ok(context.required.includes("iterations/i/task-a/prd.md"));
  assert.ok(!context.required.some((path) => path.includes("other-task")));
  assert.ok(!context.required.some((path) => path.startsWith("project/knowledge")));
});

test("任务移动和删除的路径守卫拒绝逃逸", (t) => {
  const root = temporaryDirectory(t);
  const iterations = join(root, "iterations");
  mkdirSync(iterations);
  assert.equal(
    ensureWithin(iterations, join(iterations, "i", "task")),
    join(iterations, "i", "task"),
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
  mkdirSync(join(workflow, "tools"), { recursive: true });
  mkdirSync(target);
  cpSync(join(sourceRoot, ".agents"), join(workflow, ".agents"), {
    recursive: true,
  });
  for (const path of ["AGENTS.md", "WORKFLOW_VERSION"]) {
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
  for (const directory of [workflow, target]) {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
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
    "backend",
  );
  const normalizedTaskPath = taskPath.replaceAll("\\", "/");
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
  writeFileSync(join(workflow, taskPath, "prd.md"), "本地更新\n", "utf8");
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
  for (const phase of [
    "technical_design",
    "implementation_spec",
    "implementation",
    "verification",
  ]) {
    assert.throws(() => run("task", "phase", taskPath, phase));
    run("task", "phase", taskPath, phase, "--confirmed");
  }
  assert.doesNotThrow(() =>
    run("context", "spec-driven-code-review", "--json"),
  );
  run("task", "phase", taskPath, "done", "--confirmed");
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
  run("iteration", "confirm-release-plan", iterationId, "--confirmed");
  writeFileSync(releasePlanPath, completedPlan + "确认后修改。\n", "utf8");
  assert.throws(() => run("iteration", "done", iterationId, "--confirmed"));
  writeFileSync(releasePlanPath, completedPlan, "utf8");
  run("iteration", "done", iterationId, "--confirmed");
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
});
