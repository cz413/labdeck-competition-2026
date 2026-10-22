# 2026-10-22 智能创建目录输入与视频素材

- 本次推送前 `npm test`：40 个测试文件、377 项通过，无跳过；包含真实仓颉原生引擎集成。
- 智能创建的项目、数据目录浏览弹窗增加可编辑路径栏；支持回车或按钮打开、主目录和上一级；读取失败保留输入，修改路径或读取失败时不能误选旧目录。
- `npm run build`：源码类型检查与构建通过，未打包。
- `verify-smart-create.cjs`：真实 Electron、preload/IPC、LangGraph，模拟 SSH/模型；目录输入规范化、回车跳转、按钮打开、目录点选、错误后返回主目录、数据路径同步命令，以及原有准备恢复/保存流程通过。目录读取调用 14 次，`startRun=0`。
- 深色及浅色紧凑窗口目录弹窗截图已人工检查。新增截图保存在隔离联调产物中，未提交临时数据目录。
- `docs/demo-video/` 保存 5 段动画、总长 53 秒的参考素材和约 6 分钟剪辑清单。6 张参考图、所有本地图片引用及连续时间线已校验；信息帧为 1920×1080，AI 场景原图保留原始尺寸。尚未生成最终动画视频。

---

# 2026-10-21 持久化实验准备与分析时间线

- `npm test`：40 个测试文件、377 项通过，无跳过。新增准备服务、时间线渲染与用量、任务创建标识重启/复制、真实文件与模型追踪测试。
- `npm run build`：main/preload/shared/renderer 类型检查及源码构建通过；未打包。
- `verify-smart-create.cjs`：真实 Electron、preload/IPC、LangGraph 与磁盘检查点，模拟模型/SSH。验证重启恢复手动名称、数据回答、评估入口、修改历史和时间线；恢复已完成方案不调用模型、不重新扫描；当前配置复检不调用模型；暂停后只重做未完成模型节点；完整配置往返、修改与撤销、保存同一草稿、资源弹窗交接及手动入口通过。测试中的 `startRun=0`。
- 准备服务单元测试还模拟了“任务已保存而图操作尚未成功”的中断，再次继续后任务数量仍为 1；检查并发创建去重、过期版本拒绝、跨服务器编辑拒绝、环境读取失败后可继续、反复编辑检查点数量不超过 8，以及配置变化后旧核对不再匹配。
- 实际仓库分析链的追踪测试验证读取 README 的真实行号、两次模型调用的用量回调及路径检查记录。时间线缺失 token 时显示“未提供”，不把部分记录冒充累计值。
- `verify-task-creation.cjs`：手动草稿、资源确认、排队快照隔离、任务内对照入口通过，`startRun=0`。
- `verify-task-diagnosis.cjs`：任务内指定运行分析、复用、重新分析、取消与确认修复、编辑配置和历史运行隔离通过。新增准备 IPC 已纳入该脚本的处理器隔离。
- 机器报告：`artifacts/smart-create-verification.json`、`artifacts/task-creation-verification.json`。追踪截图：`docs/screenshots/preparation-trace-dark.png`、`preparation-trace-light-compact.png`。
- 追踪仅保存在本地；没有接入 LangSmith 或外部遥测服务。本轮未连接真实模型、SSH 服务器或 GPU 训练，真实建议质量与远程环境仍需用户测试。

---

# 2026-10-21 合并任务内诊断重构

