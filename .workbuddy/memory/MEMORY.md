# 项目长期笔记 — dsh-electron

## 关键约束

- **deepseek-harness 是三方仓库**：`https://github.com/deepseek-ai/deepseek-harness.git`，本仓库**无法修改其 CI/发布流程**。
- 该仓库**无 tag**，当前在 `master` 分支（本次会话时 HEAD = `47f943859b`），版本只能靠 commit hash 锁定，不能靠 tag/semver。
- 用户只有 `dsh-electron` 的控制权。因此"把构建职责挪到 harness 仓库"（方案 D）不可行，除非 fork。

## 架构决策（2026-08-16 评估）

- 运行时解耦模型（Electron spawn `dsh web` 子进程 + HTTP）是正确的，应保留。
- 构建时解耦因三方仓库约束，只能走：**固定 commit + 在 dsh-electron 自己 CI 里物化 + 产物缓存**（而非"制品由三方产出"）。
- `bundle-dsh.mjs` / `build-standalone.mjs` 这套胶水脚本**是必然存在的**（三方不会给你物化好的产物），优化重点是让输入冻结、输出固化、脚本健壮，而非消除脚本。
- fork 是二选一分叉：若已需要 patch（品牌隐藏 / DeepSeek profile 自定义），fork 后方案 D 复活。

## 已知坑

- 构建脚本 `spawnSync('pnpm.cmd')` 在 Node 22 需 `shell: true`（CVE-2024-27980）；`CI=true` 会让 fallback install 仍走 frozen-lockfile；pnpm 11 的 safe-delete/trash 在本机（WorkBuddy 环境）会失败，需先手动清残留 node_modules。
