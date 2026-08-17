# dsh-electron

DeepSeek Harness 桌面壳。它把 `deepseek-harness` 的 `dsh web` 运行时作为**子进程**启动，再把子进程提供的 Web UI 加载进 Electron 窗口。**两个仓库完全解耦**：`deepseek-harness` 只需手动执行 `npm run build`；本仓库的 `scripts/export-dsh.mjs` 只**读取**其构建产物、生成不含源码的产物快照（`vendor/dsh-runtime/`），之后的一切（物化、裁剪、Electron 打包）都在本仓库完成——`deepseek-harness` 零改动。

## 结构

```
src/main/index.ts       主进程：拉起 dsh web 子进程、等待就绪、管理窗口与子进程生命周期
src/renderer/           本地引导页：仅在子进程启动失败时显示错误
scripts/export-dsh.mjs  只读读取 deepseek-harness 构建产物 → 生成源码无关快照 vendor/dsh-runtime/
scripts/bundle-dsh.mjs  从产物快照物化 dsh 运行时并原地产出扁平裁剪版：vendor/dsh-runtime → resources/dsh-<arch>
scripts/prepare-runtime.mjs  填充 extraResources 包装目录：resources/dsh-<arch> → resources/dsh-standalone/runtime
bundle/                 生成的 deploy workspace（清单 + lockfile，由 bundle 脚本重建）
electron-builder.yml    桌面应用打包配置
```

## 前置条件

- Node 22.19+（或 24+）、pnpm
- `deepseek-harness` 检出（默认同父目录下的 `../deepseek-harness`，可用 `--root` / `DSH_ROOT` 指向其他位置），已手动执行过 `npm run build`

## 命令一览

| 命令 | 作用 | 产物 |
|---|---|---|
| `pnpm dev` | 开发模式：拉起 `dsh web` 子进程并打开 Electron 窗口（需先 `bundle` + `prepare:runtime`，见下） | — |
| `pnpm build` | 编译主进程与渲染进程 | `out/` |
| `pnpm start` | 预览已编译产物（`electron-vite preview`） | — |
| `pnpm typecheck` | 主进程 + 渲染进程 TypeScript 类型检查 | — |
| `pnpm run export` | 只读读取 deepseek-harness 构建产物 → 生成源码无关快照 | `vendor/dsh-runtime/` |
| `pnpm run bundle` | `export` + `deploy`：导出产物快照，物化并原位扁平裁剪 dsh 运行时 | `resources/dsh-<arch>` |
| `pnpm run deploy` | 仅从已有快照物化 + 原位扁平裁剪（跳过导出） | `resources/dsh-<arch>` |
| `pnpm run prepare:runtime` | 把 `resources/dsh-<arch>`（宿主架构）复制进 extraResources 包装目录 | `resources/dsh-standalone/runtime/` |
| `pnpm run prepare:runtime -- --arch <x64\|arm64>` | 按指定架构填充（需机器上有对应架构的 `resources/dsh-<arch>`） | 同上（指定架构） |
| `pnpm dist:dir` | 快速验证：`bundle` + `prepare:runtime` 后仅产出未打包的应用目录，不打 dmg/zip | `release/` 下未打包应用 |
| `pnpm dist:mac` | macOS：dmg + zip，x64 与 arm64 双架构 | `release/*.dmg`、`*.zip` |
| `pnpm dist:mac:x64` | 只打 macOS x64 半边（本机 bundle + `prepare:runtime --arch x64`） | 同上（仅 x64） |
| `pnpm dist:mac:arm64` | 只打 macOS arm64 半边（需 `resources/dsh-arm64`，先在 arm 机器上 bundle 后拷入） | 同上（仅 arm64） |
| `pnpm dist:win` | Windows：NSIS 安装包 + 免安装 zip（`bundle` + `prepare:runtime`，建议在 Windows 机器/CI 执行） | `release/*.exe`、`*-win.zip` |
| `pnpm dist:linux` | Linux：AppImage + deb（`bundle` + `prepare:runtime`） | `release/*.AppImage`、`*.deb` |

## 第一步：构建 deepseek-harness（在该仓库里，手动）

`deepseek-harness` 的构建在它自己的仓库完成，本仓库不参与：

```sh
cd ../deepseek-harness
npm run build            # 构建 CLI + Web 前端（产出各包 lib/、apps/web/dist/）
```

## 第二步：导出产物快照（`pnpm run export`）

`scripts/export-dsh.mjs` 只**读取**上面构建出的产物，在 `vendor/dsh-runtime/` 生成一份**不含源码**的快照：

```sh
cd ../dsh-electron
pnpm run export          # 默认读取 ../deepseek-harness，可用 --root / DSH_ROOT 指定
```

拷贝的内容（`vendor/dsh-runtime/`）：

- 全部 workspace 包的 `package.json` + 构建产物（`lib/`、`dist/`、`config/`、`cordis.patch.yml` 等，按各包 `files` 字段挑选）；
- `pnpm-workspace.yaml` + `pnpm-lock.yaml`（解析依赖闭包用）。

**不含**任何源码（无 `src/`、`tests/`、`scripts/`、`*.ts`、`node_modules`），`deepseek-harness` 的 git 状态保持干净。快照约 51MB，可打成 zip 传输到另一台机器——那边无需 harness 检出，直接 `pnpm run bundle` 从快照物化即可。

## 生成自包含运行时（`pnpm run bundle`）

```sh
pnpm install
pnpm run bundle          # = pnpm run export && pnpm run deploy
```

`pnpm run bundle` 依次完成：

