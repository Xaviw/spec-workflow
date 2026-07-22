import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  LOCAL_CONFIG_FILE,
  ROOT,
  assertNoSecrets,
  ensureWithin,
  isGitRepository,
  optionList,
  readJson,
  readLocalConfig,
  readText,
  replaceManagedBlock,
  runGit,
  slugify,
  writeText,
} from "./common.js";
import { ensureAdapterIgnored, installAdapter } from "./adapter.js";

function safeRemote(path) {
  const remote = runGit(["config", "--get", "remote.origin.url"], path, true);
  if (/https?:\/\/[^\s/:@]+:[^\s/@]+@/.test(remote)) {
    return "";
  }
  return remote;
}

function currentGitEmails() {
  const values = [
    runGit(["config", "--get", "user.email"], ROOT, true),
    runGit(["config", "--global", "--get", "user.email"], ROOT, true),
  ].filter(Boolean);
  return [...new Set(values)];
}

function detectedRepositoryDefaults(path) {
  let startCommand = "";
  let runtime = "";
  const packageFile = join(path, "package.json");
  if (existsSync(packageFile)) {
    try {
      const packageJson = readJson(packageFile);
      if (packageJson.scripts?.dev) {
        startCommand = "npm run dev";
      } else if (packageJson.scripts?.start) {
        startCommand = "npm start";
      }
      runtime = packageJson.engines?.node || "";
    } catch {
      // setup 会让用户确认无法解析的事实。
    }
  }
  const envVarNames = [];
  for (const name of [".env.example", ".env.sample"]) {
    const envFile = join(path, name);
    if (!existsSync(envFile)) {
      continue;
    }
    for (const line of readText(envFile).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) {
        envVarNames.push(match[1]);
      }
    }
  }
  return {
    startCommand,
    runtime,
    envVarNames: [...new Set(envVarNames)],
  };
}

async function ask(rl, label, defaultValue = "") {
  const suffix = defaultValue ? " [" + defaultValue + "]" : "";
  const answer = (await rl.question(label + suffix + ": ")).trim();
  return answer || defaultValue;
}