- 合入 `origin/codex/task-diagnosis-refactor`（`2a2719f`），保留本地智能创建、手动配置、任务内对照组及项目依据保存。
- 解决 `ExperimentTaskPool.tsx` 两处操作区冲突；真实任务的分析入口直接打开任务内诊断，不再依赖已撤下独立页面的回调。
- 诊断联调脚本改为等待当前任务页面，并同步移除重新注册的项目分析 IPC 处理器。手动创建夹具补全启动所需代码目录。
- `npm test`：38 个测试文件，363 项通过，无跳过。
- `npm run build`：main/preload/renderer 类型检查和源码构建通过，未打包。
- `node scripts/run-electron-check.cjs scripts/verify-task-diagnosis.cjs --no-sandbox`：真实 Electron、preload/IPC，模拟 SSH、无真实模型。覆盖指定运行自动分析、结果复用、显式重新分析、取消修复不创建运行、确认修复后创建并跟踪新运行、编辑配置、早期运行结果隔离及深浅主题布局。
- `node scripts/run-electron-check.cjs scripts/verify-smart-create.cjs --no-sandbox`：智能创建的项目/意图输入、进度、方案卡片、环境与数据补充、修改与撤销、完整配置往返、保存草稿和资源弹窗均通过；`startRun=0`。
- `node scripts/run-electron-check.cjs scripts/verify-task-creation.cjs --no-sandbox`：不完整手动草稿、已有草稿编辑、资源确认、排队任务快照隔离及任务内对照入口通过；`startRun=0`。
- 所有页面联调均使用隔离数据目录与模拟服务。用户实际任务、模型和服务器未参与这些检查。

---

# 2026-10-21 实验任务智能创建准备视图

- `npm run typecheck`：main / preload / shared 与 renderer 类型检查通过。
- `npm test`：37 个测试文件，355 项通过，无跳过。
- `npm run build`：源码生产构建通过；未执行打包命令。
- 新增 `src/shared/experiment-plan.test.ts`（18 项）：覆盖项目信号、相关文件默认范围、方案生成、训练/评估入口切换、来源标记、缺口集中追问、数据路径与命令同步、自然语言修改、环境选择、参数修改、验证流程缩减、手动字段保留与冲突。
- 新增 `src/renderer/src/components/SmartCreatePage.test.tsx`：首屏只包含项目位置与实验目的，不渲染任务名称、数据目录或完整配置。
- 新增 `vitest.config.ts`，让渲染层测试复用 `@shared` / `@renderer` 别名。
- `scripts/verify-smart-create.cjs` 与重写后的 `scripts/verify-task-creation.cjs` 覆盖新入口、方案卡片、缺口追问、增量修改与撤销、完整配置往返、保存草稿、资源弹窗、任务池返回和手动创建回归。本环境无法启动 Electron 主进程（`app.whenReady` 退出异常），本轮未执行这两个 Electron 联调；需在可启动 Electron 窗口的桌面环境运行 `npm run verify:smart-create` 与 `npm run verify:task-creation` 后补充结果。
- 使用 **headless Chrome 155 + CDP** 加载本地 Vite harness（隔离数据、模拟模型 / SSH）执行了从真实 `ExperimentTaskPool` 进入智能创建的界面联调：任务池入口、首屏只含项目与意图、一次点击完成检查/环境/分析、理解进度、四张方案卡片、数据缺口与命令同步、服务器环境选择、手动字段冲突选择、自然语言修改与撤销、评估入口切换（命令/标题/目标同步）、只读重新核对、完整配置（锁定分析服务器并返回方案，不创建任务）、保存草稿不启动、创建并选择资源复用草稿并打开既有 GPU 弹窗（`startRun=0`）、手动创建入口，全部通过；另以独立视图检查了浅色布局无横向溢出。报告：`artifacts/smart-create-pool-verification.json`、`artifacts/smart-create-browser-verification.json`；截图：`docs/screenshots/smart-create-start-dark.png`、`smart-create-progress-dark.png`、`smart-create-plan-dark.png`、`smart-create-plan-light.png`。该 harness 位于本地 `tmp/`（已忽略），不随仓库发布。
- 本轮未打包，未连接真实模型、SSH 服务器或 GPU 训练。真实模型对项目的理解质量仍需在实际仓库验证。

---

# 上一轮：实验任务内项目创建与对照入口调整

