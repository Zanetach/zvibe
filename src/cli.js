#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Output } = require('./core/io');
const { run, commandExists, commandExistsMany, clearCommandExistsCache } = require('./core/process');
const { ZvibeError, ERRORS } = require('./core/errors');
const { AGENTS, MODES } = require('./core/constants');
const { loadConfig, saveConfig, defaultConfig, mergeWithPriority, validate, normalizeBackend } = require('./core/config');
const { agentCommand } = require('./core/agents');
const zellijBackend = require('./backends/zellij');
const { version } = require('../package.json');

const REQUIRED_FORMULAS = [
  { command: 'git', formula: 'git' },
  { command: 'node', formula: 'node' },
  { command: 'zellij', formula: 'zellij' },
  { command: 'yazi', formula: 'yazi' },
  { command: 'gum', formula: 'gum' }
];

const REQUIRED_CASKS = [
  { appDir: '/Applications/Ghostty.app', cask: 'ghostty' }
];
const TOP_LEVEL_COMMANDS = ['setup', 'config', 'status', 'update', 'session', 'help', 'version'];

function requiredPluginFiles() {
  return [
    path.join(os.homedir(), '.config', 'yazi', 'yazi.toml'),
    path.join(os.homedir(), '.config', 'yazi', 'keymap.toml'),
    path.join(os.homedir(), '.config', 'zellij', 'VERSION'),
    path.join(os.homedir(), '.config', 'zellij', 'config.kdl'),
    path.join(os.homedir(), '.config', 'zellij', 'layouts', 'zvibe.kdl'),
    path.join(os.homedir(), '.config', 'zellij', 'themes', 'cyber.kdl')
  ];
}

const AGENT_INSTALLERS = {
  codex: { command: 'codex' },
  claude: { command: 'claude' },
  opencode: { command: 'opencode' }
};

function needMacOS() {
  if (process.platform !== 'darwin') {
    throw new ZvibeError(ERRORS.PLATFORM_UNSUPPORTED, 'Zvibe 目前只支持 macOS');
  }
}

function parseArgv(argv) {
  const flags = { json: false, verbose: false, yes: false, repair: false, unknownFlags: [], doubleDashArgs: [] };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' || arg === '-p' || arg === '-P' || arg === '--passthrough') {
      flags.doubleDashArgs = argv.slice(i + 1);
      break;
    }
    if (arg === '--help' || arg === '-h' || arg === '-help') flags.help = true;
    else if (arg === '--version' || arg === '-v' || arg === '--v' || arg === '-version') flags.version = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--repair') flags.repair = true;
    else if (arg === '--no-repair') flags.noRepair = true;
    else if (arg === '--reuse-session') flags.reuseSession = true;
    else if (arg === '--fresh-session') flags.freshSession = true;
    else if (arg === '-T' || arg === '--terminal-only') flags.terminalOnly = true;
    else if (arg === '-t' || arg === '--terminal' || arg === '--right-terminal') flags.rightTerminal = true;
    else if (arg.startsWith('--backend=')) flags.backend = arg.split('=')[1];
    else if (arg === '--backend') {
      flags.backend = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--pair=')) {
      flags.agentPair = arg.split('=')[1].split(',');
    } else if (arg === '--pair') {
      flags.agentPair = (argv[i + 1] || '').split(',');
      i += 1;
    } else if (arg === '--fallback=false') flags.fallback = false;
    else if (arg === '--fallback=true') flags.fallback = true;
    else if (arg === '--doctor') flags.doctor = true;
    else if ((positional[0] === 'session') && ['-a', '-k', '-l', '--attach', '--kill', '--list'].includes(arg)) positional.push(arg);
    else if (arg.startsWith('-')) flags.unknownFlags.push(arg);
    else positional.push(arg);
  }

  return { flags, positional };
}

function shellQuoteArg(arg) {
  const value = String(arg)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  return `"${value}"`;
}

function withPassthrough(baseCommand, passthroughArgs) {
  if (!passthroughArgs || passthroughArgs.length === 0) return baseCommand;
  return `${baseCommand} ${passthroughArgs.map(shellQuoteArg).join(' ')}`;
}

function parseArgList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {}
  }
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseEnvVarList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function normalizeAgentEnvIsolation(rawMode) {
  const mode = String(rawMode || 'smart').trim().toLowerCase();
  if (['off', 'none', 'false', '0'].includes(mode)) return 'off';
  if (['strict', 'hard'].includes(mode)) return 'strict';
  return 'smart';
}

function agentUnsetVars(env = process.env) {
  const isolation = normalizeAgentEnvIsolation(env.ZVIBE_AGENT_ENV_ISOLATION);
  const baseVars = ['CLAUDECODE', 'CODEX_THREAD_ID'];
  const strictVars = ['CODEX_CI', 'CODEX_MANAGED_BY_NPM', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
  const customUnset = parseEnvVarList(env.ZVIBE_AGENT_ENV_UNSET);
  const customKeep = new Set(parseEnvVarList(env.ZVIBE_AGENT_ENV_KEEP));
  const hasAgentContamination = strictVars.some((name) => Object.prototype.hasOwnProperty.call(env, name));
  const effectiveIsolation = (isolation === 'smart' && hasAgentContamination) ? 'strict' : isolation;

  const candidate = [];
  if (effectiveIsolation !== 'off') {
    candidate.push(...baseVars);
    if (effectiveIsolation === 'strict') candidate.push(...strictVars);
  }
  candidate.push(...customUnset);

  return Array.from(new Set(candidate.filter((name) => !customKeep.has(name))));
}

function withAgentEnv(agent, command, env = process.env) {
  const unsetVars = agentUnsetVars(env);

  const envPrefix = unsetVars.length > 0
    ? `env ${unsetVars.map((name) => `-u ${name}`).join(' ')} `
    : '';

  return `${envPrefix}ZVIBE_AGENT=${agent} ${command}`;
}

function buildAgentCommand(agent, passthroughArgs = []) {
  const base = withPassthrough(agentCommand(agent), passthroughArgs);
  return withAgentEnv(agent, base);
}

function configuredAgentArgs(config, agent) {
  const globalArgs = Array.isArray(config.agentArgs) ? config.agentArgs : [];
  const perAgentKey = `${agent}Args`;
  const perAgentArgs = Array.isArray(config[perAgentKey]) ? config[perAgentKey] : [];
  return globalArgs.concat(perAgentArgs);
}

function getClaudePermissionToggles(args = []) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const skipPermissions = list.includes('--dangerously-skip-permissions');
  let bypassPermissions = false;
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token === '--permission-mode' && list[i + 1] === 'bypassPermissions') {
      bypassPermissions = true;
      break;
    }
    if (token === '--permission-mode=bypassPermissions') {
      bypassPermissions = true;
      break;
    }
  }
  return { bypassPermissions, skipPermissions };
}

function applyClaudePermissionToggles(args = [], toggles = {}) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const next = [];
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    const following = list[i + 1];

    if (token === '--dangerously-skip-permissions') continue;
    if (token === '--permission-mode' && following === 'bypassPermissions') {
      i += 1;
      continue;
    }
    if (token === '--permission-mode=bypassPermissions') continue;
    next.push(token);
  }

  if (toggles.bypassPermissions) {
    next.push('--permission-mode', 'bypassPermissions');
  }
  if (toggles.skipPermissions) {
    next.push('--dangerously-skip-permissions');
  }
  return next;
}

function getCodexModeToggles(args = []) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  return {
    fullAuto: list.includes('--full-auto')
  };
}

function applyCodexModeToggles(args = [], toggles = {}) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const next = [];
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token === '--full-auto' || token === '--auto-edit') continue;
    next.push(token);
  }
  if (toggles.fullAuto) next.push('--full-auto');
  return next;
}

async function askAgentTogglesIfNeeded(agent, state, output, askedAgents) {
  const chosen = String(agent || '').trim();
  if (!AGENTS.includes(chosen)) return state;
  if (askedAgents.has(chosen)) {
    if (!output.json) output.info(`${chosen} 参数沿用已配置值`);
    return state;
  }
  askedAgents.add(chosen);

  if (chosen === 'codex') {
    if (!output.json) process.stdout.write('\n[Codex 参数开关]\n');
    state.codexFullAuto = await askYesNo('启用 Codex FullAuto（--full-auto）？', state.codexFullAuto);
    return state;
  }

  if (chosen === 'claude') {
    if (!output.json) process.stdout.write('\n[Claude 参数开关]\n');
    state.claudeBypassPermissions = await askYesNo('启用 Claude BypassPermissions（--permission-mode bypassPermissions）？', state.claudeBypassPermissions);
    state.claudeSkipPermissions = await askYesNo('启用 Claude SkipPermissions（--dangerously-skip-permissions）？', state.claudeSkipPermissions);
  }

  return state;
}

