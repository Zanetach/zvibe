const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, commandExists } = require('../core/process');
const { ZvibeError, ERRORS } = require('../core/errors');

function sessionName(targetDir) {
  return targetDir.split('/').filter(Boolean).pop().replace(/[^a-zA-Z0-9_-]/g, '-');
}

function preflight() {
  if (!commandExists('zellij')) {
    throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
  }
}

function shellWrap(targetDir, command) {
  const shell = process.env.SHELL || '/bin/zsh';
  const quotedDir = targetDir.replace(/'/g, `'\\''`);
  const quotedCmd = command.replace(/'/g, `'\\''`);
  const quotedShell = shell.replace(/'/g, `'\\''`);
  return `cd '${quotedDir}' && ${quotedCmd}; exec ${quotedShell} -l`;
}

function escapeKdl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function paneKdl(targetDir, command, paneName, size = null) {
  const shell = process.env.SHELL || '/bin/zsh';
  const cmd = shellWrap(targetDir, command);
  const sizeAttr = size ? ` size="${escapeKdl(size)}"` : '';
  return `pane name="${escapeKdl(paneName)}"${sizeAttr} command="${escapeKdl(shell)}" {\n        args "-lc" "${escapeKdl(cmd)}"\n      }`;
}

function buildLayout(targetDir, commands) {
  const project = sessionName(targetDir);
  const leftTop = paneKdl(targetDir, commands.leftTop, `${project}:files`);
  const leftBottom = paneKdl(targetDir, commands.leftBottom, `${project}:commit`);
  const rightBottomIsTerminal = commands.rightBottom === 'true';
  const rightTopSize = rightBottomIsTerminal ? '70%' : '50%';
  const rightBottomSize = rightBottomIsTerminal ? '30%' : '50%';
  const rightTop = paneKdl(targetDir, commands.rightTop, `${project}:agent`, rightTopSize);
  if (!commands.rightBottom) {
    return `layout {\n  pane split_direction="Vertical" {\n    pane size="40%" split_direction="Horizontal" {\n      ${leftTop}\n      ${leftBottom}\n    }\n    pane size="60%" {\n      ${rightTop}\n    }\n  }\n}\n`;
  }
  const rightBottom = paneKdl(targetDir, commands.rightBottom, `${project}:${rightBottomIsTerminal ? 'terminal' : 'agent'}`, rightBottomSize);
  return `layout {\n  pane split_direction="Vertical" {\n    pane size="40%" split_direction="Horizontal" {\n      ${leftTop}\n      ${leftBottom}\n    }\n    pane size="60%" split_direction="Horizontal" {\n      ${rightTop}\n      ${rightBottom}\n    }\n  }\n}\n`;
}

function writeLayout(targetDir, commands) {
  const file = path.join(os.tmpdir(), `zvibe-zellij-layout-${process.pid}-${Date.now()}.kdl`);
  fs.writeFileSync(file, buildLayout(targetDir, commands), 'utf8');
  return file;
}

function mustRun(command, args, hint, options = {}) {
  const result = run(command, args, options);
  if (!result.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `${command} 命令失败: ${args.join(' ')}`, hint || '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  return result;
}

function cleanupSession(name) {
  run('zellij', ['kill-session', name], { capture: true });
  run('zellij', ['delete-session', name], { capture: true });
}

function applyPaneFrames() {
  run('zellij', ['options', '--pane-frames', 'true'], { capture: true });
}

function launch({ targetDir, commands }) {
  preflight();
  const name = `zvibe-${sessionName(targetDir)}`;
  const layoutFile = writeLayout(targetDir, commands);

  try {
    const inZellij = !!process.env.ZELLIJ;
    if (inZellij) {
      // IMPORTANT: when already inside zellij, never kill/delete sessions here.
      // Otherwise we may terminate the current interactive session unexpectedly.
      mustRun('zellij', ['action', 'new-tab', '--name', name, '--cwd', targetDir, '--layout', layoutFile], '请检查当前 zellij 会话状态', { capture: true });
      applyPaneFrames();
      return;
    }

    cleanupSession(name);
    mustRun('zellij', ['-s', name, '-n', layoutFile], '请检查 zellij 配置后重试', { capture: false, cwd: targetDir });
  } finally {
    try {
      fs.unlinkSync(layoutFile);
    } catch {}
  }
}

function healthcheck() {
  try {
    preflight();
    return { ok: true, backend: 'zellij' };
  } catch (error) {
    return { ok: false, backend: 'zellij', error };
  }
}

module.exports = { name: 'zellij', preflight, launch, healthcheck, sessionName };
