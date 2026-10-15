# 结构化实验结果采集

在「智能实验 → 对照实验」生成新批次前，可以填写「结构化指标文件」和「预期产物路径」。配置随该批方案保存，审查确认时展示，不会自动修改训练脚本。

## 配置路径

- 指标文件留空：继续采集日志末尾 240 行 / 64 KiB 中的最后匹配指标，并明确标为日志末值。
- 指定指标文件：读取该文件；缺失、无权限、格式错误时展示证据问题，不会把日志指标充当该文件结果。
- 预期产物：每行一项，最多 8 项。可以是文件或目录；只检查存在、类型、文件大小、修改时间和实际路径，不读取 checkpoint 内容，也不递归计算目录总大小。
- 路径支持远程绝对路径、相对本次运行代码目录的路径、`{runDir}` 和 `{runId}` 占位符。拒绝控制字符、父目录跳转和未知占位符。
- 推荐指标文件为 `{runDir}/metrics.json`，产物例如 `{runDir}/model.pt`。使用固定共享路径时提示覆盖风险。

调度器已经向训练进程导出 `LABDECK_RUN_ID`、`LABDECK_RUN_DIR`、`LABDECK_LOG_FILE`、`LABDECK_DATA_PATH` 和 `LABDECK_ARTIFACT_PATH`。训练脚本自行使用这些变量输出每次运行的结果；应用不会替脚本指定新的模型保存位置。

## 推荐的 metrics.json 协议

```json
{
  "schemaVersion": 1,
  "runId": "与 LABDECK_RUN_ID 相同的运行编号",
  "dataset": "vision-validation-v1",
  "epoch": 12,
  "metrics": [
    {
      "name": "accuracy",
      "value": 0.72,
      "split": "validation",
      "unit": "ratio",
      "direction": "maximize"
    },
    {
      "name": "loss",
      "value": 1.14,
      "split": "validation",
      "unit": "dimensionless",
      "direction": "minimize"
    }
  ]
}
```

`metrics` 支持数组、数字映射或带元信息的映射；也支持简单的 `{"accuracy":0.72,"loss":1.14}`。简单格式中没有声明的数据集、阶段、单位、epoch、step 和方向会显示为未知，不自动推断。

每份文件支持 1～40 个有限数值指标，文件上限为 128 KiB，UTF-8 编码。`schemaVersion` 如填写必须为 1。`direction` 如填写只能为 `minimize`、`maximize` 或 `observe`，不设达标阈值。指标名称支持字母开头及字母、数字、`_ . / % -`；字符串数值、NaN/Infinity、重复口径和未知协议字段会被拒绝。文件级元信息可以由单项指标覆盖。

下面是训练脚本末尾自行写入结果的例子，数值仅用于展示协议：

```python
import json
import os
from pathlib import Path

run_dir = Path(os.environ["LABDECK_RUN_DIR"])
result = {
    "schemaVersion": 1,
    "runId": os.environ["LABDECK_RUN_ID"],
    "dataset": "vision-validation-v1",
    "split": "validation",
    "epoch": 12,
    "metrics": {
        "accuracy": {"value": 0.72, "unit": "ratio", "direction": "maximize"},
        "loss": {"value": 1.14, "unit": "dimensionless", "direction": "minimize"}
    }
}
temporary = run_dir / "metrics.json.tmp"
temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
os.replace(temporary, run_dir / "metrics.json")
```

## 如何理解结果

页面将三个维度分开：

1. **进程状态**：远程退出码与任务记录一致才显示已核对正常结束；非零退出码显示运行故障，缺少退出码或状态冲突显示待确认；取消运行不作科研比较。
2. **结果证据**：展示指标及指定产物是否已取得、是否属于本次运行。缺少指标、指定产物缺失或文件归属未核对时，显示部分证据或尚无结果证据。
3. **研究观察**：记录实际指标及口径。低 accuracy、高 loss 或假设未成立不等于运行故障，不自动触发修复。

同名指标如果来源、数据集、阶段、单位、epoch、step 或优化方向不同，会分列展示。元信息缺失时不能据此认定口径一致。规则分析只并列记录相同声明口径的值域，不做自动优劣判定或多 seed 统计。

文件中的 `runId` 若与当前运行不一致，指标不会被采用。没有 runId 的文件，位于本次独立运行目录时可以按目录关联；其他位置显示归属待核对。修改时间早于运行开始时间时提示可能是旧文件或服务器时钟偏差，不作为已核对归属的结果。文件自报 runId 和目录关联并非密码学溯源，仍需正确配置训练脚本。

## 补齐证据与导出

本批结束后，点击「重新采集结果」重新读取日志、退出码、指标文件和产物元信息。此操作不创建任务、不启动新运行、不自动修复，也不调用模型；结果先更新为规则观察。需要模型重新解释时，再使用「补充分析」，沿用每批最多两次的预算。

JSON 导出包含采集配置、指标元信息、来源路径、文件状态、采集时间、进程和证据状态以及研究时间线。不会导出 checkpoint 内容或原始指标文件中的未知字段。旧版检查点没有采集配置时继续使用日志模式，旧记录仍可查看和重新采集。

## 实现与测试边界

文件读取是固定只读 Python 程序，通过 SSH 调用系统 `python3` 或 `python`，需要 Python 3；路径作为 JSON 数据参数传入。指标只读取普通文件，拒绝直接符号链接和特殊文件；使用有限读取并核对读取期间的变化。祖先目录的符号链接可能影响实际路径，页面展示解析后的路径及运行归属。产物只做元信息检查。

源代码入口：`src/shared/research-results.ts`、`src/main/result-collector.ts`、`src/main/research-service.ts` 和 `src/renderer/src/components/ResearchResults.tsx`。本地 Python 可用时，采集器测试会执行实际只读程序；没有本地 Python 时这一个可选测试跳过，其他协议与 SSH 夹具测试仍可执行。

已有自建实验执行 Harness 提供输入校验、人工确认、工具与执行预算、去重、检查点恢复及证据边界；LangGraph 编排节点。当前没有专门的真实模型评测 Harness，不包含故障案例集上的诊断准确率、工具选择质量或模型成本对比。