function buildStatusBarCommand({ primaryAgent = '', secondaryAgent = '', noAgent = false } = {}) {
  const script = path.join(__dirname, 'tools', 'status-bar.js');
  const env = [
    `ZVIBE_PRIMARY_AGENT=${shellQuoteArg(primaryAgent || '')}`,
    `ZVIBE_SECONDARY_AGENT=${shellQuoteArg(secondaryAgent || '')}`,
    `ZVIBE_NO_AGENT=${shellQuoteArg(noAgent ? '1' : '0')}`
  ].join(' ');
  return `${env} ${shellQuoteArg(process.execPath)} ${shellQuoteArg(script)}`;
}

async function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} `, resolve));
  rl.close();
  return (answer || fallback || '').trim();
}

async function askYesNo(question, fallback = true) {
  const defaultText = fallback ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} [${defaultText}]`, '')).toLowerCase();
  if (!answer) return fallback;
  if (['y', 'yes'].includes(answer)) return true;
  if (['n', 'no'].includes(answer)) return false;
  return fallback;
}

async function askAgentChoice(label, fallback, output) {
  if (!process.stdin.isTTY) {
    if (!output.json) output.ok(`${label} 已设置为 ${fallback}`);
    return fallback;
  }
  while (true) {
    const value = await ask(`${label} (${AGENTS.join('/')})，默认 ${fallback}:`, fallback);
    const chosen = value || fallback;
    if (AGENTS.includes(chosen)) {
      if (!output.json) output.ok(`${label} 已设置为 ${chosen}`);
      return chosen;
    }
    if (!output.json) output.warn(`输入无效：${chosen}，请从 ${AGENTS.join('/')} 中选择`);
  }
}

function hasCommand(command, commandAvailability = null) {
  if (commandAvailability && Object.prototype.hasOwnProperty.call(commandAvailability, command)) {
    return !!commandAvailability[command];
  }
  return commandExists(command);
}

function isClaudeAvailable(commandAvailability = null) {
  return hasCommand('claude', commandAvailability)
    || hasCommand('claude-code', commandAvailability)
    || fs.existsSync('/Applications/Claude Code.app');
}

function isAgentAvailable(agent, commandAvailability = null) {
  if (agent === 'claude') return isClaudeAvailable(commandAvailability);
  if (agent === 'codex') return hasCommand('codex', commandAvailability);
  if (agent === 'opencode') return hasCommand('opencode', commandAvailability);
  return false;
}

function normalizeManagedAgents(agents) {
  if (!Array.isArray(agents)) return [];
  const normalized = agents.filter((agent) => AGENTS.includes(agent));
  return Array.from(new Set(normalized));
}

function checkSetupState({ managedAgents = [], commandAvailability = null } = {}) {
  const checks = [];

  checks.push({ ok: hasCommand('brew', commandAvailability), label: 'brew' });

  REQUIRED_FORMULAS.forEach(({ command }) => {
    checks.push({ ok: hasCommand(command, commandAvailability), label: command });
  });

  checks.push({ ok: hasCommand('keifu', commandAvailability), label: 'keifu' });

  REQUIRED_CASKS.forEach(({ appDir, cask }) => {
    checks.push({ ok: fs.existsSync(appDir), label: `${cask}.app`, detail: appDir });
  });

  requiredPluginFiles().forEach((filePath) => {
    checks.push({ ok: fs.existsSync(filePath), label: path.basename(filePath), detail: filePath });
  });

  normalizeManagedAgents(managedAgents).forEach((agent) => {
    const spec = AGENT_INSTALLERS[agent];
    checks.push({
      ok: isAgentAvailable(agent, commandAvailability),
      label: `agent:${agent}`,
      detail: spec ? spec.command : agent
    });
  });

  return checks;
}

function reportSetupState(output, checks, { strict = false } = {}) {
  const missing = checks.filter((item) => !item.ok);
  if (!output.json) {
    checks.forEach((item) => {
      const suffix = item.detail ? ` (${item.detail})` : '';
      if (item.ok) output.ok(`${item.label} PASS${suffix}`);
      else output.warn(`${item.label} 缺失${suffix}`);
    });
  }
  if (strict && missing.length > 0) {
    const labels = missing.map((item) => item.label).join(', ');
    throw new ZvibeError(ERRORS.RUN_FAILED, `setup 校验失败，缺失项: ${labels}`, '请执行 zvibe setup --repair');
  }
  return missing;
}

function parseRun(positional) {
  const looksLikePath = (value) => looksLikePathToken(value);
  const isDir = (value) => isExistingDirectoryToken(value);
  const isTargetDirToken = (value) => isDir(value) || looksLikePath(value);

  const modeIndex = positional.findIndex((item) => MODES.includes(item));
  if (modeIndex === 0) {
    const maybeDir = positional[1];
    const hasExplicitDir = isTargetDirToken(maybeDir);
    return {
      mode: positional[0],
      targetDir: hasExplicitDir ? maybeDir : process.cwd(),
      agentArgs: positional.slice(hasExplicitDir ? 2 : 1)
    };
  }
  if (modeIndex === 1) {
    return { mode: positional[1], targetDir: positional[0] || process.cwd(), agentArgs: positional.slice(2) };
  }
  if (modeIndex > 1) {
    return {
      mode: positional[modeIndex],
      targetDir: positional[0] || process.cwd(),
      agentArgs: positional.slice(1, modeIndex).concat(positional.slice(modeIndex + 1))
    };
  }
  return { mode: '', targetDir: positional[0] || process.cwd(), agentArgs: positional.slice(1) };
}

function looksLikePathToken(value) {
  if (!value) return false;
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value === '.'
    || value === '..'
    || value.startsWith('~/')
    || value.includes('/');
}

