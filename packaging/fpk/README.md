# 飞牛 fnOS 应用打包（.fpk）

把家账簿打包为飞牛 fnOS 应用中心的 `.fpk` 安装包（**原生应用**，非 Docker：内置 Node.js 运行时，无需注册表/镜像仓库）。

## 前置条件

| 依赖 | 说明 |
|---|---|
| fnpack | 官方打包工具，[下载](https://developer.fnnas.com/docs/cli/fnpack/)。Linux x86: `fnpack-1.2.3-linux-amd64`，Windows: `fnpack-1.2.3-windows-amd64`，下载后 `chmod +x` 或用 `FNPACK_BIN` 指定路径 |
| bash / curl / tar / node | 打包机需要（在 NAS 或 WSL/Git Bash 里跑均可） |

## 打包

```bash
cd packaging/fpk
bash build-fpk.sh          # 版本号默认取 package.json
bash build-fpk.sh 1.0.1    # 或显式指定（飞牛要求 X.Y.Z 格式）
```

产物：`dist/homeledger-<版本>.fpk`

脚本流程：生成 fnpack 项目骨架 → 下载 Node v22 linux-x64 官方运行时 → 复制源码与 node_modules（纯 JS，零原生依赖）→ 写入 manifest/privilege/resource/ui 配置 → `fnpack build`。

## 安装到飞牛

1. `.fpk` 上传到 NAS 任意目录
2. 飞牛桌面 → **应用中心** → 右上角 **设置** → **手动安装应用** → 选择 `.fpk`
3. 桌面出现「家账簿」图标，浏览器打开，端口 **5111**

## 包内结构

```
manifest              应用元数据（appname=homeledger, service_port=5111, platform=x86）
app.tgz
  homeledger/         源码 + node_modules（Express/EJS，纯 JS）
  runtime/node        Node.js v22 官方 linux-x64 运行时（node:sqlite 需 ≥22.5）
  ui/config           桌面入口（http://<NAS>:5111）
  ui/images/          桌面图标
cmd/main              生命周期：start/stop/status（PID + 日志写入 TRIM_PKGVAR）
config/privilege      以 package 专用用户运行（非 root）
config/resource       data-share 声明（数据目录由飞牛托管）
ICON.PNG / ICON_256   应用图标
wizard/               安装向导（空）
```

## 数据与升级

- 数据目录：`${TRIM_PKGVAR}/data`（SQLite + 截图附件），飞牛托管
- **覆盖安装升级不丢数据**；卸载应用才会清除
- 备份：在 NAS 上直接拷贝该目录，或用应用内「系统管理 → 备份」

## 已知限制

- 仅 x86_64（飞牛第三方应用当前只支持 x86 平台）
- `checkport=true`：安装时若 5111 被占用会提示，需先释放端口
- AI 截图识别需在应用内配置模型服务（见 README「配置 AI 识别」）