- `npm test`：35 个测试文件，336 项通过，无跳过。
- `npm run build`：Node/renderer TypeScript 检查和源码生产构建通过；未执行任何打包命令。
- `node scripts/run-electron-check.cjs scripts/verify-task-creation.cjs --no-sandbox`：真实 Electron、preload/IPC，模拟模型与 SSH。覆盖撤下独立导航、模型设置往返保留草稿、取消不重试、改源后忽略旧结果、建议应用到同一编辑器、路径显式同步、不完整草稿保存、更新现有草稿不重复建任务、保存后资源确认、完善排队任务生成新配置、任务内对照入口及深浅/紧凑布局。该脚本的 startRun 调用为 0。
- 任务创建报告：`artifacts/task-creation-verification.json`；截图在报告的 `testData` 目录。
- `node scripts/run-electron-check.cjs scripts/verify-research.cjs --no-sandbox`：迁入任务后的完整对照链路通过。真实 LangGraph 与仓颉参数引擎；模拟模型/SSH。覆盖取消确认不提交、确认后提交 4 项、检查点恢复、无重复提交、结果采集/比较、重新采集、下一批建议审查与演示隔离。报告 `artifacts/research-ui-verification.json`。
- 对照测试基准命令包含 `--seed 42`，与服务仅建议已声明参数的约束一致。
- 新增单元覆盖：项目依据随任务保存/重载、旧记录兼容、分析请求取消和关闭、重复请求 id、检查范围失效、绝对/相对代码目录、数据路径引号/空格/单引号与显式同步。
- 页面验证使用隔离数据目录，不操作用户的实际任务和服务器。尚需用户在源码目录中验证真实模型配置与实际远程项目。
- 旧独立页面联调脚本 `verify:intelligence`、`verify:workflow` 保留历史参考，本轮入口说明以 [任务创建流程](TASK-CREATION.md) 为准。

---

以下为此前轮次记录，其中发布包和旧界面验证结果不代表本轮重新打包或重测。

# 2026-10-21 仓颉兼容修复与智能实验优化验证

环境：Windows x64（10.0.26200）、Node.js 22。

- `npm test`：34 个测试文件，324 项全部通过，无跳过。包括真实仓颉桥接、运行时文件完整性、未知修改拒绝、模型请求预算/取消、勾选范围读取边界、问题自动回答和按目标选命令。
- `npm run build:cangjie`：官方 1.0.5 配套组件在项目暂存目录重编，应用固定哈希的本地未签名 Windows loader 兼容回移，脱离 SDK 自检通过后才复制到正式资源目录。
- `npm run verify:cangjie`：运行时校验、无 SDK 搜索路径的原生展开/去重/替换/预算/无效输入检查、实际桥接集成均通过。
- `npm run build`：类型检查和生产构建通过。构建临时文件使用 `.tmp-build`，清除继承的 Electron Node 模式。
- `npm run verify:repository -- --no-sandbox`：真实 Electron 页面、preload/IPC 与 LangGraph；模型和 SSH 使用夹具。验证取消（一次取消、无自动重试）、显式重试、两次补充复检不调用模型、数据目录不代答预处理要求、深浅/紧凑布局、只保存一份草稿且不启动运行。截图与机器报告在 `artifacts/repository-ui-verification.json`。
- `npm run dist:competition -- --publish never` 已生成本轮便携版；NSIS 安装包未重建。发布目录验证通过：包内 LangGraph 实际运行、无 SDK 的仓颉原生展开和预算拒绝通过；5 个构建文件与源码构建结果一致，运行时 DLL SHA256 与正式资源一致。
- 本轮未连接真实模型或实验服务器，未启动 GPU 训练；界面和本地测试不能替代真实模型质量或科研效果评测。

运行时回移方案、哈希与复现命令见 [CANGJIE-WINDOWS-FIX.md](CANGJIE-WINDOWS-FIX.md)。原先失败与跳过的记录保留在下方作为历史。

---
# 0.6.0 仓库启动体验优化验证

日期：2026-10-21；环境：Windows x64、Node.js 22.14.0。