function isExistingDirectoryToken(value) {
  if (!value) return false;
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function shouldTreatFirstPositionalAsRunTarget(command) {
  if (!command) return false;
  return looksLikePathToken(command) || isExistingDirectoryToken(command);
}

function selectBackend(requested, output) {
  const z = zellijBackend.healthcheck();

  if (requested && requested !== 'zellij' && !output.json) {
    output.warn(`backend=${requested} 已归一化为 zellij`);
  }
  if (!z.ok) throw z.error;
  return 'zellij';
}

function renderUsage() {
  return `${renderBanner()}Commands / 命令:\n  zvibe setup [--repair] [--no-repair] [--yes] Setup dependencies and config / 初始化依赖与配置\n  zvibe config wizard                       Interactive config wizard / 交互式配置向导\n  zvibe config get <key>                    Read config value / 读取配置项\n  zvibe config set <key> <value>            Write config value / 写入配置项\n  zvibe config validate                     Validate config file / 校验配置文件\n  zvibe config explain                      Explain effective config / 解释当前生效配置\n  zvibe status [--doctor] [--json]          Health check and diagnostics / 环境诊断\n  zvibe update                              Update installed plugins + managed agents / 仅更新已安装插件与已管理 Agent\n  zvibe session list                        List zvibe sessions / 列出会话\n  zvibe session attach <name>               Attach session / 连接到会话\n  zvibe session kill <name|all>             Kill session / 删除会话（all 表示全部）\n  zvibe session -l | -a <name> | -k <name|all> Session shortcuts / 会话快捷参数\n\nRun / 启动:\n  zvibe\n  zvibe codex|claude|opencode|code|terminal\n  zvibe <dir> [codex|claude|opencode|code|terminal]\n  zvibe [codex|claude|opencode|code|terminal] <dir>\n  zvibe <agent> -p <agent args...>\n  zvibe <agent> -- <agent args...>\n\nGlobal Flags / 全局参数:\n  --backend zellij                Backend selection (zellij only) / 后端选择（当前仅 zellij）\n  --fresh-session                 Force rebuild if session exists / 会话存在时强制重建\n  --reuse-session                 Compatibility flag; attach-first by default / 兼容参数（当前默认优先 attach）\n  -p, --passthrough               Pass all following args to agent / 后续参数全部透传给 Agent\n  -t, --terminal                  Add right terminal pane in agent/code modes / 在 agent/code 模式右侧增加 Terminal\n  -T, --terminal-only             Terminal-only session / 进入纯终端模式\n  --yes                           Non-interactive setup defaults / setup 使用默认值无交互执行\n  --json                          JSON output / 以 JSON 输出结果\n  --verbose                       Verbose diagnostics / 输出诊断细节\n  -v, --version, --v              Show CLI version / 显示版本号\n`;
}

function renderBanner() {
  const plain = ` _____   _ _     _           
|__  / _| (_)___| |__   ___  
  / / |_  | / __| '_ \\ / _ \\ 
 / /|  _| | \\__ \\ | | |  __/ 
/____|_| |_|_|___/_| |_|\\___| 

                 zvibe\n\n`;
  if (!process.stdout.isTTY || process.env.NO_COLOR) return plain;

  const lines = plain.split('\n');
  const start = [109, 188, 255]; // aurora
  const end = [160, 120, 255];
  const paint = (text, r, g, b) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

  const colored = lines.map((line, idx) => {
    const t = lines.length <= 1 ? 0 : (idx / (lines.length - 1));
    const r = Math.round(start[0] + ((end[0] - start[0]) * t));
    const g = Math.round(start[1] + ((end[1] - start[1]) * t));
    const b = Math.round(start[2] + ((end[2] - start[2]) * t));
    return line ? paint(line, r, g, b) : line;
  }).join('\n');

  return colored;
}

function commandSummary(summary, output) {
  output.flushJson(summary);
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[s.length][t.length];
}

function suggestTopCommand(input) {
  const known = ['setup', 'config', 'status', 'update', 'session', 'help', ...MODES];
  let best = null;
  let bestScore = Infinity;
  known.forEach((item) => {
    const score = levenshtein(input, item);
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  });
  if (!best) return null;
  const threshold = Math.max(1, Math.floor(String(best).length / 3));
  return bestScore <= threshold ? best : null;
}

function ensureCommandOrBrew(command, formula, output, { install = false } = {}) {
  if (commandExists(command)) {
    output.ok(`${command} PASS（已安装）`);
    return true;
  }
  if (!install) return false;

  output.warn(`缺少 ${command}，尝试安装 ${formula}`);
  const result = run('brew', ['install', formula]);
  if (!result.ok) {
    throw new ZvibeError(ERRORS.COMMAND_MISSING, `${command} 安装失败`, `请手动执行 brew install ${formula}`);
  }
  output.ok(`${command} 安装完成`);
  return true;
}

function ensureCask(appDir, cask, output, { install = false } = {}) {
  if (fs.existsSync(appDir)) {
    output.ok(`${path.basename(appDir)} PASS（已安装）`);
    return true;
  }
  if (!install) return false;

  output.warn(`缺少 ${path.basename(appDir)}，尝试安装 cask ${cask}`);
  const result = run('brew', ['install', '--cask', cask]);
  if (!result.ok) {
    throw new ZvibeError(ERRORS.COMMAND_MISSING, `${cask} 安装失败`, `请手动执行 brew install --cask ${cask}`);
  }
  output.ok(`${cask} 安装完成`);
  return true;
}

function brewTap(tap) {
  run('brew', ['tap', tap], { capture: true });
}

function runShell(command, options = {}) {
  return run('sh', ['-lc', command], options);
}

function brewUpgradeFormula(formula, output, { required = false } = {}) {
  const result = run('brew', ['upgrade', formula], { capture: true });
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || '').trim();
    if (required) {
      throw new ZvibeError(ERRORS.RUN_FAILED, `${formula} 升级失败`, detail || `请手动执行 brew upgrade ${formula}`);
    }
    output.warn(`${formula} 升级跳过: ${detail || '未提供错误详情'}`);
    return false;
  }
  output.ok(`${formula} 升级完成`);
  return true;
}

function brewUpgradeCask(cask, output, { required = false } = {}) {
  const result = run('brew', ['upgrade', '--cask', cask], { capture: true });
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || '').trim();
    if (required) {
      throw new ZvibeError(ERRORS.RUN_FAILED, `${cask} 升级失败`, detail || `请手动执行 brew upgrade --cask ${cask}`);
    }
    output.warn(`${cask} 升级跳过: ${detail || '未提供错误详情'}`);
    return false;
  }
  output.ok(`${cask} 升级完成`);
  return true;
}

function ensureTextFile(filePath, content, { overwrite = false } = {}) {
  if (fs.existsSync(filePath) && !overwrite) return 'exists';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'written';
}

function isBackupFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith('~')
    || name.includes('.bak')
    || name.includes('.backup');
}

function listFilesRecursively(rootDir, { skipDirs = [] } = {}) {
  if (!fs.existsSync(rootDir)) return [];
  const skipSet = new Set(skipDirs.map((item) => String(item)));
  const files = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.name === '.' || entry.name === '..') return;
      if (entry.isDirectory() && skipSet.has(entry.name)) return;

      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        return;
      }
      if (!entry.isFile()) return;
      files.push(path.relative(rootDir, abs));
    });
  }

  walk(rootDir);
  return files;
}

