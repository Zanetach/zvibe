const fs = require('fs');
const path = require('path');
const os = require('os');
const { AGENTS, BACKENDS } = require('./constants');
const { ZvibeError, ERRORS } = require('./errors');
const { ensureDir } = require('./io');

function configPath() {
  return process.env.VIBE_CONFIG || path.join(os.homedir(), '.config', 'zvibe', 'config.json');
}

function legacyConfigPath() {
  return path.join(os.homedir(), '.config', 'vibe', 'config.json');
}

function defaultConfig() {
  return {
    defaultAgent: 'codex',
    agentPair: ['opencode', 'codex'],
    backend: 'zellij',
    fallback: true,
    rightTerminal: false,
    autoGitInit: true,
    initialized: false
  };
}

function validateAgent(value, fieldName) {
  if (!AGENTS.includes(value)) {
    throw new ZvibeError(
      ERRORS.CONFIG_INVALID,
      `${fieldName} 非法：${value}`,
      `请使用 ${AGENTS.join('|')}`
    );
  }
}

function validateBackend(value) {
  if (!BACKENDS.includes(value)) {
    throw new ZvibeError(
      ERRORS.CONFIG_INVALID,
      `backend 非法：${value}`,
      `请使用 ${BACKENDS.join('|')}`
    );
  }
}

function normalizeBackend(value) {
  if (!value) return 'zellij';
  if (value === 'tmux') return 'zellij';
  return value;
}

function validate(config, { strict = true } = {}) {
  if (!config || typeof config !== 'object') {
    throw new ZvibeError(ERRORS.CONFIG_INVALID, '配置格式非法', '配置必须是 JSON 对象');
  }

  if (strict && !config.defaultAgent) {
    throw new ZvibeError(
      ERRORS.CONFIG_MISSING,
      '缺少 defaultAgent 配置',
      '请运行 zvibe config wizard 或 zvibe config set defaultAgent codex'
    );
  }
  if (strict && config.initialized !== true) {
    throw new ZvibeError(
      ERRORS.CONFIG_MISSING,
      '尚未完成初始化配置',
      '请先运行 zvibe setup'
    );
  }

  if (config.defaultAgent) validateAgent(config.defaultAgent, 'defaultAgent');

  if (config.agentPair !== undefined) {
    if (!Array.isArray(config.agentPair) || config.agentPair.length !== 2) {
      throw new ZvibeError(ERRORS.CONFIG_INVALID, 'agentPair 必须是长度为 2 的数组');
    }
    validateAgent(config.agentPair[0], 'agentPair[0]');
    validateAgent(config.agentPair[1], 'agentPair[1]');
  }

  if (config.backend !== undefined) validateBackend(normalizeBackend(config.backend));

  if (config.fallback !== undefined && typeof config.fallback !== 'boolean') {
    throw new ZvibeError(ERRORS.CONFIG_INVALID, 'fallback 必须为布尔值');
  }

  if (config.rightTerminal !== undefined && typeof config.rightTerminal !== 'boolean') {
    throw new ZvibeError(ERRORS.CONFIG_INVALID, 'rightTerminal 必须为布尔值');
  }

  if (config.autoGitInit !== undefined && typeof config.autoGitInit !== 'boolean') {
    throw new ZvibeError(ERRORS.CONFIG_INVALID, 'autoGitInit 必须为布尔值');
  }

  return true;
}

function loadConfig({ strict = true } = {}) {
  const file = configPath();
  const legacy = legacyConfigPath();
  const resolvedFile = fs.existsSync(file) ? file : (fs.existsSync(legacy) ? legacy : file);
  if (!fs.existsSync(resolvedFile)) {
    const cfg = defaultConfig();
    if (strict) {
      throw new ZvibeError(
        ERRORS.CONFIG_MISSING,
        `未找到配置文件：${file}`,
        '请先运行 zvibe setup'
      );
    }
    return { config: cfg, file, exists: false };
  }

  const raw = fs.readFileSync(resolvedFile, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ZvibeError(ERRORS.CONFIG_INVALID, `配置文件不是合法 JSON：${file}`);
  }

  const normalized = {
    defaultAgent: data.defaultAgent,
    agentPair: data.agentPair || data.AgentMode || defaultConfig().agentPair,
    backend: normalizeBackend(data.backend),
    fallback: data.fallback !== undefined ? data.fallback : true,
    rightTerminal: data.rightTerminal !== undefined ? data.rightTerminal : false,
    autoGitInit: data.autoGitInit !== undefined ? data.autoGitInit : true,
    initialized: data.initialized === true
  };

  validate(normalized, { strict });
  return { config: normalized, file: resolvedFile, exists: true };
}

function saveConfig(config) {
  validate(config, { strict: true });
  const file = configPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

function mergeWithPriority(cli, config) {
  return {
    defaultAgent: cli.defaultAgent || config.defaultAgent,
    agentPair: cli.agentPair || config.agentPair,
    backend: normalizeBackend(cli.backend || config.backend),
    fallback: cli.fallback !== undefined ? cli.fallback : config.fallback,
    rightTerminal: cli.rightTerminal !== undefined ? cli.rightTerminal : config.rightTerminal,
    autoGitInit: cli.autoGitInit !== undefined ? cli.autoGitInit : config.autoGitInit,
    initialized: config.initialized === true
  };
}

module.exports = {
  configPath,
  defaultConfig,
  normalizeBackend,
  validate,
  loadConfig,
  saveConfig,
  mergeWithPriority
};
