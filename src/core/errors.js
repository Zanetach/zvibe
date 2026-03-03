class ZvibeError extends Error {
  constructor(code, message, hint = null, cause = null) {
    super(message);
    this.name = 'ZvibeError';
    this.code = code;
    this.hint = hint;
    this.cause = cause;
  }
}

const ERRORS = {
  CONFIG_INVALID: 'E_CONFIG_INVALID',
  CONFIG_MISSING: 'E_CONFIG_MISSING',
  AGENT_INVALID: 'E_AGENT_INVALID',
  BACKEND_INVALID: 'E_BACKEND_INVALID',
  GHOSTTY_ACCESS: 'E_GHOSTTY_ACCESS',
  GHOSTTY_MISSING: 'E_GHOSTTY_MISSING',
  ZELLIJ_MISSING: 'E_ZELLIJ_MISSING',
  COMMAND_MISSING: 'E_COMMAND_MISSING',
  RUN_FAILED: 'E_RUN_FAILED',
  PLATFORM_UNSUPPORTED: 'E_PLATFORM_UNSUPPORTED'
};

module.exports = { ZvibeError, ERRORS };