function backupDirectoryFiles(rootDir, output, { label = '目录', skipDirs = [] } = {}) {
  if (!fs.existsSync(rootDir)) return 0;
  const allFiles = listFilesRecursively(rootDir, { skipDirs });
  const candidates = allFiles.filter((rel) => !isBackupFile(rel));
  if (candidates.length === 0) {
    output.info(`插件备份: ${label} 无需备份`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  let backedUp = 0;
  candidates.forEach((rel) => {
    const src = path.join(rootDir, rel);
    let backupPath = `${src}.bak.${stamp}`;
    let seq = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = `${src}.bak.${stamp}.${seq}`;
      seq += 1;
    }
    fs.copyFileSync(src, backupPath);
    backedUp += 1;
  });

  output.info(`插件备份: ${label} 已备份 ${backedUp} 个文件（排除已有备份文件）`);
  return backedUp;
}

function ensurePluginConfigs(output, { overwrite = true } = {}) {
  const yaziToml = `[mgr]
ratio = [0, 4, 6]

[preview]
max_width = 2000
max_height = 2400

[opener]
edit = [
  { run = "\${EDITOR:-vim} %s", desc = "edit", for = "unix", block = true },
]
`;

  const yaziKeymap = `"$schema" = "https://yazi-rs.github.io/schemas/keymap.json"

[mgr]
prepend_keymap = [
  { on = "e", run = "open", desc = "Edit selected file" },
  { on = "o", run = "open", desc = "Edit selected file" },
  { on = "v", run = 'shell --block "bat --paging=always --style=plain \\"$@\\""', desc = "View file with bat pager" },
  { on = "<Enter>", run = "enter", desc = "Enter directory" },
]
`;

  const yaziConfigPath = path.join(os.homedir(), '.config', 'yazi', 'yazi.toml');
  const yaziKeymapPath = path.join(os.homedir(), '.config', 'yazi', 'keymap.toml');
  const zellijRootPath = path.join(os.homedir(), '.config', 'zellij');
  const bundledZellijRootPath = path.join(__dirname, '..', 'templates', 'zellij');

  const mode = { overwrite };
  const yaziConfigResult = ensureTextFile(yaziConfigPath, yaziToml, mode);
  const yaziKeymapResult = ensureTextFile(yaziKeymapPath, yaziKeymap, mode);

  if (overwrite) {
    backupDirectoryFiles(zellijRootPath, output, { label: 'zellij', skipDirs: ['.git'] });
  }

  let zellijWriteCount = 0;
  let zellijTotalCount = 0;
  if (fs.existsSync(bundledZellijRootPath)) {
    const bundledFiles = listFilesRecursively(bundledZellijRootPath, { skipDirs: ['.git'] })
      .filter((rel) => !isBackupFile(rel));
    zellijTotalCount = bundledFiles.length;
    bundledFiles.forEach((rel) => {
      const sourceFile = path.join(bundledZellijRootPath, rel);
      const targetFile = path.join(zellijRootPath, rel);
      const content = fs.readFileSync(sourceFile, 'utf8');
      const result = ensureTextFile(targetFile, content, mode);
      if (result === 'written') zellijWriteCount += 1;
    });
  }

  output.info(`插件配置: yazi.toml ${yaziConfigResult === 'written' ? (overwrite ? '已覆盖写入' : '已写入') : '已存在，跳过'}`);
  output.info(`插件配置: keymap.toml ${yaziKeymapResult === 'written' ? (overwrite ? '已覆盖写入' : '已写入') : '已存在，跳过'}`);
  output.info(`插件配置: zellij ${overwrite ? '覆盖写入' : '写入'} ${zellijWriteCount}/${zellijTotalCount} 个文件`);
  output.info('插件配置: keifu 使用默认配置（当前版本无需额外配置文件）');
}

async function setupGpuPowermetricsSudo(output) {
  const powermetricsPath = '/usr/bin/powermetrics';
  if (!fs.existsSync(powermetricsPath)) {
    output.warn('未检测到 /usr/bin/powermetrics，已跳过 GPU 高精度监控授权');
    return;
  }

  if (!process.stdin.isTTY) {
    output.warn('检测到非交互终端，已跳过 GPU 高精度监控授权');
    return;
  }

  const shouldEnable = await askYesNo('启用 GPU 高精度监控（需要一次系统密码）？', true);
  if (!shouldEnable) {
    output.info('已跳过 GPU 高精度监控授权');
    return;
  }

  const user = process.env.SUDO_USER || process.env.USER || os.userInfo().username;
  const sudoersFile = '/etc/sudoers.d/zvibe-powermetrics';
  const tempFile = path.join(os.tmpdir(), `zvibe-powermetrics-${process.pid}-${Date.now()}.sudoers`);
  const rule = `${user} ALL=(root) NOPASSWD: ${powermetricsPath}\n`;

  fs.writeFileSync(tempFile, rule, { encoding: 'utf8', mode: 0o600 });
  output.info('正在请求系统密码以写入 sudoers（仅授权 powermetrics）...');

  try {
    const installResult = run('sudo', ['install', '-m', '440', tempFile, sudoersFile], { capture: false });
    if (!installResult.ok) {
      output.warn('GPU 高精度监控授权失败：sudoers 写入未完成');
      return;
    }

    const validateResult = run('sudo', ['visudo', '-cf', sudoersFile], { capture: true });
    if (!validateResult.ok) {
      output.warn(`GPU 高精度监控授权失败：sudoers 校验未通过 (${validateResult.stderr || validateResult.stdout})`);
      run('sudo', ['rm', '-f', sudoersFile], { capture: false });
      return;
    }

    const probeResult = run('sudo', ['-n', powermetricsPath, '--samplers', 'gpu_power', '-n', '1', '-i', '1000'], { capture: true });
    if (!probeResult.ok) {
      output.warn('授权已写入，但首次采样失败；可稍后重试 zvibe');
    } else {
      output.ok('GPU 高精度监控授权成功（powermetrics）');
    }
    output.info(`如需撤销：sudo rm -f ${sudoersFile}`);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
}

function ensureCodex(output, { install = false } = {}) {
  if (commandExists('codex')) {
    output.ok('codex PASS（已安装）');
    return true;
  }
  if (!install) return false;

  if (!commandExists('npm')) {
    throw new ZvibeError(ERRORS.COMMAND_MISSING, '缺少 npm，无法安装 codex CLI', '请先安装 Node.js 后重试');
  }

  output.warn('缺少 codex，尝试通过 npm 全局安装 @openai/codex');
  const result = run('npm', ['install', '-g', '@openai/codex']);
  if (!result.ok) {
    throw new ZvibeError(ERRORS.COMMAND_MISSING, 'codex 安装失败', '请手动执行 npm install -g @openai/codex');
  }
  output.ok('codex 安装完成');
  return true;
}

function ensureClaude(output, { install = false } = {}) {
  if (isClaudeAvailable()) {
    output.ok('claude PASS（已安装）');
    return true;
  }
  if (!install) return false;

  output.warn('缺少 claude，尝试通过官方安装脚本安装');
  const result = runShell('curl -fsSL https://claude.ai/install.sh | bash');
  clearCommandExistsCache();
  if (!result.ok || !isClaudeAvailable()) {
    throw new ZvibeError(
      ERRORS.COMMAND_MISSING,
      'claude 安装失败',
      '请手动执行 curl -fsSL https://claude.ai/install.sh | bash'
    );
  }

  output.ok('claude 安装完成');
  return true;
}

function getClaudeUpgradeInvocations(commandAvailability = null) {
  return [
    ['claude', 'update'],
    ['claude', 'upgrade'],
    ['claude-code', 'update'],
    ['claude-code', 'upgrade']
  ].filter(([command]) => hasCommand(command, commandAvailability));
}

function ensureOpencode(output, { install = false } = {}) {
  if (commandExists('opencode')) {
    output.ok('opencode PASS（已安装）');
    return true;
  }
  if (!install) return false;
  brewTap('anomalyco/tap');
  ensureCommandOrBrew('opencode', 'anomalyco/tap/opencode', output, { install: true });
  return true;
}

async function chooseManagedAgents({ nonInteractive, existingManagedAgents, output }) {
  if (nonInteractive) {
    const detected = AGENTS.filter((agent) => isAgentAvailable(agent));
    if (!output.json) {
      if (detected.length > 0) output.info(`无交互模式：自动管理已安装 Agent -> ${detected.join(', ')}`);
      else output.info('无交互模式：未检测到已安装 Agent，跳过 Agent 管理');
    }
    return detected;
  }

  const existing = normalizeManagedAgents(existingManagedAgents);
  const managed = [];
  const total = AGENTS.length;
  for (let i = 0; i < AGENTS.length; i += 1) {
    const agent = AGENTS[i];
    if (!output.json) process.stdout.write(`\n[Agent ${i + 1}/${total}] ${agent}\n`);
    const installed = isAgentAvailable(agent);
    const defaultChoice = existing.includes(agent) || installed;
    const choose = await askYesNo(`是否管理 ${agent}${installed ? '（已安装）' : '（未安装）'}？`, defaultChoice);
    if (!choose) continue;

    if (!installed) {
      const confirm = (await ask(`将安装 ${agent}。请输入 yes 或 y 确认安装：`, '')).toLowerCase();
      if (!['yes', 'y'].includes(confirm)) {
        output.info(`未确认安装 ${agent}，已跳过`);
        continue;
      }
    }

    if (agent === 'codex') ensureCodex(output, { install: !installed });
    if (agent === 'claude') ensureClaude(output, { install: !installed });
    if (agent === 'opencode') ensureOpencode(output, { install: !installed });

    managed.push(agent);
  }

  if (managed.length === 0) {
    output.warn('未选择任何 Agent 进行管理');
  } else {
    output.ok(`Agent 管理列表: ${managed.join(', ')}`);
  }
  return managed;
}

async function cmdSetup(flags, output) {
  needMacOS();
  const autoInstall = true;
  const repairMode = !!flags.repair;
  const noRepair = !!flags.noRepair;
  const nonInteractive = !!flags.yes || !process.stdin.isTTY;
  const overwritePluginConfigs = noRepair ? false : true;
  const loaded = loadConfig({ strict: false });
  const existingConfig = loaded.config || defaultConfig();
  if (!output.json) {
    process.stdout.write(renderBanner());
    process.stdout.write('== Step 1/3 插件与依赖（自动化安装） ==\n');
  }

  if (!commandExists('brew')) {
    if (!autoInstall) {
      throw new ZvibeError(ERRORS.COMMAND_MISSING, '未检测到 Homebrew', '请先安装 Homebrew 后重试 zvibe setup');
    }
    const installBrew = run('sh', ['-lc', '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"']);
    if (!installBrew.ok) throw new ZvibeError(ERRORS.COMMAND_MISSING, 'Homebrew 安装失败');
  }

  REQUIRED_FORMULAS.forEach(({ command, formula }) => {
    ensureCommandOrBrew(command, formula, output, { install: autoInstall || repairMode });
  });

  if (!commandExists('keifu')) {
    brewTap('trasta298/tap');
    ensureCommandOrBrew('keifu', 'trasta298/tap/keifu', output, { install: true });
  }

  REQUIRED_CASKS.forEach(({ appDir, cask }) => {
    ensureCask(appDir, cask, output, { install: autoInstall || repairMode });
  });

  ensurePluginConfigs(output, { overwrite: overwritePluginConfigs });
  if (nonInteractive) {
    output.info('已启用无交互模式，跳过 GPU 高精度监控授权');
  } else {
    await setupGpuPowermetricsSudo(output);
  }

  if (!output.json) {
    process.stdout.write('\n== Step 2/3 Agent（交互安装，按序执行） ==\n');
  }
  const managedAgents = await chooseManagedAgents({
    nonInteractive,
    existingManagedAgents: existingConfig.managedAgents,
    output
  });

  const setupChecks = checkSetupState({ managedAgents });
  const setupMissing = reportSetupState(output, setupChecks);
  if (setupMissing.length === 0) output.ok('setup 自动化安装校验通过');

  if (!output.json) {
    process.stdout.write('\n== Step 3/3 Config（布局与默认 Agent 配置） ==\n');
  }
  const current = { ...defaultConfig(), ...existingConfig };
  let defaultAgent = current.defaultAgent;
  let pairTop = current.agentPair[0];
  let pairBottom = current.agentPair[1];
  const currentCodexToggles = getCodexModeToggles(current.codexArgs);
  let codexFullAuto = currentCodexToggles.fullAuto;
  const currentClaudeToggles = getClaudePermissionToggles(current.claudeArgs);
  let claudeBypassPermissions = currentClaudeToggles.bypassPermissions;
  let claudeSkipPermissions = currentClaudeToggles.skipPermissions;
  const availableAgents = AGENTS.filter((agent) => isAgentAvailable(agent));
  const interactiveFallbacks = managedAgents.length > 0 ? managedAgents : availableAgents;
  if (interactiveFallbacks.length > 0) {
    defaultAgent = interactiveFallbacks[0];
    pairTop = interactiveFallbacks[0];
    pairBottom = interactiveFallbacks[1] || interactiveFallbacks[0];
  }

  if (nonInteractive && !output.json) {
    output.warn(flags.yes ? '检测到 --yes，设置步骤将使用默认值' : '检测到非交互终端，设置步骤将使用默认值');
  }
  if (nonInteractive) {
    output.info(`DefaultAgent 使用默认值: ${defaultAgent}`);
    output.info(`AgentMode 右上使用默认值: ${pairTop}`);
    output.info(`AgentMode 右下使用默认值: ${pairBottom}`);
    output.info(`Codex 参数 - FullAuto: ${codexFullAuto ? '开启' : '关闭'}`);
    output.info(`Claude 参数 - BypassPermissions: ${claudeBypassPermissions ? '开启' : '关闭'}`);
    output.info(`Claude 参数 - SkipPermissions: ${claudeSkipPermissions ? '开启' : '关闭'}`);
  } else {
    const askedAgents = new Set();
    process.stdout.write('\n[设置 1/3] Default Agent\n');
    defaultAgent = await askAgentChoice('DefaultAgent', defaultAgent, output);
    await askAgentTogglesIfNeeded(defaultAgent, {
      codexFullAuto,
      claudeBypassPermissions,
      claudeSkipPermissions
    }, output, askedAgents).then((next) => {
      codexFullAuto = next.codexFullAuto;
      claudeBypassPermissions = next.claudeBypassPermissions;
      claudeSkipPermissions = next.claudeSkipPermissions;
    });

    process.stdout.write('\n[设置 2/3] AgentMode 右上\n');
    pairTop = await askAgentChoice('AgentMode 右上 Agent', pairTop, output);
    await askAgentTogglesIfNeeded(pairTop, {
      codexFullAuto,
      claudeBypassPermissions,
      claudeSkipPermissions
    }, output, askedAgents).then((next) => {
      codexFullAuto = next.codexFullAuto;
      claudeBypassPermissions = next.claudeBypassPermissions;
      claudeSkipPermissions = next.claudeSkipPermissions;
    });

    process.stdout.write('\n[设置 3/3] AgentMode 右下\n');
    pairBottom = await askAgentChoice('AgentMode 右下 Agent', pairBottom, output);
    await askAgentTogglesIfNeeded(pairBottom, {
      codexFullAuto,
      claudeBypassPermissions,
      claudeSkipPermissions
    }, output, askedAgents).then((next) => {
      codexFullAuto = next.codexFullAuto;
      claudeBypassPermissions = next.claudeBypassPermissions;
      claudeSkipPermissions = next.claudeSkipPermissions;
    });
  }

  if (!AGENTS.includes(defaultAgent)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `defaultAgent 非法: ${defaultAgent}`);
  }
  if (!AGENTS.includes(pairTop)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `AgentMode 右上 Agent 非法: ${pairTop}`);
  }
  if (!AGENTS.includes(pairBottom)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `AgentMode 右下 Agent 非法: ${pairBottom}`);
  }

  const cfg = {
    ...current,
    defaultAgent,
    agentPair: flags.agentPair && flags.agentPair.length === 2 ? flags.agentPair : [pairTop, pairBottom],
    codexArgs: applyCodexModeToggles(current.codexArgs, { fullAuto: codexFullAuto }),
    claudeArgs: applyClaudePermissionToggles(current.claudeArgs, {
      bypassPermissions: claudeBypassPermissions,
      skipPermissions: claudeSkipPermissions
    }),
    managedAgents: normalizeManagedAgents(managedAgents),
    backend: normalizeBackend(flags.backend || current.backend),
    rightTerminal: flags.rightTerminal !== undefined ? flags.rightTerminal : current.rightTerminal,
    initialized: true
  };
  validate(cfg, { strict: true });
  const file = saveConfig(cfg);
  if (!output.json) {
    process.stdout.write('\n配置摘要：\n');
    process.stdout.write(`- defaultAgent: ${cfg.defaultAgent}\n`);
    process.stdout.write(`- AgentMode: [${cfg.agentPair[0]}, ${cfg.agentPair[1]}]\n`);
    process.stdout.write(`- Codex FullAuto: ${codexFullAuto ? '开启' : '关闭'}\n`);
    process.stdout.write(`- Claude BypassPermissions: ${claudeBypassPermissions ? '开启' : '关闭'}\n`);
    process.stdout.write(`- Claude SkipPermissions: ${claudeSkipPermissions ? '开启' : '关闭'}\n`);
    process.stdout.write(`- managedAgents: [${cfg.managedAgents.join(', ')}]\n`);
    process.stdout.write(`- backend: ${cfg.backend}\n`);
  }
  output.ok(`初始化完成，配置已写入 ${file}`);

  commandSummary({
    ok: true,
    command: 'setup',
    repair: repairMode,
    managedAgents: cfg.managedAgents,
    configFile: file
  }, output);
}

