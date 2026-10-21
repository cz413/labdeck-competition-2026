# Windows 仓颉运行时兼容修复

日期：2026-10-21。SDK 保持官方 1.0.5 Windows x64，参数引擎源码保持在 `cangjie/parameter-engine/main.cj`。

新版 Windows 的 loader 节点布局使旧版运行时将 `UNICODE_STRING` 的长度头 `0x620026` 作为字符串指针读取，初始化时在 `WinModuleManager::ReadWinModuleAtInit()` → CRT 中触发 `0xC0000005`。本机在沙箱外、纯英文路径和最小环境中均复现；迁移路径、调整 CPU 并发或堆大小不能解决。

官方修复：[d28cbe02df27c53e278d69a26d9c326ba99bffc2](https://github.com/cangjielanguage/cangjie_runtime/commit/d28cbe02df27c53e278d69a26d9c326ba99bffc2)，关联 issue #920。该修复将启动模块读取委托给现有的 Win32 API 枚举方法，并将模块全路径改为模块基名以保持栈回溯的名称查找一致。

2026-10-21 发布的官方 `1.3.0-alpha.20261021001052` Windows SDK ZIP 已按官方 Scoop 清单校验 SHA256 `8091174eeebfc65c85fe4a747f65c3a9a4ffef4d93ff8be074bd933c0703c588`。其编译器能够启动，但编出的最小参数请求仍在同一旧 loader 代码中崩溃，因此没有将预发布 SDK 的组件替换进项目。

## 当前交付方式

`scripts/patch-cangjie-runtime.cjs` 对官方 1.0.5 的精确运行时做二进制兼容回移，等价实现上述两处变更：

- `ReadWinModuleAtInit` 的入口尾跳到已有的 `ReadWinModuleAtRunning`，保留相同的成员函数 ABI、调用栈与目标函数的栈展开信息。
- 在 `ReadModuleInfo` 中改用已生成的 `moduleName` 字符串，保留指令长度、栈布局及其余代码。
- 修改后移除不再适用的 Authenticode 证书目录，明确作为**本地修改、未签名运行时**交付。它不是华为官方签名的修复发行版；原有许可与第三方声明保留。

脚本锁定原始 SHA256、导出函数和指令原文；拒绝其他 SDK、未知修改或部分补丁，重复执行不会再次修改。文件标识记录在 `resources/cangjie/windows-loader-backport.json`。

| 组件 | SHA256 |
| --- | --- |
| 官方 1.0.5 原始运行时 | `14ff79293be6328393a0bee5d3d69b3023f3ba1bcac7cebda2dceb35b98cac6a` |
| 本地兼容回移运行时 | `d3da85227242256d6b484914742191bacccf3dd47269f6845164ce879943b8bf` |

## 复现与验证

普通使用无需 SDK，直接运行 `npm run verify:cangjie`。它先校验回移文件，再在没有 SDK 搜索路径的进程中实际执行参数展开、参数替换、去重、超预算拒绝和无效输入拒绝，最后运行真实 `ParameterBridge` 集成测试；任何失败均返回非零，不能以 TypeScript 回退通过。

修改仓颉源码时执行 `npm run build:cangjie`；非默认 SDK 路径使用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-cangjie.ps1 -SdkRoot <SDK目录>`。构建脚本检查 1.0.5 版本，在 `.tmp-build` 编译、复制配套 DLL、执行兼容回移和原生自检，通过后才复制到 `resources/cangjie`。原始 SDK 与系统 DLL 均不会被修改。

原始运行时备份在本机 `artifacts/cangjie-runtime-original`，不提交。恢复官方原版可以从同版本 SDK 复制原 DLL 并重新构建；新版 Windows 下原版仍可能复现启动失败。将来采用其他 SDK 时，应先确认官方发行包包含该修复，再整体重编并验证，不应套用本脚本处理其他版本。
