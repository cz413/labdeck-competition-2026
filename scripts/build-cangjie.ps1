param([string]$SdkRoot = (Join-Path $PSScriptRoot '..\artifacts\cangjie-sdk\cangjie'))
$ErrorActionPreference = 'Stop'
$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSdkRoot = [IO.Path]::GetFullPath($SdkRoot)
if (!(Test-Path -LiteralPath (Join-Path $taskSdkRoot 'envsetup.ps1'))) { throw '请传入仓颉 1.0.5 Windows SDK 目录：-SdkRoot <path>' }
. (Join-Path $taskSdkRoot 'envsetup.ps1')
$taskCompiler = Join-Path $taskSdkRoot 'bin\cjc.exe'
$taskVersion = & $taskCompiler --version
if ($LASTEXITCODE -ne 0 -or ($taskVersion -join ' ') -notmatch '1\.0\.5\b') { throw '当前兼容回移严格匹配官方 SDK 1.0.5，不混用其他版本 EXE/DLL' }
$taskStage = Join-Path $taskProjectRoot ('.tmp-build\cangjie-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
$env:TMP = $taskStage
$env:TEMP = $taskStage
Push-Location $taskStage
try {
    & $taskCompiler (Join-Path $taskProjectRoot 'cangjie\parameter-engine\main.cj') -o (Join-Path $taskStage 'parameter-engine.exe')
    if ($LASTEXITCODE -ne 0) { throw '仓颉编译失败，未替换现有组件' }
} finally { Pop-Location }
Copy-Item -Path (Join-Path $taskSdkRoot 'runtime\lib\windows_x86_64_cjnative\*.dll') -Destination $taskStage
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'LICENSE') -Destination (Join-Path $taskStage 'CANGJIE-LICENSE')
Copy-Item -LiteralPath (Join-Path $taskSdkRoot 'Open_Source_Software_Notice.docx') -Destination $taskStage
$taskManifest = & node (Join-Path $PSScriptRoot 'patch-cangjie-runtime.cjs') (Join-Path $taskStage 'libcangjie-runtime.dll')
if ($LASTEXITCODE -ne 0) { throw '运行时兼容回移失败，未替换现有组件' }
$taskManifest -join "`n" | Set-Content -LiteralPath (Join-Path $taskStage 'windows-loader-backport.json') -Encoding utf8
& node (Join-Path $PSScriptRoot 'verify-cangjie-native.cjs') $taskStage
if ($LASTEXITCODE -ne 0) { throw '原生自检失败，未替换现有组件' }
$taskOutput = Join-Path $taskProjectRoot 'resources\cangjie'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
Get-ChildItem -LiteralPath $taskStage -File | Where-Object { $_.Extension -ne '.cjo' } | Copy-Item -Destination $taskOutput -Force
Write-Output '仓颉 1.0.5 参数引擎已生成；本地未签名的 Windows loader 兼容回移和原生自检均通过'