function configGet(config, key) {
  if (!(key in config)) return undefined;
  return config[key];
}

function castConfigValue(key, value) {
  if (key === 'fallback' || key === 'autoGitInit' || key === 'rightTerminal') return value === 'true';
  if (key === 'agentPair') return value.split(',').map((v) => v.trim());
  if (key === 'agentArgs' || key === 'codexArgs' || key === 'claudeArgs' || key === 'opencodeArgs') return parseArgList(value);
  if (key === 'backend') return normalizeBackend(value);
  return value;
}

async function cmdConfig(positional, output) {
  const sub = positional[1] || 'wizard';
  const knownSubs = new Set(['wizard', 'get', 'set', 'validate', 'explain']);
  if (!knownSubs.has(sub)) {
    throw new ZvibeError(
      ERRORS.RUN_FAILED,
      `未知 config 子命令: ${sub}`,
      '可用命令: zvibe config wizard|get|set|validate|explain'
    );
  }
  const { config } = loadConfig({ strict: false });

  if (sub === 'get') {
    const key = positional[2];
    const value = configGet(config, key);
    if (value === undefined) throw new ZvibeError(ERRORS.CONFIG_INVALID, `未知配置键: ${key}`);
    if (output.json) commandSummary({ ok: true, key, value }, output);
    else process.stdout.write(`${Array.isArray(value) ? value.join(',') : value}\n`);
    return;
  }

  if (sub === 'set') {
    const key = positional[2];
    const raw = positional[3];
    if (!key || raw === undefined) throw new ZvibeError(ERRORS.CONFIG_INVALID, '用法: zvibe config set <key> <value>');
    config[key] = castConfigValue(key, raw);
    config.initialized = true;
    validate(config, { strict: true });
    const file = saveConfig(config);
    output.ok(`配置已更新: ${key}`);
    commandSummary({ ok: true, command: 'config set', key, file }, output);
    return;
  }

  if (sub === 'validate') {
    validate(config, { strict: true });
    output.ok('配置校验通过');
    commandSummary({ ok: true, command: 'config validate' }, output);
    return;
  }

  if (sub === 'explain') {
    const text = `当前行为:\n- 默认 agent: ${config.defaultAgent}\n- 双 agent: ${config.agentPair.join(' + ')}\n- 后端策略: ${config.backend}\n- 右侧 Terminal: ${config.rightTerminal ? '开启' : '关闭'}\n- agentArgs(全局): ${(config.agentArgs || []).join(' ') || '(空)'}\n- codexArgs: ${(config.codexArgs || []).join(' ') || '(空)'}\n- claudeArgs: ${(config.claudeArgs || []).join(' ') || '(空)'}\n- opencodeArgs: ${(config.opencodeArgs || []).join(' ') || '(空)'}`;
    if (output.json) commandSummary({ ok: true, command: 'config explain', config, explain: text }, output);
    else process.stdout.write(`${text}\n`);
    return;
  }

  if (!output.json) {
    process.stdout.write('== Config Wizard ==\n');
    if (!process.stdin.isTTY) {
      output.warn('检测到非交互终端，配置向导将使用当前值');
    }
  }

  const currentCodexToggles = getCodexModeToggles(config.codexArgs);
  let codexFullAuto = currentCodexToggles.fullAuto;
  const currentClaudeToggles = getClaudePermissionToggles(config.claudeArgs);
  let claudeBypassPermissions = currentClaudeToggles.bypassPermissions;
  let claudeSkipPermissions = currentClaudeToggles.skipPermissions;
  const askedAgents = new Set();
  const applyAgentToggles = async (agent) => {
    await askAgentTogglesIfNeeded(agent, {
      codexFullAuto,
      claudeBypassPermissions,
      claudeSkipPermissions
    }, output, askedAgents).then((next) => {
      codexFullAuto = next.codexFullAuto;
      claudeBypassPermissions = next.claudeBypassPermissions;
      claudeSkipPermissions = next.claudeSkipPermissions;
    });
  };

  if (process.stdin.isTTY) {
    if (!output.json) process.stdout.write('\n[设置 1/3] Default Agent\n');
    const defaultAgent = await askAgentChoice('DefaultAgent', config.defaultAgent, output);
    await applyAgentToggles(defaultAgent);

    if (!output.json) process.stdout.write('\n[设置 2/3] AgentMode 右上\n');
    const pairTop = await askAgentChoice('AgentMode 右上 Agent', config.agentPair[0], output);
    await applyAgentToggles(pairTop);

    if (!output.json) process.stdout.write('\n[设置 3/3] AgentMode 右下\n');
    const pairBottom = await askAgentChoice('AgentMode 右下 Agent', config.agentPair[1], output);
    await applyAgentToggles(pairBottom);

    config.defaultAgent = defaultAgent;
    config.agentPair = [pairTop, pairBottom];
  } else if (!output.json) {
    output.info(`非交互模式，保持 Codex FullAuto: ${codexFullAuto ? '开启' : '关闭'}`);
    output.info(`非交互模式，保持 Claude BypassPermissions: ${claudeBypassPermissions ? '开启' : '关闭'}`);
    output.info(`非交互模式，保持 Claude SkipPermissions: ${claudeSkipPermissions ? '开启' : '关闭'}`);
  }

  const next = {
    ...config,
    defaultAgent: config.defaultAgent,
    agentPair: [config.agentPair[0], config.agentPair[1]],
    codexArgs: applyCodexModeToggles(config.codexArgs, { fullAuto: codexFullAuto }),
    claudeArgs: applyClaudePermissionToggles(config.claudeArgs, {
      bypassPermissions: claudeBypassPermissions,
      skipPermissions: claudeSkipPermissions
    }),
    backend: 'zellij',
    rightTerminal: config.rightTerminal,
    initialized: true
  };

  validate(next, { strict: true });
  const file = saveConfig(next);
  if (!output.json) {
    process.stdout.write('\n配置摘要：\n');
    process.stdout.write(`- defaultAgent: ${next.defaultAgent}\n`);
    process.stdout.write(`- AgentMode: [${next.agentPair[0]}, ${next.agentPair[1]}]\n`);
    process.stdout.write(`- Codex FullAuto: ${codexFullAuto ? '开启' : '关闭'}\n`);
    process.stdout.write(`- Claude BypassPermissions: ${claudeBypassPermissions ? '开启' : '关闭'}\n`);
    process.stdout.write(`- Claude SkipPermissions: ${claudeSkipPermissions ? '开启' : '关闭'}\n`);
  }
  output.ok(`配置已保存到 ${file}`);
  commandSummary({ ok: true, command: 'config wizard', file }, output);
}

