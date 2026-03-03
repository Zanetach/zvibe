# Zvibe 回归清单（Node 版本）

## 命令基础

- [x] `zvibe --help` 输出完整命令帮助
- [x] `zvibe status` 可输出环境、配置与运行层状态
- [x] `zvibe status --json` 输出结构化 JSON
- [x] `zvibe config validate` 配置校验通过
- [x] `zvibe config explain` 输出当前行为解释

## 配置管理

- [x] `zvibe config set backend zellij` 可写入配置
- [x] 兼容旧配置字段 `AgentMode`（自动映射为 `agentPair`）
- [x] 缺失/非法配置时返回可行动错误码

## 启动策略

- [x] 无参数 `zvibe` 启动 defaultAgent（已验证启动路径与 mode 解析）
- [x] `zvibe code` 启动双 Agent（已验证 mode=code 路径）
- [x] `--backend ghostty|zellij|auto` 可进入对应后端流程
- [x] 兼容旧参数 `--backend tmux` 并自动映射为 `zellij`

## setup/update

- [x] `zvibe setup --repair` 可执行并保留已满足项
- [ ] `zvibe setup --yes` 全自动安装流程（当前环境受 Homebrew 目录权限限制）
- [ ] `zvibe update` 升级流程（当前环境未执行）
