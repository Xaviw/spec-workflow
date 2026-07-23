import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
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
  writeText,
} from "./common.js";
import { ensureAdapterIgnored, installAdapter } from "./adapter.js";

function canonicalPathKey(path) {
  return normalize(path);
}

function canonicalRealpath(path) {
  const resolver = realpathSync.native || realpathSync;
  return resolver(resolve(path));
}

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertPortableRepositoryId(value) {
  const id = String(value || "");
  if (
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id) ||
    WINDOWS_RESERVED_NAMES.test(id)
  ) {
    throw new Error(
      "仓库 ID 必须是 1-64 位小写 ASCII 字母、数字、点、下划线或连字符，" +
        "首尾为字母或数字，且不能使用 Windows 保留名",
    );
  }
  return id;
}

function suggestedRepositoryId(value) {
  const id = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/g, "");
  return id && !WINDOWS_RESERVED_NAMES.test(id) ? id : "repo";
}

function remoteUserInfo(remote) {
  const match = String(remote || "").trim().match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (!match) {
    return "";
  }
  const authority = match[2].split(/[/?#]/, 1)[0];
  const at = authority.lastIndexOf("@");
  return at < 0 ? "" : authority.slice(0, at);
}

export function sanitizeGitRemote(remote) {
  const value = String(remote || "").trim();
  const match = value.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (!match) {
    return value;
  }
  const boundary = match[2].search(/[/?#]/);
  const authority = boundary < 0 ? match[2] : match[2].slice(0, boundary);
  const suffix = boundary < 0 ? "" : match[2].slice(boundary);
  const at = authority.lastIndexOf("@");
  return match[1] + (at < 0 ? authority : authority.slice(at + 1)) + suffix;
}

function comparableRemote(remote) {
  return sanitizeGitRemote(remote).replace(/\/+$/, "");
}

function remoteMayContainCredential(remote) {
  const userInfo = remoteUserInfo(remote);
  if (!userInfo) {
    return false;
  }
  const username = userInfo.split(":", 1)[0].toLowerCase();
  return userInfo.includes(":") || !["git", "hg", "svn"].includes(username);
}

export function inspectRepositoryRoot(path) {
  if (!path || !existsSync(path)) {
    throw new Error("目标仓库路径不存在");
  }
  const requestedRoot = canonicalRealpath(path);
  if (!isGitRepository(requestedRoot)) {
    throw new Error("目标不是 Git 工作树");
  }
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], requestedRoot);
  const canonicalRoot = canonicalRealpath(gitRoot);
  if (canonicalPathKey(requestedRoot) !== canonicalPathKey(canonicalRoot)) {
    throw new Error("目标路径必须是 Git 仓库根目录");
  }
  return {
    path: canonicalRoot,
    path_key: canonicalPathKey(canonicalRoot),
    remote: sanitizeGitRemote(
      runGit(["config", "--get", "remote.origin.url"], canonicalRoot, true),
    ),
  };
}

export function assertRepositoryRegistration(repo) {
  if (!repo?.id || !repo.path) {
    throw new Error("仓库 ID 或路径无效");
  }
  assertPortableRepositoryId(repo.id);
  const identity = inspectRepositoryRoot(repo.path);
  if (Object.hasOwn(repo, "remote")) {
    if (remoteMayContainCredential(repo.remote)) {
      throw new Error("仓库 " + repo.id + " 的 remote 含疑似凭据");
    }
    if (comparableRemote(repo.remote) !== comparableRemote(identity.remote)) {
      throw new Error("仓库 " + repo.id + " 的 origin remote 已漂移");
    }
  }
  return identity;
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

async function ask(rl, label, defaultValue = "", allowClear = false) {
  const suffix = defaultValue ? " [" + defaultValue + "]" : "";
  const clearHint = allowClear ? "（输入 - 清空）" : "";
  const answer = (await rl.question(label + suffix + clearHint + ": ")).trim();
  if (allowClear && answer === "-") {
    return "";
  }
  return answer || defaultValue;
}

export async function collectDetailedRepositoryConfig(rl, repository, defaults) {
  const prefix = repository.id + " ";
  const port = repository.start?.port;
  const modules = optionList(
    await ask(
      rl,
      prefix + "主要模块，逗号分隔",
      (repository.modules || []).join(","),
      true,
    ),
  );
  const command = await ask(
    rl,
    prefix + "项目启动命令",
    repository.start?.command || defaults.startCommand,
    true,
  );
  const portText = await ask(
    rl,
    prefix + "启动端口，可留空",
    port === null || port === undefined ? "" : String(port),
    true,
  );
  const runtime = await ask(
    rl,
    prefix + "运行时版本范围，可留空",
    repository.start?.runtime || defaults.runtime,
    true,
  );
  const envVarNames = optionList(
    await ask(
      rl,
      prefix + "所需环境变量名，逗号分隔",
      (repository.dependencies?.env_var_names || defaults.envVarNames).join(","),
      true,
    ),
  );
  const configCenter = await ask(
    rl,
    prefix + "配置中心或外部服务依赖，可填 unknown",
    repository.dependencies?.config_center || "unknown",
    true,
  );
  const integrationMode = await ask(
    rl,
    prefix + "联调方式，例如 direct 或 whistle",
    repository.integration?.mode || "direct",
    true,
  );
  const availableEnvironments = optionList(
    await ask(
      rl,
      prefix + "环境列表，逗号分隔",
      (repository.environments?.available || ["local"]).join(","),
      true,
    ),
  );
  const localOperable = optionList(
    await ask(
      rl,
      prefix + "本地允许操作的环境，逗号分隔",
      (repository.environments?.local_operable || ["local"]).join(","),
      true,
    ),
  );
  const remoteRead = optionList(
    await ask(
      rl,
      prefix + "明确允许远程只读的环境，逗号分隔，默认无",
      (repository.environments?.remote_read || []).join(","),
      true,
    ),
  );
  const remoteWrite = optionList(
    await ask(
      rl,
      prefix + "明确允许远程写入的非生产环境，逗号分隔，默认无",
      (repository.environments?.remote_write || []).join(","),
      true,
    ),
  );
  const switchMethod = await ask(
    rl,
    prefix + "环境切换或修改方式，可填 unknown",
    repository.environments?.switch_method || "unknown",
    true,
  );
  return {
    ...repository,
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
  };
}

async function collectSetupConfig(options = {}) {
  const adapters = readJson(join(ROOT, "tools", "agent-adapters.json"));
  const existing = readLocalConfig() || {};
  const detailed = options.detailed === true;
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
      } else if (detailed) {
        for (const [index, repository] of repositories.entries()) {
          const identity = assertRepositoryRegistration(repository);
          const role = await ask(
            rl,
            repository.id + " 仓库角色",
            repository.role || "unknown",
          );
          repositories[index] = await collectDetailedRepositoryConfig(
            rl,
            {
              ...repository,
              path: identity.path,
              remote: identity.remote,
              role: role || "unknown",
            },
            detectedRepositoryDefaults(identity.path),
          );
        }
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
      const requestedPath = resolve(rawPath.replace(/^["']|["']$/g, ""));
      let repositoryIdentity;
      try {
        repositoryIdentity = inspectRepositoryRoot(requestedPath);
      } catch (error) {
        throw new Error("目标必须是现有 Git 仓库根目录: " + error.message);
      }
      const repoPath = repositoryIdentity.path;
      const defaults = detectedRepositoryDefaults(repoPath);
      const id = assertPortableRepositoryId(
        await ask(
          rl,
          "仓库稳定 ID",
          suggestedRepositoryId(basename(repoPath)),
        ),
      );
      if (repositories.some((repo) => repo.id === id)) {
        throw new Error("仓库 ID 重复: " + id);
      }
      for (const repo of repositories) {
        if (assertRepositoryRegistration(repo).path_key === repositoryIdentity.path_key) {
          throw new Error("代码仓库路径重复: " + id);
        }
      }
      const role = await ask(rl, id + " 仓库角色", "unknown");
      let repository = {
        id,
        path: repoPath,
        remote: repositoryIdentity.remote,
        role: role || "unknown",
        modules: [],
        start: {
          command: defaults.startCommand || "unknown",
          port: null,
          runtime: defaults.runtime || null,
        },
        dependencies: {
          env_var_names: defaults.envVarNames,
          config_center: "unknown",
        },
        integration: { mode: "direct" },
        environments: {
          available: ["local"],
          local_operable: ["local"],
          remote_read: [],
          remote_write: [],
          switch_method: "unknown",
        },
      };
      if (detailed) {
        repository = await collectDetailedRepositoryConfig(
          rl,
          repository,
          defaults,
        );
      }
      repositories.push(repository);
    }
    return {
      schema_version: 1,
      workflow_version: readJson(join(ROOT, "tools", "package.json")).version,
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
  const canonicalPaths = new Set();
  for (const repo of config.repositories) {
    const id = assertPortableRepositoryId(repo.id);
    if (!repo.path || ids.has(id)) {
      throw new Error("仓库 ID 或路径无效，或 ID 重复");
    }
    ids.add(id);
    const identity = assertRepositoryRegistration(repo);
    if (canonicalPaths.has(identity.path_key)) {
      throw new Error("多个仓库 ID 指向同一个 Git 仓库根目录");
    }
    canonicalPaths.add(identity.path_key);
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
    const path = ensureWithin(
      repositoriesDir,
      join(repositoriesDir, assertPortableRepositoryId(repo.id) + ".md"),
    );
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
    config = await collectSetupConfig(options);
  }
  config.workflow_version = readJson(join(ROOT, "tools", "package.json")).version;
  validateSetupConfig(config);
  console.log(JSON.stringify(config, null, 2));
  console.log(
    "\nAgent 适配预览:\n" +
      JSON.stringify(installAdapter(config.agent.id, config), null, 2),
  );
  if (interactive && options.detailed !== true) {
    console.log("\n已使用安全默认值；需要逐项配置运行信息时可重新执行 setup --detailed。");
  }
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
