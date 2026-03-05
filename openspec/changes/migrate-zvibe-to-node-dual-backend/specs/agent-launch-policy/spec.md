## ADDED Requirements

### 需求:无参数默认 Agent 启动
系统必须在用户执行无参数 `zvibe` 时读取 `defaultAgent`，并禁止进行隐式猜测。

#### 场景:defaultAgent 生效
- **当** 用户执行 `zvibe` 且配置中存在合法 `defaultAgent`
- **那么** 系统必须启动对应 Agent

### 需求:默认 Agent 失效即失败
系统必须在 `defaultAgent` 缺失或非法时立即失败，并提供修复指令。

#### 场景:defaultAgent 缺失
- **当** 用户执行 `zvibe` 且未找到 `defaultAgent`
- **那么** 系统必须阻断启动并提示如何设置 `defaultAgent`

### 需求:双 Agent 启动策略
系统必须在 `zvibe code` 模式下使用 `agentPair` 的两个 Agent 启动双 Agent 会话。

#### 场景:agentPair 启动
- **当** 用户执行 `zvibe code` 且 `agentPair` 为合法二元组
- **那么** 系统必须按顺序启动两个 Agent 会话

### 需求:参数优先级规则
系统必须遵循“命令参数优先于配置文件，配置文件优先于内置默认”的决策顺序。

#### 场景:参数覆盖配置
- **当** 用户在命令中显式指定 Agent 或后端
- **那么** 系统必须使用命令参数而非配置默认值

## MODIFIED Requirements

## REMOVED Requirements