- `npm run typecheck` 与 `npm run build` 通过。
- `npm test`：31 个测试文件，312 项通过、1 项原生仓颉集成因启动自检失败跳过。
- 覆盖仓库侦察 agent（种子读取、按需工具调用、最后一轮不再执行工具）、README 引用补读、README 命令回退、预填数据/环境自动回答、仓库候选解析、强制保存草稿的命令与占位符校验。
- 本轮未重新运行 Electron 页面联调，未连接真实模型、SSH 服务器或 GPU 训练；仓库侦察的模型质量、真实仓库路径与启动效果仍需在实际环境验证。

---

# 0.6.0 结构化结果采集验证

日期：2026-10-15；环境：Windows x64、Node.js 22.14.0。

- 类型检查和生产构建通过。新增结果采集配置、指标口径、文件元信息、进程 / 证据状态、只读重新采集及 JSON 导出，旧检查点兼容日志模式。
- Vitest：26 个文件，247 项通过、1 项原生仓颉集成跳过。覆盖文件缺失、日志失败但指标与退出码独立采集、无效 JSON、非有限数、错误 runId、单位 / 数据集 / split / epoch 差异、读取上限、变更状态、归属待核对、旧文件时间、产物缺失、导出字段、磁盘恢复、暂停及重新采集不增加任务 / 模型调用。
- 本地 Python 实际执行固定只读程序，验证普通文件、Unicode / 引号路径、目录、缺失文件、128 KiB 上限，确认二进制产物内容未被读取或修改。
- `verify:research` 通过：真实 Electron、preload/IPC、LangGraph 检查点与恢复；模型和 SSH 使用夹具。检查指定 JSON 覆盖冲突日志、口径展示、产物缺口、重新采集不启动任务 / 模型 / 修复、下一批重新审查、演示隔离和深浅主题 / 紧凑布局。参数引擎在本机明确为 TypeScript 回退，验证报告的 realCangjie 为 false。
- `verify:workflow` 通过：原有准确运行导航、报告关联、计划保存新任务、演示成功 / 失败与取消、零真实写入及重启清除。
- 结果与证据页面截图已复核；指标未提升和产物缺失不会自动触发运行故障修复。

## 尚未通过的原生检查

原有仓颉 1.0.5 引擎在当前机器初始化时退出码为 3221225477。用 1.0.5 与另行下载、校验 SHA256 的官方 1.1.0 SDK 分别编译最小程序，也复现启动崩溃。当前未确定最终环境根因，未修改或替换仓库中的原生运行组件。

新增启动自检，缺失或自检失败时明确使用 TypeScript 引擎并记录原因。普通测试显式跳过不可用的真实原生专项，不能据此声称仓颉执行成功。`npm run verify:cangjie` 严格检查原生，在本机返回 1；发布包的实际原生验证仍需在兼容环境完成。

本次未重新打包安装程序、未连接真实模型或 GPU 训练服务器。结果采集功能的界面联调与模拟训练不能替代真实训练、模型分析质量或仓颉执行效果的验证。

---
# 0.5.0 仓库交付检查

日期：2026-10-11；环境：Windows x64、Node.js 22.14.0。

- `npm run build` 通过，包含主进程 / preload / 渲染页面的 TypeScript 类型检查和生产构建。
- `npm test` 通过：24 个测试文件、217 项测试，包括实际执行仓颉二进制的参数展开测试，以及 LangGraph 检查点恢复、部分入队去重、失败关联和指标不提升的处理。
- 本次上传保留 Windows 仓颉 EXE / DLL、许可和第三方声明；排除 SDK、依赖目录、构建输出、安装包、运行数据与临时报告。
- README 和贡献指南中的本地文件链接核对通过；新增团队克隆安装、模块入口、命令顺序、模型设置和仓颉编译说明。
- 上传文本的常见密钥 / 令牌模式扫描仅匹配两个测试中的虚构凭据 URL，未发现这些模式对应的真实凭据。此检查不能证明所有形式的敏感信息均不存在，新增日志和截图仍需人工检查。

本次检查复用已有依赖目录，未重新安装完整依赖；未重新运行此前的 Electron UI 联调或真实服务器训练。`npm ci` 是新成员按锁文件安装依赖的步骤。真实模型质量和科研指标仍须实际环境验证；离线演示与模拟测试不能作为真实实验效果证明。

