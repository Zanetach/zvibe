const { run } = require('../core/process');
const { ZvibeError, ERRORS } = require('../core/errors');
const zellijBackend = require('./zellij');

function checkGhosttyInstalled() {
  return process.platform === 'darwin' && run('test', ['-d', '/Applications/Ghostty.app']).ok;
}

function preflight() {
  if (process.platform !== 'darwin') {
    throw new ZvibeError(ERRORS.PLATFORM_UNSUPPORTED, 'Ghostty 后端仅支持 macOS');
  }
  if (!checkGhosttyInstalled()) {
    throw new ZvibeError(ERRORS.GHOSTTY_MISSING, '未检测到 Ghostty.app', '请先运行 zvibe setup 安装 Ghostty');
  }
  zellijBackend.preflight();
}

function launch({ targetDir, commands }) {
  preflight();
  zellijBackend.launch({ targetDir, commands });
}

function healthcheck() {
  try {
    preflight();
    return { ok: true, backend: 'ghostty' };
  } catch (error) {
    return { ok: false, backend: 'ghostty', error };
  }
}

module.exports = { name: 'ghostty', preflight, launch, healthcheck };
