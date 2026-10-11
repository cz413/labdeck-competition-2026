param([string]$SdkRoot = (Join-Path $PSScriptRoot '..\artifacts\cangjie-sdk\cangjie'))
$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSdkRoot = [IO.Path]::GetFullPath($SdkRoot)
if (!(Test-Path -LiteralPath (Join-Path $taskSdkRoot 'envsetup.ps1'))) { throw '请传入仓颉 1.0.5 Windows SDK 目录：-SdkRoot <path>' }
$taskOutput = Join-Path $taskProjectRoot 'resources\cangjie'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
. (Join-Path $taskSdkRoot 'envsetup.ps1')
& (Join-Path $taskSdkRoot 'bin\cjc.exe') (Join-Path $taskProjectRoot 'cangjie\parameter-engine\main.cj') -o (Join-Path $taskOutput 'parameter-engine.exe')
if ($LASTEXITCODE -ne 0) { throw '仓颉编译失败' }
Copy-Item -Path (Join-Path $taskSdkRoot 'runtime\lib\windows_x86_64_cjnative\*.dll') -Destination $taskOutput
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'LICENSE') -Destination (Join-Path $taskOutput 'CANGJIE-LICENSE')
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'Open_Source_Software_Notice.docx') -Destination $taskOutput
Write-Output '仓颉参数引擎及运行时已生成'