---
# 0.4.0 验证记录

日期：2026-10-10。

- TypeScript 类型检查与生产构建通过，20 个测试文件、198 项测试通过。
- 本次新增准确运行关联和演示回归：不会把其他任务或运行的报告混用；原运行配置保留、重复操作不会增加运行、仅启动后可模拟验收；失败链路生成归属修复运行的新规则诊断，后续修复不自动启动。
- 真实 Electron 页面、preload/IPC 与诊断服务联动通过：归档任务的指定运行定位、任务到诊断不自动采集、报告返回正确原运行、任务上下文生成计划、计划保存为新任务后返回任务栏。SSH 和计划回复使用测试夹具。
- 离线演示成功/失败、取消修复确认、禁用模型、排除临时节点进入真实计划、修复运行往返、失败新诊断、重置和退出、重启清除通过。整个演示期间对真实诊断/修复/验收/跟踪/计划/任务写入与模拟 SSH 的调用增量为 0，真实任务和诊断历史保持一致。
- 原有智能实验 UI 联调及自动闭环 UI 联调通过。模型传输使用本机模拟 HTTP，闭环使用模拟 SSH，不代表真实模型或训练服务器的效果验证。
- 深浅主题截图复核通过，1280×840 窗口无页面横向溢出；演示控制条在长日志和运行记录滚动时保持可用。
- 原项目 61 个源码文件 SHA-256 与基线一致，独立依赖、应用数据、远程运行目录保持隔离，详见 isolation-verification.json。
- 可执行程序构建一致性与 SHA-256 见 release/package-verification.json 和 release/SHA256SUMS.txt。

新增联动记录：artifacts/workflow-ui-verification.json。截图：docs/screenshots/workflow-demo-success-dark.png、workflow-demo-success-light.png、workflow-demo-failure-task.png、workflow-demo-compact.png。

本版仍需真实模型与训练服务器完成实际失败→修复→退出码验收。模拟计划与运行不能充当真实效果证明；当前实际闭环只自动验收进程，实验指标和产物质量未自动验收。

---

# 0.3.0 验证记录

日期：2026-10-09。

- TypeScript 类型检查与生产构建通过。
- 18 个测试文件、191 项测试通过，包括既有项目回归、规则与模型传输、多轮诊断、工具范围、修复闭环与运行生命周期。
- 闭环测试覆盖：等待 / 运行时不重复读取远程退出码；退出码 0 才通过；非零退出生成下一份诊断；缺证据退避且最多三次；取消 / 暂停 / 记录丢失不声称通过；手动与自动检查互斥；暂停期间迟到结果不能覆盖状态；应用重启和运行关联恢复、最终核验中断后不突破次数上限；活跃报告不会被历史上限提前删除。
- 真实 Electron 界面、preload 和 IPC 联调通过：显式确认修复、自动等待 / 运行、暂停与恢复、退出码 0 验收、失败与下一份诊断入口、重启后继续跟踪、深浅主题和横向布局。闭环使用模拟 SSH，未连接训练服务器。
- 原有真实 Electron 智能实验联调通过：规则证据定位、模型 HTTP、多轮工具调用、任务计划、进度与取消。模型使用本机模拟 HTTP 服务，不代表真实模型质量评估。
- 原项目 61 个源码文件 SHA-256 基线对比无变化；结果在 isolation-verification.json。
- 独立 node_modules 完整副本，应用数据与远程运行目录继续和原版隔离。
- 可执行程序内部构建一致性及 SHA-256 见 release/package-verification.json / SHA256SUMS.txt。

闭环联调记录：artifacts/closure-ui-verification.json。
截图：docs/screenshots/closure-overview-dark.png、closure-overview-light.png、closure-passed.png、closure-waiting.png。

尚需真实模型、实际训练服务器验证失败 → 修复 → 正常退出。当前实现的是进程验收闭环；实验指标和产物质量未自动验收。