function statusItem(ok, label, detail) {
  return { ok, label, ...(detail ? { detail } : {}) };
}

function cmdStatus(flags, output) {
  needMacOS();
  const { config, file, exists } = loadConfig({ strict: false });
  const managedAgents = normalizeManagedAgents(config.managedAgents);
  const commandProbeList = ['brew', 'git', 'node', 'zellij', 'yazi', 'gum', 'keifu', 'osascript', 'codex', 'claude', 'claude-code', 'opencode'];
  const commandAvailability = commandExistsMany(commandProbeList);

  const envChecks = checkSetupState({ managedAgents, commandAvailability })
    .concat([statusItem(hasCommand('osascript', commandAvailability), 'osascript')])
    .map((item) => statusItem(item.ok, item.label, item.detail));

  let configOk = true;
  let configError = null;
  try {
    validate(config, { strict: true });
  } catch (error) {
    configOk = false;
    configError = error.message;
  }

  const runChecks = [{
    backend: 'zellij',
    ok: !!commandAvailability.zellij,
    error: commandAvailability.zellij ? null : 'zellij command missing'
  }];

  if (!output.json) {
    output.info(`配置文件: ${file}`);
    output.info(`配置状态: ${exists ? '已存在' : '不存在'}`);
    envChecks.forEach((c) => (c.ok ? output.ok(c.label) : output.warn(`${c.label} 缺失`)));
    if (flags.doctor) {
      output.info('运行层诊断：');
      runChecks.forEach((c) => (c.ok ? output.ok(`${c.backend} 可用`) : output.warn(`${c.backend} 不可用: ${c.error}`)));
      const doctorMissing = reportSetupState(output, checkSetupState({ managedAgents, commandAvailability }));
      if (doctorMissing.length === 0) output.ok('setup 自动化安装项全部就绪');
      else output.warn(`setup 自动化安装项缺失 ${doctorMissing.length} 项`);
      output.info(`Agent 升级管理范围: ${managedAgents.length > 0 ? managedAgents.join(', ') : '未启用'}`);
    }
    if (configOk) output.ok('配置校验通过');
    else output.error(`配置校验失败: ${configError}`);
  }

  commandSummary({
    ok: configOk,
    command: 'status',
    env: envChecks,
    config: { ok: configOk, file, exists, error: configError },
    runtime: runChecks
  }, output);
}

