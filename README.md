# Zvibe

**AI 编程工作台 —— 在统一的终端空间里，让人与 AI 高效协作。**

Zvibe 是一个基于 Zellij 的多面板开发工作台。它将代码浏览、AI 对话、系统监控整合在一个界面中：你可以在左侧快速导航项目文件，在右侧与 Codex/Claude/OpenCode 对话编程，底部状态栏实时追踪 CPU、GPU、内存、网络以及 Token 消耗等关键数据。无论是单 Agent 开发、双 Agent 协作，还是纯终端操作，Zvibe 都能一键启动、自动布局、会话持久化，让你专注于编码本身，无需在多个窗口之间来回切换。

---

## 核心特性

- **多 Agent 支持** — 无缝集成 Codex、Claude、OpenCode 三大 AI 编程助手
- **双 Agent 协作模式** — 同时启动两个 Agent，实现多模型协作开发
- **智能会话管理** — 基于目录的会话命名，支持 attach/kill/list 操作
- **实时系统监控** — 底部状态栏实时显示 CPU/GPU/内存/网络/Token 消耗等关键指标
- **一键环境初始化** — 自动安装并配置所有依赖（Zellij、Yazi、Ghostty 等）
- **灵活布局模式** — 支持纯终端模式、单 Agent 模式、双 Agent 模式等多种工作区布局

---

## 安装

### 全局安装（推荐）

```bash
npm i -g @zanetach/zvibe
```

### 临时执行

```bash
npx @zanetach/zvibe setup
```

### 本地打包安装

```bash
npm pack
npm i -g ./zanetach-zvibe-<version>.tgz
```

---

## 快速开始

```bash
# 初始化环境（自动安装依赖并配置）
zvibe setup

# 检查环境状态
zvibe status --doctor

# 启动默认 Agent
zvibe

# 启动指定 Agent
zvibe claude
zvibe codex
zvibe opencode

# 启动双 Agent 模式
zvibe code

# 纯终端模式
zvibe terminal
```

---

## 使用指南

### 启动模式

| 命令 | 说明 |
|------|------|
| `zvibe` | 启动默认 Agent（配置文件指定） |
| `zvibe codex` | 启动 Codex 工作区 |
| `zvibe claude` | 启动 Claude 工作区 |
| `zvibe opencode` | 启动 OpenCode 工作区 |
| `zvibe code` | 双 Agent 模式（同时启动两个 Agent） |
| `zvibe terminal` / `zvibe -t` | 纯终端模式（无 Agent） |
| `zvibe <dir> [agent]` | 在指定目录启动 |
| `zvibe <agent> -p <args>` | 透传参数给 Agent |

### 初始化与配置

```bash
# 交互式初始化
zvibe setup

# 修复模式（重新安装缺失依赖）
zvibe setup --repair

# 无交互模式（使用默认值）
zvibe setup --yes

# 配置向导
zvibe config wizard

# 查看/修改配置
zvibe config get defaultAgent
zvibe config set defaultAgent claude
zvibe config validate
zvibe config explain
```

`zvibe setup` 现在会将内置的 `zellij` 配置目录（`config.kdl`、`layouts/zvibe.kdl`、`themes/cyber.kdl`、`VERSION`）一次性覆盖到 `~/.config/zellij`，覆盖前会自动备份当前目录中非备份文件。

### 会话管理

```bash
# 列出所有会话
zvibe session list
zvibe session -l

# 附加到现有会话
zvibe session attach <name>
zvibe session -a <name>

# 关闭会话
zvibe session kill <name>
zvibe session -k <name>
zvibe session kill all    # 关闭所有会话
```

### 状态与更新

```bash
# 查看状态
zvibe status

# 诊断模式
zvibe status --doctor

# 更新所有组件
zvibe update
```

---

## 全局参数