async function collectSetupConfig() {
  const adapters = readJson(join(ROOT, "tools", "agent-adapters.json"));
  const existing = readLocalConfig() || {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const projectName = await ask(
      rl,
      "项目名称",
      existing.project?.name || basename(ROOT),
    );
    const goal = await ask(rl, "项目目标", existing.project?.goal || "");
    if (!goal) {
      throw new Error("项目目标不能为空");
    }
    const agentChoices = adapters.agents
      .map((agent) => agent.id + " (" + agent.display_name + ")")
      .join(", ");
    console.log("可选 Agent: " + agentChoices + ", custom");
    const agentId = await ask(rl, "当前 Agent", existing.agent?.id || "codex");
    const knownAgent = adapters.agents.find((agent) => agent.id === agentId);
    let agent;
    if (knownAgent) {
      agent = { id: knownAgent.id };
    } else if (agentId === "custom") {
      agent = {
        id: "custom",
        display_name: await ask(
          rl,
          "自定义 Agent 名称",
          existing.agent?.display_name || "",
        ),
        entry_path: await ask(
          rl,
          "项目入口文件路径",
          existing.agent?.entry_path || "",
        ),
        skills_path: await ask(
          rl,
          "项目 Skills 目录",
          existing.agent?.skills_path || "",
        ),
        entry_content: await ask(
          rl,
          "入口中用于引入 AGENTS.md 的内容",
          existing.agent?.entry_content || "请读取并遵循根目录 AGENTS.md",
        ),
      };
    } else {
      throw new Error("未知 Agent: " + agentId);
    }

    const detectedEmails = (existing.git_emails || currentGitEmails()).join(",");
    const gitEmails = optionList(await ask(rl, "你的 Git 邮箱，逗号分隔", detectedEmails));
    const repositories = [...(existing.repositories || [])];
    if (repositories.length) {
      const keep = (
        await ask(
          rl,
          "保留现有代码仓库配置 " + repositories.map((repo) => repo.id).join(", ") + "？yes/no",
          "yes",
        )
      ).toLowerCase();
      if (keep !== "yes") {
        repositories.length = 0;
      }
    }
    while (true) {
      const rawPath = await ask(
        rl,
        repositories.length
          ? "继续添加代码仓库路径，留空结束"
          : "代码仓库路径",
      );
      if (!rawPath && repositories.length) {
        break;
      }
      if (!rawPath) {
        throw new Error("至少登记一个代码仓库");
      }
      const repoPath = resolve(rawPath.replace(/^["']|["']$/g, ""));
      if (!existsSync(repoPath) || !isGitRepository(repoPath)) {
        throw new Error("目标必须是现有 Git 仓库: " + repoPath);
      }
      const defaults = detectedRepositoryDefaults(repoPath);
      const id = slugify(
        await ask(rl, "仓库稳定 ID", slugify(basename(repoPath), "repo")),
        "repo",
      );
      if (repositories.some((repo) => repo.id === id)) {
        throw new Error("仓库 ID 重复: " + id);
      }
      const role = await ask(rl, "仓库角色");
      const modules = optionList(await ask(rl, "主要模块，逗号分隔"));
      const command = await ask(rl, "项目启动命令", defaults.startCommand);
      const portText = await ask(rl, "启动端口，可留空");
      const runtime = await ask(rl, "运行时版本范围，可留空", defaults.runtime);
      const envVarNames = optionList(
        await ask(rl, "所需环境变量名，逗号分隔", defaults.envVarNames.join(",")),
      );
      const configCenter = await ask(rl, "配置中心或外部服务依赖，可填 unknown", "unknown");
      const integrationMode = await ask(
        rl,
        "联调方式，例如 direct 或 whistle",
        "direct",
      );
      const availableEnvironments = optionList(
        await ask(rl, "环境列表，逗号分隔", "local"),
      );
      const localOperable = optionList(
        await ask(rl, "本地允许操作的环境，逗号分隔", "local"),
      );
      const remoteRead = optionList(
        await ask(rl, "明确允许远程只读的环境，逗号分隔，默认无"),
      );
      const remoteWrite = optionList(
        await ask(rl, "明确允许远程写入的非生产环境，逗号分隔，默认无"),
      );
      const switchMethod = await ask(
        rl,
        "环境切换或修改方式，可填 unknown",
        "unknown",
      );
      repositories.push({
        id,
        path: repoPath,
        remote: safeRemote(repoPath),
        role: role || "unknown",
        modules,
        start: {
          command: command || "unknown",
          port: portText ? Number(portText) : null,
          runtime: runtime || null,
        },
        dependencies: {
          env_var_names: envVarNames,
          config_center: configCenter || "unknown",
        },
        integration: { mode: integrationMode || "unknown" },
        environments: {
          available: availableEnvironments,
          local_operable: localOperable,
          remote_read: remoteRead,
          remote_write: remoteWrite,
          switch_method: switchMethod || "unknown",
        },
      });
    }
    return {
      schema_version: 1,
      workflow_version: readText(join(ROOT, "WORKFLOW_VERSION")).trim(),
      project: { name: projectName, goal },
      agent,
      git_emails: gitEmails,
      repositories,
      permissions: {
        production_write: false,
        deploy: false,
        ddl_execute: false,
      },
    };
  } finally {
    rl.close();
  }
}

export function validateSetupConfig(config, root = ROOT) {
  if (!config?.project?.name || !config?.project?.goal) {
    throw new Error("setup 配置缺少项目名称或目标");
  }
  if (!config?.agent?.id) {
    throw new Error("setup 配置缺少 Agent");
  }
  if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
    throw new Error("setup 配置至少需要一个代码仓库");
  }
  const ids = new Set();
  for (const repo of config.repositories) {
    if (!repo.id || !repo.path || ids.has(repo.id)) {
      throw new Error("仓库 ID 或路径无效，或 ID 重复");
    }
    ids.add(repo.id);
    if (!existsSync(repo.path) || !isGitRepository(repo.path)) {
      throw new Error("目标不是 Git 仓库: " + repo.path);
    }
    if (repo.start?.port !== null && repo.start?.port !== undefined) {
      if (!Number.isInteger(repo.start.port) || repo.start.port < 1 || repo.start.port > 65535) {
        throw new Error("端口无效: " + repo.id);
      }
    }
    const available = new Set(repo.environments?.available || []);
    for (const environment of [
      ...(repo.environments?.local_operable || []),
      ...(repo.environments?.remote_read || []),
      ...(repo.environments?.remote_write || []),
    ]) {
      if (!available.has(environment)) {
        throw new Error(repo.id + " 的环境权限未出现在环境列表中: " + environment);
      }
    }
    if (
      (repo.environments?.remote_write || []).some((environment) =>
        /^(prod|production|prd)$/i.test(environment),
      )
    ) {
      throw new Error(repo.id + " 不得授权 Agent 写入生产环境");
    }
  }
  if (
    config.permissions?.production_write !== false ||
    config.permissions?.deploy !== false ||
    config.permissions?.ddl_execute !== false
  ) {
    throw new Error("production_write、deploy 和 ddl_execute 必须保持 false");
  }
  if (config.agent.id === "custom") {
    if (!config.agent.entry_path || !config.agent.skills_path) {
      throw new Error("自定义 Agent 缺少入口或 Skills 目录");
    }
    ensureWithin(root, resolve(root, config.agent.entry_path));
    ensureWithin(root, resolve(root, config.agent.skills_path));
  }
  assertNoSecrets(config);
}

function publicRepositoryData(repo) {
  return {
    id: repo.id,
    role: repo.role,
    modules: repo.modules,
    start: repo.start,
    dependencies: repo.dependencies,
    integration: repo.integration,
    environments: {
      available: repo.environments?.available || [],
      switch_method: repo.environments?.switch_method || "unknown",
    },
  };
}

function writeProjectDocs(config) {
  const projectDir = join(ROOT, "project");
  const repositoriesDir = join(projectDir, "repositories");
  mkdirSync(repositoriesDir, { recursive: true });
  const indexData = {
    name: config.project.name,
    goal: config.project.goal,
    repositories: config.repositories.map((repo) => ({
      id: repo.id,
      role: repo.role,
      modules: repo.modules,
    })),
  };
  const indexFile = join(projectDir, "index.md");
  const indexBase = readText(
    indexFile,
    "# 项目索引\n\n这里记录已确认的项目目标和代码仓库导航。\n",
  );
  writeText(
    indexFile,
    replaceManagedBlock(
      indexBase,
      indexData,
      "<!-- spec-driven:project:start -->",
      "<!-- spec-driven:project:end -->",
    ),
  );
  for (const repo of config.repositories) {
    const path = join(repositoriesDir, repo.id + ".md");
    const base = readText(
      path,
      "# " + repo.id + "\n\n在受管块之外补充该仓库已确认的长期说明。\n",
    );
    writeText(
      path,
      replaceManagedBlock(
        base,
        publicRepositoryData(repo),
        "<!-- spec-driven:repository:start -->",
        "<!-- spec-driven:repository:end -->",
      ),
    );
  }
}

function applySetup(config) {
  validateSetupConfig(config);
  if (!isGitRepository(ROOT)) {
    throw new Error("工作流根目录必须先初始化为 Git 仓库");
  }
  const adapterPlan = installAdapter(config.agent.id, config);
  if (adapterPlan.some((item) => item.action === "conflict")) {
    throw new Error("Agent 适配器存在冲突；请先预览 adapter install 并决定是否替换");
  }
  const localBase = readText(
    LOCAL_CONFIG_FILE,
    "# 本地工作流设置\n\n受管块外可记录不含密钥的个人说明；本文件不得提交。\n",
  );
  writeText(LOCAL_CONFIG_FILE, replaceManagedBlock(localBase, config));
  writeProjectDocs(config);
  installAdapter(config.agent.id, config, { apply: true });
  ensureAdapterIgnored(config.agent.id, config);
}

export async function runSetup(options) {
  let config;
  let interactive = false;
  if (options.config) {
    config = readJson(resolve(process.cwd(), String(options.config)));
  } else {
    interactive = true;
    config = await collectSetupConfig();
  }
  config.workflow_version = readText(join(ROOT, "WORKFLOW_VERSION")).trim();
  validateSetupConfig(config);
  console.log(JSON.stringify(config, null, 2));
  console.log(
    "\nAgent 适配预览:\n" +
      JSON.stringify(installAdapter(config.agent.id, config), null, 2),
  );
  if (!options.apply && !interactive) {
    console.log("\n以上为预览；确认后添加 --apply。");
    return;
  }
  if (interactive && !options.apply) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirmed = (await ask(rl, "确认写入？输入 yes", "no")).toLowerCase();
    rl.close();
    if (confirmed !== "yes") {
      console.log("未写入。");
      return;
    }
  }
  applySetup(config);
  console.log("setup 已写入。请运行 node tools/workflow.js doctor。");
}