function cmdUpdate(output, deps = {}) {
  const needMacOSFn = deps.needMacOS || needMacOS;
  const commandExistsFn = deps.commandExists || commandExists;
  const loadConfigFn = deps.loadConfig || loadConfig;
  const runFn = deps.run || run;
  const checkSetupStateFn = deps.checkSetupState || checkSetupState;
  const reportSetupStateFn = deps.reportSetupState || reportSetupState;
  const ensurePluginConfigsFn = deps.ensurePluginConfigs || ensurePluginConfigs;
  const isClaudeAvailableFn = deps.isClaudeAvailable || isClaudeAvailable;
  const getClaudeUpgradeInvocationsFn = deps.getClaudeUpgradeInvocations || getClaudeUpgradeInvocations;

  needMacOSFn();
  if (!commandExistsFn('brew')) throw new ZvibeError(ERRORS.COMMAND_MISSING, '未检测到 Homebrew');
  const { config } = loadConfigFn({ strict: false });
  const managedAgents = normalizeManagedAgents(config.managedAgents);

  output.info('正在执行全量更新：仅更新已安装插件与已管理 Agent');
  const brewUpdate = runFn('brew', ['update'], { capture: true });
  if (!brewUpdate.ok) {
    throw new ZvibeError(
      ERRORS.RUN_FAILED,
      'brew update 失败',
      (brewUpdate.stderr || brewUpdate.stdout || '').trim() || '请手动执行 brew update'
    );
  }

  REQUIRED_FORMULAS.forEach(({ command, formula }) => {
    if (!commandExistsFn(command)) {
      output.info(`跳过 ${formula} 升级（未安装）`);
      return;
    }
    brewUpgradeFormula(formula, output);
  });

  if (commandExistsFn('keifu')) {
    brewTap('trasta298/tap');
    brewUpgradeFormula('trasta298/tap/keifu', output);
  } else {
    output.info('跳过 keifu 升级（未安装）');
  }

  REQUIRED_CASKS.forEach(({ appDir, cask }) => {
    if (!fs.existsSync(appDir)) {
      output.info(`跳过 ${cask} 升级（未安装）`);
      return;
    }
    brewUpgradeCask(cask, output);
  });

  if (managedAgents.includes('opencode')) {
    if (!commandExistsFn('opencode')) {
      output.info('跳过 opencode 升级（已管理但未安装）');
    } else {
      brewTap('anomalyco/tap');
      brewUpgradeFormula('anomalyco/tap/opencode', output);
    }
  } else {
    output.info('跳过 opencode 升级（未纳入 managedAgents）');
  }

  if (managedAgents.includes('codex')) {
    if (!commandExistsFn('codex')) {
      output.info('跳过 codex 升级（已管理但未安装）');
    } else {
      if (!commandExistsFn('npm')) {
        throw new ZvibeError(ERRORS.COMMAND_MISSING, '缺少 npm，无法升级 codex', '请先安装 Node.js/npm');
      }
      const codexUpgrade = runFn('npm', ['install', '-g', '@openai/codex@latest'], { capture: true });
      if (!codexUpgrade.ok) {
        throw new ZvibeError(
          ERRORS.RUN_FAILED,
          'codex 升级失败',
          (codexUpgrade.stderr || codexUpgrade.stdout || '').trim() || '请手动执行 npm install -g @openai/codex@latest'
        );
      }
      output.ok('codex 升级完成');
    }
  } else {
    output.info('跳过 codex 升级（未纳入 managedAgents）');
  }

  if (managedAgents.includes('claude')) {
    if (!isClaudeAvailableFn()) {
      output.info('跳过 claude 升级（已管理但未安装）');
    } else {
      const invocations = getClaudeUpgradeInvocationsFn();

      let upgraded = false;
      let lastDetail = '';
      for (const [command, subcommand] of invocations) {
        const result = runFn(command, [subcommand], { capture: true });
        if (result.ok) {
          output.ok(`claude 升级完成（${command} ${subcommand}）`);
          upgraded = true;
          clearCommandExistsCache();
          break;
        }
        lastDetail = (result.stderr || result.stdout || result.error || '').trim();
      }

      if (!upgraded) {
        throw new ZvibeError(
          ERRORS.RUN_FAILED,
          'claude 升级失败',
          lastDetail || '请手动执行 claude update 或 claude upgrade'
        );
      }
    }
  } else {
    output.info('跳过 claude 升级（未纳入 managedAgents）');
  }

  const brewCleanup = runFn('brew', ['cleanup'], { capture: true });
  if (!brewCleanup.ok) {
    throw new ZvibeError(
      ERRORS.RUN_FAILED,
      'brew cleanup 失败',
      (brewCleanup.stderr || brewCleanup.stdout || '').trim() || '请手动执行 brew cleanup'
    );
  }
  ensurePluginConfigsFn(output, { overwrite: true });

  const checks = checkSetupStateFn({ managedAgents });
  const missing = reportSetupStateFn(output, checks, { strict: false });
  if (missing.length > 0) {
    output.warn(`更新后检测到缺失项 ${missing.length} 个（仅提示，不自动安装）`);
  }

  output.ok('全量更新完成');
  commandSummary({ ok: true, command: 'update', managedAgents, missingCount: missing.length }, output);
}

function cmdSession(positional, output) {
  const rawSub = positional[1] || 'list';
  const sub = (rawSub === '-l' || rawSub === '--list')
    ? 'list'
    : ((rawSub === '-a' || rawSub === '--attach')
      ? 'attach'
      : ((rawSub === '-k' || rawSub === '--kill') ? 'kill' : rawSub));
  if (sub === 'list') {
    const sessions = zellijBackend.listSessions();
    if (!output.json) {
      if (sessions.length === 0) output.info('当前没有 zvibe 会话');
      else sessions.forEach((name) => process.stdout.write(`${name}\n`));
    }
    commandSummary({ ok: true, command: 'session list', sessions }, output);
    return;
  }

  if (sub === 'kill') {
    const name = positional[2];
    if (!name) throw new ZvibeError(ERRORS.RUN_FAILED, '缺少会话名', '用法: zvibe session kill <name>');
    if (String(name).toLowerCase() === 'all') {
      const sessions = zellijBackend.listSessions();
      if (sessions.length === 0) {
        if (!output.json) output.info('当前没有可删除的 zvibe 会话');
        commandSummary({ ok: true, command: 'session kill', sessions: [], count: 0 }, output);
        return;
      }
      const killed = [];
      sessions.forEach((session) => {
        killed.push(zellijBackend.killSession(session));
      });
      if (!output.json) output.ok(`会话已删除 ${killed.length} 个`);
      commandSummary({ ok: true, command: 'session kill', sessions: killed, count: killed.length }, output);
      return;
    }
    const killed = zellijBackend.killSession(name);
    output.ok(`会话已删除: ${killed}`);
    commandSummary({ ok: true, command: 'session kill', session: killed }, output);
    return;
  }

  if (sub === 'attach') {
    const name = positional[2];
    if (!name) throw new ZvibeError(ERRORS.RUN_FAILED, '缺少会话名', '用法: zvibe session attach <name>');
    const attached = zellijBackend.attachSession(name);
    commandSummary({ ok: true, command: 'session attach', session: attached }, output);
    return;
  }

  throw new ZvibeError(ERRORS.RUN_FAILED, `未知 session 子命令: ${rawSub}`, '可用命令: zvibe session list | zvibe session -l | zvibe session attach <name> | zvibe session -a <name> | zvibe session kill <name|all> | zvibe session -k <name|all>');
}

function isUnsafeAutoGitInitTarget(targetDir) {
  const resolved = path.resolve(targetDir);
  const homeDir = path.resolve(os.homedir());

  if (resolved === homeDir) {
    return { unsafe: true, reason: '目标目录是用户主目录（HOME）' };
  }

  if (resolved === path.parse(resolved).root) {
    return { unsafe: true, reason: '目标目录是文件系统根目录' };
  }

  return { unsafe: false, reason: '' };
}

function autoGitInit(targetDir, config, output) {
  if (!config.autoGitInit) return;
  if (fs.existsSync(path.join(targetDir, '.git'))) return;
  if (!commandExists('git')) return;

  const safety = isUnsafeAutoGitInitTarget(targetDir);
  if (safety.unsafe) {
    output.warn(`已跳过自动 Git 初始化：${safety.reason} (${targetDir})`);
    output.info('建议：切换到具体项目目录后再运行 zvibe');
    return;
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    output.warn(`已跳过自动 Git 初始化：目录不存在或不可访问 (${targetDir})`);
    return;
  }

  const initResult = run('git', ['init'], { cwd: targetDir, capture: true });
  if (!initResult.ok) {
    output.warn(`自动 git init 失败，已跳过后续步骤: ${initResult.stderr || initResult.stdout}`);
    return;
  }

  const addResult = run('git', ['add', '-A'], { cwd: targetDir, capture: true });
  if (!addResult.ok) {
    output.warn(`自动 git add 失败，已跳过提交: ${addResult.stderr || addResult.stdout}`);
    return;
  }

  const commitResult = run('git', ['commit', '-m', 'init: zvibe workspace'], { cwd: targetDir, capture: true });
  if (!commitResult.ok) {
    const combined = `${commitResult.stderr || ''}\n${commitResult.stdout || ''}`.toLowerCase();
    if (combined.includes('nothing to commit')) {
      output.info(`git 仓库已初始化（无可提交变更）: ${targetDir}`);
      return;
    }
    output.warn(`自动 git commit 失败（可忽略）: ${commitResult.stderr || commitResult.stdout}`);
    return;
  }

  output.info(`已初始化 git 仓库: ${targetDir}`);
}

