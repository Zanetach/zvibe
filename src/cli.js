#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Output } = require('./core/io');
const { run, commandExists } = require('./core/process');
const { ZvibeError, ERRORS } = require('./core/errors');
const { AGENTS, MODES } = require('./core/constants');
const { loadConfig, saveConfig, defaultConfig, mergeWithPriority, validate, normalizeBackend } = require('./core/config');
const { agentCommand } = require('./core/agents');
const zellijBackend = require('./backends/zellij');

function needMacOS() {
  if (process.platform !== 'darwin') {
    throw new ZvibeError(ERRORS.PLATFORM_UNSUPPORTED, 'Zvibe 目前只支持 macOS');
  }
}

function parseArgv(argv) {
  const flags = { json: false, verbose: false, yes: false, repair: false, passthroughArgs: [], doubleDashArgs: [] };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' || arg === '-p' || arg === '-P' || arg === '--passthrough') {
      flags.doubleDashArgs = argv.slice(i + 1);
      break;
    }
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--repair') flags.repair = true;
    else if (arg === '--no-repair') flags.noRepair = true;
    else if (arg === '--reuse-session') flags.reuseSession = true;
    else if (arg === '--fresh-session') flags.freshSession = true;
    else if (arg === '-t' || arg === '--terminal') flags.rightTerminal = true;
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
    else if (arg.startsWith('-')) flags.passthroughArgs.push(arg);
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

function withAgentEnv(agent, command) {
  const codexVars = ['CODEX_CI', 'CODEX_MANAGED_BY_NPM', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];
  const unsetVars = ['CLAUDECODE'];

  if (agent === 'claude' || agent === 'opencode') {
    unsetVars.push(...codexVars);
  }

  const envPrefix = unsetVars.length > 0
    ? `env ${unsetVars.map((name) => `-u ${name}`).join(' ')} `
    : '';

  return `${envPrefix}ZVIBE_AGENT=${agent} ${command}`;
}

function buildAgentCommand(agent, passthroughArgs = []) {
  const base = withPassthrough(agentCommand(agent), passthroughArgs);
  return withAgentEnv(agent, base);
}