1. `scripts/export-dsh.mjs`：从 `deepseek-harness` 检出导出产物快照（只读，见上）。
2. `scripts/bundle-dsh.mjs`：读取 `vendor/dsh-runtime` 的 workspace 清单，计算 `dsh web` 配置的运行时闭包。
3. 在本地 `bundle/` workspace 生成纯依赖清单（manifest），从 registry 解析第三方依赖。
4. 用 `pnpm deploy` 把 CLI、依赖闭包和前端物化到 `resources/dsh-<arch>`（arch = 安装机器架构）。
5. 校验物化结果：deployed 的 `@deepseek-ai/*` 首包集合必须等于 web-profile 闭包——多出（例如经 registry 解析进依赖图、但快照 workspace 未声明的首包）直接报错，防止运行时悄悄膨胀；缺失的（平台过滤的可选包属于正常）给出警告。
6. 就地准备打包：把 `node_modules` 从 pnpm 虚拟存储布局（`.pnpm` 存储 + 顶层符号链接）拍平为无链接树（否则 electron-builder 会解引用符号链接、把同一份包重复打进安装包），并按目标平台/架构剥离 `.d.ts`/`.map`/`.md`/`.pdb`、测试目录与多余的原生预编译变体（如 node-pty `prebuilds/{darwin,linux,win32}-*` 只保留目标一套，约 17k 个小文件）。`resources/dsh-<arch>` 至此就是可直接打包的运行时。

`bundle/` 属于本仓库，可随时删除重建；`vendor/dsh-runtime` 是产物快照，已被 gitignore。

> 说明：物化时跳过原生依赖的构建脚本（`ignore-scripts`），依赖自带预编译产物（node-pty、koffi 等为 N-API，ABI 跨 Node 版本稳定），因此同一份 payload 既能跑在 Electron 内置的 Node 24 上（打包后的应用、`pnpm dev` 都走这条路径），也能用系统 Node 22.19+/24+ 直接运行（`DSH_BIN` 指向其 `lib/bin.js` 即可）。`dsh web` 的 Web 界面与主流程不依赖这些原生模块即可启动。

## 开发模式

```sh
pnpm run bundle && pnpm run prepare:runtime
pnpm dev
```

主进程默认拉起 `resources/dsh-standalone/runtime` 里的 deployed 运行时（`pnpm run prepare:runtime` 的产物，与打包后的应用同一份），用 Electron 内置 Node 24 以 `web --host 127.0.0.1 --port <port>` 启动其 `node_modules/@deepseek-ai/dsh/lib/bin.js`，并带 `--expose-internals` 标志——`dsh` 的插件加载器只有在存在该标志时才回退到 Node 内部 ESM 加载器，因此该标志是必需的。

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

`electron-builder.yml` 通过 `extraResources` 把 `resources/dsh-standalone`（`pnpm run prepare:runtime` 填充的包装目录）复制到打包产物的 `Resources/dsh-standalone`；打包后的应用与开发模式一样，用 Electron 内置 Node 拉起该目录 `runtime/` 里的 `lib/bin.js` 启动 `dsh web`，不依赖系统 Node。

macOS 双架构：payload（`resources/dsh-<arch>`，`pnpm run bundle` 的产物）是**架构绑定**的——bundle 阶段 pnpm 只链接安装机器架构的原生分包（koffi、sharp、node-addon-require-builtin），所以哪套架构的 payload 就必须在哪套架构的机器上 bundle。填充包装目录（`prepare:runtime`）与 electron-builder 出包是架构无关的，可以在任意机器执行。因此：

1. 在 **arm64 Mac** 上：`pnpm run bundle` → 产出 `resources/dsh-arm64`（内含 arm64 原生插件，已就地扁平裁剪）
2. 把 `resources/dsh-arm64` 目录（打包成 zip 传输即可）拷到 **x86 Mac** 的同一路径
3. 在 **x86 Mac** 上执行 `pnpm run dist:mac`：`bundle` 产出本机的 `dsh-x64`，`prepare:runtime --arch x64` 与 `prepare:runtime --arch arm64` 分别用本机 payload 与拷来的 `dsh-arm64` 填充包装目录，随后各自 `electron-builder --mac --x64` 与 `--mac --arm64` 出包

产物名带 `${arch}`（如 `DeepSeek Harness Desktop-0.1.0-arm64.dmg`）以免两架构互相覆盖。若 `resources/dsh-arm64` 缺失，`prepare:runtime --arch arm64` 会报错并提示先在 arm 机器上 bundle。

> Electron 分发的 zip 由 electron-builder 从 npmmirror 下载（见 `electron-builder.yml` 的 `electronDownload.mirror`；github.com 官方源在部分受限网络环境下连接不稳定）。归档缓存于 `~/Library/Caches/electron/`，已缓存的架构直接复用，不会再次发起网络请求。

> Windows 目标建议在 Windows 机器或 CI 上执行 `pnpm dist:win`；在 macOS 上构建 Windows 目标需要安装 Wine（NSIS 打包和 exe 图标/版本写入依赖它）。

## 运行行为

- 主进程先占一个空闲的 `127.0.0.1` 端口，再以 `web --host 127.0.0.1 --port <port>` 启动子进程。
- 子进程 stdout 出现 `dsh web: http://…` 后主进程才创建窗口加载该地址；60 秒超时或子进程提前退出会显示本地错误页。
- 退出时向子进程发送 `SIGTERM`，5 秒后未退出则 `SIGKILL`。
- 子进程的配置、凭据沿用 `dsh` 的环境变量与 `$DSH_HOME`（未设置时使用 dsh 默认主目录）。
