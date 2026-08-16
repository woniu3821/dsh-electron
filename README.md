# dsh-electron

DeepSeek Harness 桌面壳。它把 `deepseek-harness` 的 `dsh web` 运行时作为**子进程**启动，再把子进程提供的 Web UI 加载进 Electron 窗口。打包逻辑全部在本仓库：`deepseek-harness` 只被**只读**使用——不提交任何改动、不修改任何跟踪文件（`scripts/bundle-dsh.mjs` 只在其目录里写入被 gitignore 的 `node_modules` 与构建产物）。

## 结构

```
src/main/index.ts       主进程：拉起 dsh web 子进程、等待就绪、管理窗口与子进程生命周期
src/renderer/           本地引导页：仅在子进程启动失败时显示错误
scripts/bundle-dsh.mjs  自包含打包器：构建 dsh（只读其检出）+ 计算运行时闭包 + 物化到 resources/dsh-<arch>
scripts/build-standalone.mjs  组装独立 CLI 分发：官方 Node + resources/dsh-<arch> → resources/dsh-standalone
bundle/                 生成的 deploy workspace（清单 + lockfile，由 bundle 脚本重建）
electron-builder.yml    桌面应用打包配置
```

## 前置条件

- Node 22.19+（或 24+）、pnpm
- 与 `dsh-electron` 位于同一父目录下的 `deepseek-harness` 检出（可用 `DSH_ROOT` 指向其他位置），无需预先构建

## 生成自包含运行时（`pnpm run bundle`）

```sh
pnpm install
pnpm run bundle
```

`scripts/bundle-dsh.mjs` 完成四件事：

1. 在 `deepseek-harness` 检出中同步依赖（`pnpm install --frozen-lockfile`，只动 gitignored 的 `node_modules`）。
2. 构建 CLI 与 Web 前端（`npm run build`，同样只写 gitignored 产物）。
3. 读取 dsh 的 workspace 清单计算 `dsh web` 配置的运行时闭包，在本地 `bundle/` workspace 生成纯依赖清单。
4. 用 `pnpm deploy` 把 CLI、依赖闭包和前端物化到 `resources/dsh-<arch>`（arch = 安装机器架构）。

`deepseek-harness` 的 git 状态在整个过程中保持干净；`bundle/` 属于本仓库，可随时删除重建。

> 说明：物化时跳过原生依赖的构建脚本（`ignore-scripts`），依赖自带预编译产物（node-pty、koffi 等为 N-API，ABI 跨 Node 版本稳定），因此同一份 payload 能在 `dsh-standalone` 携带的官方 Node 下运行。`dsh web` 的 Web 界面与主流程不依赖这些原生模块即可启动。

## 开发模式

```sh
pnpm run bundle && pnpm run standalone
pnpm dev
```

主进程默认拉起 `resources/dsh-standalone` 里的 `dsh` CLI（官方 Node + deployed 运行时，即与独立 CLI 分发、打包后的应用同一份产物），以 `web --host 127.0.0.1 --port <port>` 启动。`dsh` 启动器自带 `--expose-internals`：`dsh` 的插件加载器只有在存在该标志时才回退到 Node 内部 ESM 加载器，因此该标志是必需的。

也可以显式指定入口覆盖默认路径：

```sh
DSH_BIN=/path/to/bin.js pnpm dev       # 用 Electron 内置 Node 跑指定的 bin.js
DSH_EXE=/path/to/dsh pnpm dev          # 直接执行外部 dsh 可执行文件
```

## 桌面应用打包

```sh
pnpm dist:mac          # macOS：dmg + zip，同时产出 x64 与 arm64 两个架构的包
pnpm dist:mac:x64      # 只打 x64 半边（用本机 bundle 的 dsh-x64）
pnpm dist:mac:arm64    # 只打 arm64 半边（需 resources/dsh-arm64，先在 arm 机器上 bundle 后拷入）
pnpm dist:win          # Windows：nsis 安装包 + zip
pnpm dist:linux        # Linux：AppImage + deb
pnpm dist:dir          # 快速验证：仅产出未打包的 .app，不生成 dmg/zip
```

`electron-builder.yml` 通过 `extraResources` 把 `resources/dsh-standalone` 复制到打包产物的 `Resources/dsh-standalone`；打包后的应用与开发模式一样，拉起该目录里的 `dsh` CLI 启动 `dsh web`，不依赖系统 Node。