function buildStatusBarCommand({ primaryAgent = '', secondaryAgent = '' } = {}) {
  const script = path.join(__dirname, 'tools', 'status-bar.js');
  const env = [
    `ZVIBE_PRIMARY_AGENT=${shellQuoteArg(primaryAgent || '')}`,
    `ZVIBE_SECONDARY_AGENT=${shellQuoteArg(secondaryAgent || '')}`
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

function parseRun(positional) {
  const looksLikePath = (value) => {
    if (!value) return false;
    return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..' || value.startsWith('~/') || value.includes('/');
  };
  const isDir = (value) => {
    if (!value) return false;
    try {
      return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  };
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

function selectBackend(requested, output) {
  const z = zellijBackend.healthcheck();

  if (requested && requested !== 'zellij' && !output.json) {
    output.warn(`backend=${requested} 已归一化为 zellij`);
  }
  if (!z.ok) throw z.error;
  return 'zellij';
}

function renderUsage() {
  return `${renderBanner()}Commands / 命令:\n  zvibe setup [--repair] [--no-repair]     Setup dependencies and config / 初始化依赖与配置\n  zvibe config wizard                       Interactive config wizard / 交互式配置向导\n  zvibe config get <key>                    Read config value / 读取配置项\n  zvibe config set <key> <value>            Write config value / 写入配置项\n  zvibe config validate                     Validate config file / 校验配置文件\n  zvibe config explain                      Explain effective config / 解释当前生效配置\n  zvibe status [--doctor] [--json]          Health check and diagnostics / 环境诊断\n  zvibe update                              Update toolchain wrappers / 更新工具链包装\n  zvibe session list                        List zvibe sessions / 列出会话\n  zvibe session attach <name>               Attach session / 连接到会话\n  zvibe session kill <name>                 Kill session / 删除会话\n  zvibe session -l | -a <name> | -k <name> Session shortcuts / 会话快捷参数\n\nRun / 启动:\n  zvibe\n  zvibe codex|claude|opencode|code|terminal\n  zvibe <dir> [codex|claude|opencode|code|terminal]\n  zvibe [codex|claude|opencode|code|terminal] <dir>\n  zvibe <agent> -p <agent args...>\n  zvibe <agent> -- <agent args...>\n\nGlobal Flags / 全局参数:\n  --backend zellij                Backend selection (zellij only) / 后端选择（当前仅 zellij）\n  --fresh-session                 Force rebuild if session exists / 会话存在时强制重建\n  --reuse-session                 Compatibility flag; attach-first by default / 兼容参数（当前默认优先 attach）\n  -p, --passthrough               Pass all following args to agent / 后续参数全部透传给 Agent\n  -t, --terminal                  Terminal-only session when used alone; add right terminal pane in explicit agent mode / 单独使用时进入纯终端模式；在显式 agent 模式下表示右侧增加 Terminal\n  --json                          JSON output / 以 JSON 输出结果\n  --verbose                       Verbose diagnostics / 输出诊断细节\n`;
}

function renderBanner() {
  return ` ______     _ _        _        _  ___ _ _     
|___  /    (_) |      | |      | |/ (_) | |    
   / /_   _ _| |__ ___| | _____| ' / _| | |_   
  / /| | | | | '_ \\_  / |/ / _ \\  < | | | __|  
 / /_| |_| | | |_) / /|   <  __/ . \\| | | |_   
/_____\\__,_|_|_.__/___|_|\\_\\___|_|\\_\\_|_|\\__|  

                 zvibe\n\n`;
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

function ensureTextFile(filePath, content, { overwrite = false } = {}) {
  if (fs.existsSync(filePath) && !overwrite) return 'exists';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'written';
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

  const zellijLayout = `layout {
  pane split_direction="Vertical" {
    pane size="45%" split_direction="Horizontal" {
      pane
      pane
    }
    pane size="55%" split_direction="Horizontal" {
      pane size="70%"
      pane size="30%"
    }
  }
}
`;

  const yaziConfigPath = path.join(os.homedir(), '.config', 'yazi', 'yazi.toml');
  const yaziKeymapPath = path.join(os.homedir(), '.config', 'yazi', 'keymap.toml');
  const zellijLayoutPath = path.join(os.homedir(), '.config', 'zellij', 'layouts', 'zvibe.kdl');

  const mode = { overwrite };
  const yaziConfigResult = ensureTextFile(yaziConfigPath, yaziToml, mode);
  const yaziKeymapResult = ensureTextFile(yaziKeymapPath, yaziKeymap, mode);
  const zellijLayoutResult = ensureTextFile(zellijLayoutPath, zellijLayout, mode);

  output.info(`插件配置: yazi.toml ${yaziConfigResult === 'written' ? (overwrite ? '已覆盖写入' : '已写入') : '已存在，跳过'}`);
  output.info(`插件配置: keymap.toml ${yaziKeymapResult === 'written' ? (overwrite ? '已覆盖写入' : '已写入') : '已存在，跳过'}`);
  output.info(`插件配置: zellij layout ${zellijLayoutResult === 'written' ? (overwrite ? '已覆盖写入' : '已写入') : '已存在，跳过'}`);
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

async function cmdSetup(flags, output) {
  needMacOS();
  const autoInstall = true;
  const repairMode = !!flags.repair;
  const noRepair = !!flags.noRepair;
  const overwritePluginConfigs = noRepair ? false : true;
  if (!output.json) {
    process.stdout.write(renderBanner());
    process.stdout.write('== Step 1/2 检测安装 ==\n');
  }

  if (!commandExists('brew')) {
    if (!autoInstall) {
      throw new ZvibeError(ERRORS.COMMAND_MISSING, '未检测到 Homebrew', '请先安装 Homebrew 后重试 zvibe setup');
    }
    const installBrew = run('sh', ['-lc', '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"']);
    if (!installBrew.ok) throw new ZvibeError(ERRORS.COMMAND_MISSING, 'Homebrew 安装失败');
  }

  ensureCommandOrBrew('git', 'git', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('node', 'node', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('zellij', 'zellij', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('yazi', 'yazi', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('gum', 'gum', output, { install: autoInstall || repairMode });

  if (!commandExists('keifu')) {
    run('brew', ['tap', 'trasta298/tap']);
    ensureCommandOrBrew('keifu', 'trasta298/tap/keifu', output, { install: true });
  }

  if (!commandExists('opencode')) {
    run('brew', ['tap', 'anomalyco/tap']);
    ensureCommandOrBrew('opencode', 'anomalyco/tap/opencode', output, { install: true });
  }

  ensureCask('/Applications/Ghostty.app', 'ghostty', output, { install: autoInstall || repairMode });
  if (commandExists('claude') || commandExists('claude-code')) {
    output.ok('Claude CLI PASS（已可用，跳过 Claude Code.app 安装检查）');
  } else {
    ensureCask('/Applications/Claude Code.app', 'claude-code', output, { install: autoInstall || repairMode });
  }

  ensurePluginConfigs(output, { overwrite: overwritePluginConfigs });
  await setupGpuPowermetricsSudo(output);

  if (!output.json) {
    process.stdout.write('\n== Step 2/2 设置 ==\n');
  }
  const current = defaultConfig();
  let defaultAgent = current.defaultAgent;
  let pairTop = current.agentPair[0];
  let pairBottom = current.agentPair[1];

  if (!process.stdin.isTTY && !output.json) {
    output.warn('检测到非交互终端，设置步骤将使用默认值');
  }
  process.stdout.write('\n[设置 1/3] Default Agent\n');
  defaultAgent = await askAgentChoice('DefaultAgent', defaultAgent, output);

  process.stdout.write('\n[设置 2/3] AgentMode 右上\n');
  pairTop = await askAgentChoice('AgentMode 右上 Agent', pairTop, output);

  process.stdout.write('\n[设置 3/3] AgentMode 右下\n');
  pairBottom = await askAgentChoice('AgentMode 右下 Agent', pairBottom, output);

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
    process.stdout.write(`- backend: ${cfg.backend}\n`);
  }
  output.ok(`初始化完成，配置已写入 ${file}`);

  commandSummary({ ok: true, command: 'setup', repair: repairMode, configFile: file }, output);
}

function configGet(config, key) {
  if (!(key in config)) return undefined;
  return config[key];
}

function castConfigValue(key, value) {
  if (key === 'fallback' || key === 'autoGitInit' || key === 'rightTerminal') return value === 'true';
  if (key === 'agentPair') return value.split(',').map((v) => v.trim());
  if (key === 'backend') return normalizeBackend(value);
  return value;
}

async function cmdConfig(positional, output) {
  const sub = positional[1] || 'wizard';
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
    const text = `当前行为:\n- 默认 agent: ${config.defaultAgent}\n- 双 agent: ${config.agentPair.join(' + ')}\n- 后端策略: ${config.backend}\n- 右侧 Terminal: ${config.rightTerminal ? '开启' : '关闭'}`;
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

  if (!output.json) process.stdout.write('\n[设置 1/3] Default Agent\n');
  const defaultAgent = await askAgentChoice('DefaultAgent', config.defaultAgent, output);

  if (!output.json) process.stdout.write('\n[设置 2/3] AgentMode 右上\n');
  const pairTop = await askAgentChoice('AgentMode 右上 Agent', config.agentPair[0], output);

  if (!output.json) process.stdout.write('\n[设置 3/3] AgentMode 右下\n');
  const pairBottom = await askAgentChoice('AgentMode 右下 Agent', config.agentPair[1], output);

  const next = {
    ...config,
    defaultAgent: defaultAgent || config.defaultAgent,
    agentPair: [pairTop || config.agentPair[0], pairBottom || config.agentPair[1]],
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

  const envChecks = [
    statusItem(commandExists('brew'), 'brew'),
    statusItem(commandExists('node'), 'node'),
    statusItem(commandExists('git'), 'git'),
    statusItem(commandExists('yazi'), 'yazi'),
    statusItem(commandExists('keifu'), 'keifu'),
    statusItem(commandExists('opencode'), 'opencode'),
    statusItem(commandExists('osascript'), 'osascript'),
    statusItem(fs.existsSync('/Applications/Ghostty.app'), 'Ghostty.app'),
    statusItem(commandExists('zellij'), 'zellij')
  ];

  let configOk = true;
  let configError = null;
  try {
    validate(config, { strict: true });
  } catch (error) {
    configOk = false;
    configError = error.message;
  }

  const runChecks = [zellijBackend.healthcheck()].map((item) => ({
    backend: item.backend,
    ok: item.ok,
    error: item.ok ? null : item.error.message
  }));

  if (!output.json) {
    output.info(`配置文件: ${file}`);
    output.info(`配置状态: ${exists ? '已存在' : '不存在'}`);
    envChecks.forEach((c) => (c.ok ? output.ok(c.label) : output.warn(`${c.label} 缺失`)));
    if (flags.doctor) {
      output.info('运行层诊断：');
      runChecks.forEach((c) => (c.ok ? output.ok(`${c.backend} 可用`) : output.warn(`${c.backend} 不可用: ${c.error}`)));
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

function cmdUpdate(output) {
  needMacOS();
  if (!commandExists('brew')) throw new ZvibeError(ERRORS.COMMAND_MISSING, '未检测到 Homebrew');

  output.info('正在执行 brew update / upgrade / cleanup');
  run('brew', ['update']);
  run('brew', ['upgrade']);
  run('brew', ['upgrade', '--cask']);
  run('brew', ['cleanup']);
  output.ok('更新完成');
  commandSummary({ ok: true, command: 'update' }, output);
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

  throw new ZvibeError(ERRORS.RUN_FAILED, `未知 session 子命令: ${rawSub}`, '可用命令: zvibe session list | zvibe session -l | zvibe session attach <name> | zvibe session -a <name> | zvibe session kill <name> | zvibe session -k <name>');
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

function cmdRun(positional, flags, output) {
  needMacOS();
  const { parsed, config } = resolveRunConfig(positional, flags);
  const hasExplicitMode = !!parsed.mode;
  const terminalOnlyByMode = parsed.mode === 'terminal';
  const terminalOnlyByFlag = !!flags.rightTerminal
    && !hasExplicitMode
    && (!flags.passthroughArgs || flags.passthroughArgs.length === 0)
    && (!parsed.agentArgs || parsed.agentArgs.length === 0)
    && (!flags.doubleDashArgs || flags.doubleDashArgs.length === 0);
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
  const primaryAgent = terminalOnly
    ? 'true'
    : (codeMode ? buildAgentCommand(config.agentPair[0]) : buildAgentCommand(mode, passthroughArgs));
  const secondaryAgent = codeMode ? buildAgentCommand(config.agentPair[1]) : '';
  const commands = {
    leftTop: terminalOnly ? '' : 'yazi',
    leftBottom: terminalOnly ? '' : 'keifu',
    rightTop: primaryAgent,
    rightTopRole: terminalOnly ? 'terminal' : 'agent',
    rightBottom: terminalOnly ? '' : (codeMode ? secondaryAgent : (config.rightTerminal ? 'true' : '')),
    minimalTerminal: terminalOnly,
    statusBar: buildStatusBarCommand({
      primaryAgent: terminalOnly ? '' : (codeMode ? config.agentPair[0] : mode),
      secondaryAgent: codeMode ? config.agentPair[1] : ''
    })
  };
  const sessionTag = terminalOnly
    ? 'terminal-sb3'
    : (codeMode
    ? `code-${config.agentPair[0]}-${config.agentPair[1]}-sb3`
    : `${mode}-sb3`);

  autoGitInit(targetDir, config, output);
  const backend = selectBackend(config.backend, output);
  zellijBackend.launch({ targetDir, commands, freshSession: !!flags.freshSession, sessionTag });

  commandSummary({ ok: true, command: 'run', backend, mode, targetDir }, output);
}

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const output = new Output({ json: flags.json, verbose: flags.verbose });
  const command = positional[0] || '';

  try {
    if (flags.help || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(renderUsage());
      return;
    }

    if (command === 'setup') return await cmdSetup(flags, output);
    if (command === 'config') return await cmdConfig(positional, output);
    if (command === 'status') return cmdStatus({ doctor: !!flags.doctor || flags.verbose }, output);
    if (command === 'update') return cmdUpdate(output);
    if (command === 'session') return cmdSession(positional, output);

    if (command && !MODES.includes(command)) {
      const suggestion = suggestTopCommand(command);
      if (suggestion) {
        throw new ZvibeError(
          ERRORS.RUN_FAILED,
          `未知命令: ${command}`,
          `你是不是想输入: zvibe ${suggestion}${positional[1] ? ` ${positional.slice(1).join(' ')}` : ''}`
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

main();
