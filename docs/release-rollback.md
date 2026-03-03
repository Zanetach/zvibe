# Zvibe Node 版本发布与回滚方案

## 发布步骤

1. 执行回归清单（`docs/regression-checklist.md`）。
2. 确认关键命令：`help/status/config/run`。
3. 打包验证：`npm pack`。
4. 发布前记录当前稳定版本 tag。
5. 发布 Node 版本。

## 监控重点

- `zvibe` 无参数启动成功率
- `backend=ghostty|zellij` 路由正确率
- Ghostty 自动化失败错误码分布（`E_GHOSTTY_ACCESS`）

## 回滚策略

1. 若出现阻断故障，立即回滚到上一个 npm 版本。
2. 保留 legacy Bash 脚本作为应急入口（当前仓库仍保留历史实现可参考）。
3. 热修复策略：
   - 优先修复错误码映射与配置兼容问题。
   - 对高频失败路径优先修复 Ghostty 启动参数与权限问题。
4. 回滚后发布修复版本并附迁移说明。

## 用户公告建议

- 告知默认行为保持不变：`zvibe` / `zvibe code`。
- 告知新增能力：`--backend`、`--json`、`setup --repair`。
- 提供故障自救路径：`zvibe status --doctor`。