| 参数 | 说明 |
|------|------|
| `--fresh-session` | 强制重建当前目录会话 |
| `--reuse-session` | 复用已有会话（默认行为） |
| `-t, --terminal` | 添加右侧终端面板 |
| `-p, --passthrough` | 透传剩余参数给 Agent |
| `--yes` | 无交互模式 |
| `--json` | JSON 格式输出 |
| `--verbose` | 详细诊断信息 |

### `-t, --terminal` 参数语义

- `zvibe -t` — 纯终端最小布局
- `zvibe codex -t` — Agent 模式 + 右侧终端面板
- `zvibe code -t` — 双 Agent 模式（不添加额外终端）

---

## 配置文件

配置文件路径：`~/.config/zvibe/config.json`

```json
{
  "defaultAgent": "codex",
  "agentPair": ["opencode", "codex"],
  "agentArgs": [],
  "codexArgs": ["--dangerously-skip-permissions"],
  "claudeArgs": [],
  "opencodeArgs": [],
  "managedAgents": ["claude", "codex"],
  "backend": "zellij",
  "fallback": true,
  "rightTerminal": false,
  "autoGitInit": true,
  "initialized": true
}
```

### 配置项说明

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `defaultAgent` | string | 默认启动的 Agent（codex/claude/opencode） |
| `agentPair` | array | 双 Agent 模式使用的 Agent 组合 |
| `agentArgs` | array | 所有 Agent 通用默认参数 |
| `codexArgs` | array | 启动 codex 时附加参数 |
| `claudeArgs` | array | 启动 claude 时附加参数 |
| `opencodeArgs` | array | 启动 opencode 时附加参数 |
| `managedAgents` | array | 受管理的 Agent 列表（用于 update 命令） |
| `backend` | string | 后端类型（目前仅支持 zellij） |
| `fallback` | boolean | 是否启用回退机制 |
| `rightTerminal` | boolean | 默认启用右侧终端 |
| `autoGitInit` | boolean | 自动初始化 Git 仓库 |

### Agent 参数配置示例

```bash
# 给 codex 永久增加参数（逗号分隔）
zvibe config set codexArgs --dangerously-skip-permissions

# 或用 JSON 数组形式（更适合多参数）
zvibe config set codexArgs '["--dangerously-skip-permissions","--model","gpt-5"]'
```

---

## 状态栏指标

底部状态栏实时显示以下信息：

| 指标 | 说明 |
|------|------|
| **CPU** | CPU 使用率 + 趋势图 |
| **GPU** | GPU 使用率（支持 Apple Silicon / Intel） |
| **MEM** | 内存使用率 + 趋势图 |
| **NET** | 网络上下行速率 |
| **PING** | 延迟检测 |
| **MODEL** | 当前使用的 AI 模型 |
| **TOK** | Token 消耗统计（Input / Output / Total） |
| **CTX** | 上下文窗口使用量 |
| **COST** | 估算成本（Claude 支持） |
| **DISK** | 磁盘使用情况 |
| **BAT** | 电池电量 |
| **LOAD** | 系统负载 |
| **UPTIME** | 运行时间 |

### 图标风格设置

```bash
export ZVIBE_ICON_SET=ascii    # ASCII 字符
export ZVIBE_ICON_SET=unicode  # Unicode 符号
export ZVIBE_ICON_SET=nerd     # Nerd Font（默认）
export ZVIBE_ZELLIJ_MOUSE_MODE=true   # 可选：开启 zellij 鼠标模式（默认关闭，避免滚轮干扰 commit pane）
```

---

## 开发

```bash
git clone https://github.com/Zanetach/zvibe.git
cd zvibe
node src/cli.js --help
npm run verify:all
```

### 测试

```bash
# 语法检查
npm run verify:syntax

# 单元测试
npm run verify:test

# 二进制文件验证
npm run verify:bin

# 完整验证
npm run verify:all
```

---

## 系统要求

- **操作系统**: macOS（目前仅支持 macOS）
- **Node.js**: >= 18
- **依赖**: Zellij、Yazi、Ghostty（setup 命令自动安装）

---

## 许可证

MIT License © Zanetach
