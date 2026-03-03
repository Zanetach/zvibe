#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Output } = require('./core/io');
const { run, commandExists } = require('./core/process');
const { ZvibeError, ERRORS } = require('./core/errors');
const { AGENTS, MODES, BACKENDS } = require('./core/constants');
const { loadConfig, saveConfig, defaultConfig, mergeWithPriority, validate, normalizeBackend } = require('./core/config');
const { agentCommand } = require('./core/agents');
const ghosttyBackend = require('./backends/ghostty');
const zellijBackend = require('./backends/zellij');

function needMacOS() {
  if (process.platform !== 'darwin') {
    throw new ZvibeError(ERRORS.PLATFORM_UNSUPPORTED, 'Zvibe 目前只支持 macOS');
  }
}

function parseArgv(argv) {
  const flags = { json: false, verbose: false, yes: false, repair: false };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--repair') flags.repair = true;
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
    else positional.push(arg);
  }

  return { flags, positional };
}

async function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} `, resolve));
  rl.close();
  return (answer || fallback || '').trim();
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

async function askBackendChoice(label, fallback, output) {
  if (!process.stdin.isTTY) {
    if (!output.json) output.ok(`${label} 已设置为 ${fallback}`);
    return fallback;
  }
  while (true) {
    const value = await ask(`${label} (${BACKENDS.join('/')})，默认 ${fallback}:`, fallback);
    const chosen = value || fallback;
    if (BACKENDS.includes(chosen)) {
      if (!output.json) output.ok(`${label} 已设置为 ${chosen}`);
      return chosen;
    }
    if (!output.json) output.warn(`输入无效：${chosen}，请从 ${BACKENDS.join('/')} 中选择`);
  }
}

function parseRun(positional) {
  const p1 = positional[0];
  const p2 = positional[1];

  if (MODES.includes(p1)) return { mode: p1, targetDir: p2 || process.cwd() };
  if (MODES.includes(p2)) return { mode: p2, targetDir: p1 || process.cwd() };
  return { mode: '', targetDir: p1 || process.cwd() };
}

function selectBackend(requested, fallbackEnabled, output) {
  const g = ghosttyBackend.healthcheck();
  const z = zellijBackend.healthcheck();

  if (requested && requested !== 'auto') {
    if (requested === 'ghostty' && !g.ok) throw g.error;
    if (requested === 'zellij' && !z.ok) throw z.error;
    return requested;
  }

  if (g.ok) return 'ghostty';
  if (fallbackEnabled && z.ok) {
    output.warn('Ghostty 不可用，已自动降级到 zellij');
    return 'zellij';
  }

  if (!g.ok) throw g.error;
  throw new ZvibeError(ERRORS.BACKEND_INVALID, '未找到可用后端');
}

function renderUsage() {
  return `Zvibe Kits\n\nCommands:\n  zvibe setup [--yes] [--repair]\n  zvibe config wizard\n  zvibe config get <key>\n  zvibe config set <key> <value>\n  zvibe config validate\n  zvibe config explain\n  zvibe status [--doctor] [--json]\n  zvibe update\n\nRun:\n  zvibe\n  zvibe codex|claude|opencode|code\n  zvibe <dir> [codex|claude|opencode|code]\n  zvibe [codex|claude|opencode|code] <dir>\n\nGlobal:\n  --backend auto|ghostty|zellij   后端选择（auto: 优先 ghostty，失败降级 zellij）\n  -t, --terminal                  单 Agent 模式下右侧增加 Terminal（右上 Agent，右下 Terminal）\n  --json                          以 JSON 输出结果\n  --verbose                       输出诊断细节\n`;
}

function commandSummary(summary, output) {
  output.flushJson(summary);
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

async function cmdSetup(flags, output) {
  needMacOS();
  const autoInstall = !!flags.yes;
  const repairMode = !!flags.repair;
  if (!output.json) {
    process.stdout.write('== Step 1/2 检测安装 ==\n');
  }

  if (!commandExists('brew')) {
    if (!autoInstall) {
      throw new ZvibeError(ERRORS.COMMAND_MISSING, '未检测到 Homebrew', '请先安装 Homebrew，或使用 zvibe setup --yes 自动安装');
    }
    const installBrew = run('sh', ['-lc', '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"']);
    if (!installBrew.ok) throw new ZvibeError(ERRORS.COMMAND_MISSING, 'Homebrew 安装失败');
  }

  ensureCommandOrBrew('git', 'git', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('node', 'node', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('zellij', 'zellij', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('yazi', 'yazi', output, { install: autoInstall || repairMode });
  ensureCommandOrBrew('gum', 'gum', output, { install: autoInstall || repairMode });

  if (!commandExists('keifu') && (autoInstall || repairMode)) {
    run('brew', ['tap', 'trasta298/tap']);
    ensureCommandOrBrew('keifu', 'trasta298/tap/keifu', output, { install: true });
  }

  if (!commandExists('opencode') && (autoInstall || repairMode)) {
    run('brew', ['tap', 'anomalyco/tap']);
    ensureCommandOrBrew('opencode', 'anomalyco/tap/opencode', output, { install: true });
  }

  ensureCask('/Applications/Ghostty.app', 'ghostty', output, { install: autoInstall || repairMode });
  if (commandExists('claude') || commandExists('claude-code')) {
    output.ok('Claude CLI PASS（已可用，跳过 Claude Code.app 安装检查）');
  } else {
    ensureCask('/Applications/Claude Code.app', 'claude-code', output, { install: autoInstall || repairMode });
  }

  if (!output.json) {
    process.stdout.write('\n== Step 2/2 设置 ==\n');
  }
  const current = defaultConfig();
  let defaultAgent = current.defaultAgent;
  let pairTop = current.agentPair[0];
  let pairBottom = current.agentPair[1];

  if (!flags.yes && !repairMode) {
    if (!process.stdin.isTTY && !output.json) {
      output.warn('检测到非交互终端，设置步骤将使用默认值');
    }
    process.stdout.write('\n[设置 1/3] Default Agent\n');
    defaultAgent = await askAgentChoice('DefaultAgent', defaultAgent, output);

    process.stdout.write('\n[设置 2/3] AgentMode 右上\n');
    pairTop = await askAgentChoice('AgentMode 右上 Agent', pairTop, output);

    process.stdout.write('\n[设置 3/3] AgentMode 右下\n');
    pairBottom = await askAgentChoice('AgentMode 右下 Agent', pairBottom, output);
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

  if (!output.json) process.stdout.write('\n[设置 1/4] Default Agent\n');
  const defaultAgent = await askAgentChoice('DefaultAgent', config.defaultAgent, output);

  if (!output.json) process.stdout.write('\n[设置 2/4] AgentMode 右上\n');
  const pairTop = await askAgentChoice('AgentMode 右上 Agent', config.agentPair[0], output);

  if (!output.json) process.stdout.write('\n[设置 3/4] AgentMode 右下\n');
  const pairBottom = await askAgentChoice('AgentMode 右下 Agent', config.agentPair[1], output);

  if (!output.json) process.stdout.write('\n[设置 4/4] 后端策略\n');
  const backend = await askBackendChoice('Backend', config.backend, output);

  const next = {
    ...config,
    defaultAgent: defaultAgent || config.defaultAgent,
    agentPair: [pairTop || config.agentPair[0], pairBottom || config.agentPair[1]],
    backend: normalizeBackend(backend || config.backend),
    rightTerminal: config.rightTerminal,
    initialized: true
  };

  validate(next, { strict: true });
  const file = saveConfig(next);
  if (!output.json) {
    process.stdout.write('\n配置摘要：\n');
    process.stdout.write(`- defaultAgent: ${next.defaultAgent}\n`);
    process.stdout.write(`- AgentMode: [${next.agentPair[0]}, ${next.agentPair[1]}]\n`);
    process.stdout.write(`- backend: ${next.backend}\n`);
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

  const runChecks = [ghosttyBackend.healthcheck(), zellijBackend.healthcheck()].map((item) => ({
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

function autoGitInit(targetDir, config, output) {
  if (!config.autoGitInit) return;
  if (fs.existsSync(path.join(targetDir, '.git'))) return;
  if (!commandExists('git')) return;
  run('git', ['init'], { cwd: targetDir });
  run('git', ['add', '-A'], { cwd: targetDir });
  run('git', ['commit', '-m', 'init: zvibe workspace'], { cwd: targetDir });
  output.info(`已初始化 git 仓库: ${targetDir}`);
}

function resolveRunConfig(positional, flags) {
  const parsed = parseRun(positional);
  const loaded = loadConfig({ strict: true });
  const cli = {
    defaultAgent: MODES.includes(parsed.mode) && parsed.mode !== 'code' ? parsed.mode : undefined,
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
  const mode = parsed.mode || config.defaultAgent;

  if (mode !== 'code' && !AGENTS.includes(mode)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `运行模式非法: ${mode}`);
  }

  const targetDir = path.resolve(parsed.targetDir);
  const codeMode = mode === 'code';
  const primaryAgent = codeMode ? agentCommand(config.agentPair[0]) : agentCommand(mode);
  const secondaryAgent = codeMode ? agentCommand(config.agentPair[1]) : '';
  const commands = {
    leftTop: 'yazi',
    leftBottom: 'keifu',
    rightTop: primaryAgent,
    rightBottom: codeMode ? secondaryAgent : (config.rightTerminal ? 'true' : '')
  };

  autoGitInit(targetDir, config, output);
  const backend = selectBackend(config.backend, config.fallback, output);

  if (backend === 'ghostty') {
    try {
      ghosttyBackend.launch({ targetDir, commands });
    } catch (error) {
      if (config.backend === 'auto' && config.fallback) {
        zellijBackend.launch({ targetDir, commands });
      } else {
        throw error;
      }
    }
  } else {
    zellijBackend.launch({ targetDir, commands });
  }

  commandSummary({ ok: true, command: 'run', backend, mode, targetDir }, output);
}

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const output = new Output({ json: flags.json, verbose: flags.verbose });
  const command = positional[0] || '';

  try {
    if (['help', '--help', '-h'].includes(command)) {
      process.stdout.write(renderUsage());
      return;
    }

    if (command === 'setup') return await cmdSetup(flags, output);
    if (command === 'config') return await cmdConfig(positional, output);
    if (command === 'status') return cmdStatus({ doctor: !!flags.doctor || flags.verbose }, output);
    if (command === 'update') return cmdUpdate(output);

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