macOS 双架构：payload（`resources/dsh-<arch>`，`pnpm run bundle` 的产物）是**架构绑定**的——bundle 阶段 pnpm 只链接安装机器架构的原生分包（koffi、sharp、node-addon-require-builtin），所以哪套架构的 payload 就必须在哪套架构的机器上 bundle。组装环节（standalone + electron-builder）是架构无关的，可以在任意机器执行。因此：

1. 在 **arm64 Mac** 上：`pnpm run bundle` → 产出 `resources/dsh-arm64`（内含 arm64 原生插件）
2. 把 `resources/dsh-arm64` 目录（打包成 zip 传输即可）拷到 **x86 Mac** 的同一路径
3. 在 **x86 Mac** 上执行 `pnpm run dist:mac`：`standalone:x64` 用本机 bundle 的 `dsh-x64`，`standalone:arm64` 用拷来的 `dsh-arm64`（各下载对应架构官方 Node，归档缓存在 `resources/.node-cache/`），随后分别 `electron-builder --mac --x64` 与 `--mac --arm64` 出包

产物名带 `${arch}`（如 `DeepSeek Harness Desktop-0.1.0-arm64.dmg`）以免两架构互相覆盖。若 `resources/dsh-arm64` 缺失，`standalone:arm64` 会报错并提示先在 arm 机器上 bundle。

> Electron 分发的 zip 由 electron-builder 从 npmmirror 下载（见 `electron-builder.yml` 的 `electronDownload.mirror`；github.com 官方源在部分受限网络环境下连接不稳定）。归档缓存于 `~/Library/Caches/electron/`，已缓存的架构直接复用，不会再次发起网络请求。

> Windows 目标建议在 Windows 机器或 CI 上执行 `pnpm dist:win`；在 macOS 上构建 Windows 目标需要安装 Wine（NSIS 打包和 exe 图标/版本写入依赖它）。

## 独立 CLI 分发（`pnpm dist:standalone`）

不依赖 Electron 的 `dsh` 命令行分发：把官方 Node 运行时和 `resources/dsh-<arch>`（`pnpm run bundle` 的产物）装进同一个目录，`dsh` 开箱即用、不需要系统装 Node。

```sh
pnpm dist:standalone   # 组装 resources/dsh-standalone/（宿主架构），并产出 release/dsh-standalone-<平台>-<架构>.zip
pnpm run standalone -- --arch arm64   # 或指定目标架构（x64|arm64），使用 resources/dsh-arm64
```

产物结构：

```
resources/dsh-standalone/
  node/     官方 Node 24.x 运行时，仅保留 node 本体（Windows 为 node.exe；npm/npx/corepack、头文件、文档已移除——dsh 运行时不调用 npm）
  runtime/  resources/dsh-<arch> 的副本（deployed dsh 运行时）
  dsh       POSIX 启动器（macOS/Linux 用）
  dsh.cmd   Windows 启动器
```

这一份目录同时是 Electron 桌面应用内嵌并拉起的运行时（`extraResources` 复制为 `Resources/dsh-standalone`）——两种分发共享同一份 payload，只是执行方式不同：桌面应用把它作为子进程拉起，独立 CLI 由用户直接在终端运行。payload 的原生依赖（node-pty、koffi）是 N-API，ABI 跨 Node 版本稳定。

> 说明：
> - payload 是架构绑定的：`pnpm run bundle` 只链接安装机器架构的原生分包，因此 `--arch <arch>` 组装时需要机器上有对应架构的 `resources/dsh-<arch>`（目标架构的 payload 在目标架构的机器上 bundle 后拷过来）。OS 同样与宿主绑定（darwin/win32/linux），跨 OS 构建请在目标 OS 执行。
> - Node 版本默认取镜像上的最新 v24.x（满足 dsh engines `^22.19.0 || >=24.0.0`），回退到 v24.18.1；可用 `DSH_NODE_VERSION=24.x.y` 固定，镜像默认 npmmirror，可用 `NODE_MIRROR` 覆盖。下载的 Node 归档缓存在 `resources/.node-cache/`。

## 运行行为

- 主进程先占一个空闲的 `127.0.0.1` 端口，再以 `web --host 127.0.0.1 --port <port>` 启动子进程。
- 子进程 stdout 出现 `dsh web: http://…` 后主进程才创建窗口加载该地址；60 秒超时或子进程提前退出会显示本地错误页。
- 退出时向子进程发送 `SIGTERM`，5 秒后未退出则 `SIGKILL`。
- 子进程的配置、凭据沿用 `dsh` 的环境变量与 `$DSH_HOME`（未设置时使用 dsh 默认主目录）。