function resolveRunConfig(positional, flags) {
  const parsed = parseRun(positional);
  const loaded = loadConfig({ strict: true });
  const cli = {
    defaultAgent: AGENTS.includes(parsed.mode) ? parsed.mode : undefined,
    agentPair: flags.agentPair && flags.agentPair.length === 2 ? flags.agentPair : undefined,
    backend: flags.backend,
    fallback: flags.fallback,
    rightTerminal: flags.rightTerminal
  };
  const merged = mergeWithPriority(cli, loaded.config);
  return { parsed, config: merged, configFile: loaded.file };
}

function stableLetters(seed, size = 2) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const input = String(seed || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let out = '';
  for (let i = 0; i < size; i += 1) {
    const idx = Math.abs(hash + (i * 17)) % alphabet.length;
    out += alphabet[idx];
    hash = Math.imul(hash ^ (idx + 97), 16777619);
  }
  return out;
}

function stableDigits(seed, size = 2) {
  const numbers = '0123456789';
  const input = String(seed || '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash |= 0;
  }
  let out = '';
  for (let i = 0; i < size; i += 1) {
    const idx = Math.abs(hash + (i * 29)) % numbers.length;
    out += numbers[idx];
    hash = ((hash << 5) + hash) ^ (idx + 48);
    hash |= 0;
  }
  return out;
}

function modeLabel(mode) {
  if (mode === 'code') return 'code';
  if (mode === 'terminal') return 'terminal';
  if (mode === 'codex') return 'codex';
  if (mode === 'claude') return 'claude';
  if (mode === 'opencode') return 'opencode';
  return 'agent';
}

function buildSessionTag({ targetDir, mode, codeMode, agentPair }) {
  const seed = codeMode
    ? `${targetDir}|${mode}|${agentPair[0]}|${agentPair[1]}`
    : `${targetDir}|${mode}`;
  const suffix = `${stableLetters(seed, 2)}${stableDigits(seed, 2)}`;
  return `${modeLabel(mode)}-${suffix}`;
}

function detectViewport() {
  const envCols = Number(process.env.COLUMNS || '');
  const envRows = Number(process.env.LINES || '');
  const columns = Number.isFinite(process.stdout.columns) && process.stdout.columns > 0
    ? process.stdout.columns
    : (Number.isFinite(envCols) && envCols > 0 ? envCols : 160);
  const rows = Number.isFinite(process.stdout.rows) && process.stdout.rows > 0
    ? process.stdout.rows
    : (Number.isFinite(envRows) && envRows > 0 ? envRows : 48);
  return { columns, rows };
}

function cmdRun(positional, flags, output) {
  needMacOS();
  const { parsed, config } = resolveRunConfig(positional, flags);
  const terminalOnlyByMode = parsed.mode === 'terminal';
  const terminalOnlyByFlag = !!flags.terminalOnly;
  const terminalOnly = terminalOnlyByMode || terminalOnlyByFlag;
  const mode = terminalOnly ? 'terminal' : (parsed.mode || config.defaultAgent);

  if (mode !== 'code' && mode !== 'terminal' && !AGENTS.includes(mode)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `运行模式非法: ${mode}`);
  }

  const targetDir = path.resolve(parsed.targetDir);
  const codeMode = mode === 'code';
  const passthroughArgs = []
    .concat(flags.passthroughArgs || [])
    .concat(parsed.agentArgs || [])
    .concat(flags.doubleDashArgs || []);
  const primaryConfiguredArgs = codeMode ? configuredAgentArgs(config, config.agentPair[0]) : configuredAgentArgs(config, mode);
  const secondaryConfiguredArgs = codeMode ? configuredAgentArgs(config, config.agentPair[1]) : [];
  const primaryAgent = terminalOnly
    ? 'true'
    : (codeMode ? buildAgentCommand(config.agentPair[0], primaryConfiguredArgs) : buildAgentCommand(mode, primaryConfiguredArgs.concat(passthroughArgs)));
  const secondaryAgent = codeMode ? buildAgentCommand(config.agentPair[1], secondaryConfiguredArgs) : '';
  const commands = {
    leftTop: terminalOnly ? '' : 'yazi',
    leftBottom: terminalOnly ? '' : 'keifu',
    rightTop: primaryAgent,
    rightTopRole: terminalOnly ? 'terminal' : 'agent',
    rightBottom: terminalOnly ? '' : (codeMode ? secondaryAgent : (config.rightTerminal ? 'true' : '')),
    minimalTerminal: terminalOnly,
    statusBar: buildStatusBarCommand({
      primaryAgent: terminalOnly ? '' : (codeMode ? config.agentPair[0] : mode),
      secondaryAgent: codeMode ? config.agentPair[1] : '',
      noAgent: terminalOnly
    })
  };
  const sessionTag = buildSessionTag({
    targetDir,
    mode,
    codeMode,
    agentPair: config.agentPair
  });
  const viewport = detectViewport();

  autoGitInit(targetDir, config, output);
  const backend = selectBackend(config.backend, output);
  zellijBackend.launch({ targetDir, commands, freshSession: !!flags.freshSession, sessionTag, viewport });

  commandSummary({ ok: true, command: 'run', backend, mode, targetDir }, output);
}

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const output = new Output({ json: flags.json, verbose: flags.verbose });
  const command = positional[0] || '';

  try {
    if ((flags.unknownFlags || []).length > 0) {
      throw new ZvibeError(
        ERRORS.RUN_FAILED,
        `未知参数: ${flags.unknownFlags[0]}`,
        '请执行 zvibe --help 查看可用参数'
      );
    }

    if (flags.help || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(renderUsage());
      return;
    }
    if (flags.version || ['version', '--version', '-v', '--v'].includes(command)) {
      process.stdout.write(`${version}\n`);
      return;
    }

    if (command === 'setup') return await cmdSetup(flags, output);
    if (command === 'config') return await cmdConfig(positional, output);
    if (command === 'status') return cmdStatus({ doctor: !!flags.doctor || flags.verbose }, output);
    if (command === 'update') return cmdUpdate(output);
    if (command === 'session') return cmdSession(positional, output);

    if (command && !MODES.includes(command) && !TOP_LEVEL_COMMANDS.includes(command)) {
      if (!shouldTreatFirstPositionalAsRunTarget(command)) {
        const suggestion = suggestTopCommand(command);
        throw new ZvibeError(
          ERRORS.RUN_FAILED,
          `未知命令: ${command}`,
          suggestion
            ? `你是不是想输入: zvibe ${suggestion}${positional[1] ? ` ${positional.slice(1).join(' ')}` : ''}`
            : '请执行 zvibe --help 查看可用命令'
        );
      }
    }
    return cmdRun(positional, flags, output);
  } catch (error) {
    if (error instanceof ZvibeError) {
      if (error.code === ERRORS.CONFIG_MISSING && !flags.json) {
        output.warn('当前未完成配置初始化。');
        output.info('请先执行：zvibe setup');
      }
      output.error(`${error.message} (${error.code})`);
      if (error.hint) output.info(`建议: ${error.hint}`);
      if (flags.verbose && error.cause) output.warn(String(error.cause));
      commandSummary({ ok: false, error: { code: error.code, message: error.message, hint: error.hint } }, output);
      process.exit(1);
    }

    output.error(`未知错误: ${error.message || error}`);
    commandSummary({ ok: false, error: { code: 'E_UNKNOWN', message: String(error.message || error) } }, output);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  ensureClaude,
  isClaudeAvailable,
  getClaudeUpgradeInvocations,
  withAgentEnv,
  agentUnsetVars,
  configuredAgentArgs,
  parseArgList,
  parseArgv,
  shouldTreatFirstPositionalAsRunTarget,
  detectViewport,
  getCodexModeToggles,
  applyCodexModeToggles,
  getClaudePermissionToggles,
  applyClaudePermissionToggles,
  cmdUpdate
};
