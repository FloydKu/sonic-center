# build-mtp.ps1
# Native AOT 编译 mtp-bridge
#
# 背景：.NET 8 ILC 的 findvcvarsall.bat 只接受 VS 16/17（-version [16,18)），
# 无法发现本机 VS 18 Insiders，导致 "Platform linker not found"。
# 本脚本手动注入 VC++ 工具链环境，并以 IlcUseEnvironmentalTools=true
# 跳过自动探测，直接使用 PATH 中的 link.exe。
# 未安装 VS 18 时（如 VS 2022 + “使用 C++ 的桌面开发”），ILC 可自动探测工具链，直接发布。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# --- 1. 定位 VS 安装（优先 Insiders，其次任意带 VC 工具的实例）---
$vsCandidates = @(
    'C:\Program Files\Microsoft Visual Studio\18\Insiders',
    'C:\Program Files\Microsoft Visual Studio\18\Community',
    'C:\Program Files\Microsoft Visual Studio\18\Professional',
    'C:\Program Files\Microsoft Visual Studio\18\Enterprise'
)
$vsBase = $vsCandidates | Where-Object { Test-Path "$_\VC\Tools\MSVC" } | Select-Object -First 1
if (-not $vsBase) {
    Write-Host '未找到 VS 18，交由 ILC 自动探测工具链（需 VS 2022 及 C++ 桌面开发工作负载）'
    dotnet publish mtp-bridge -c Release -r win-x64 -o resources/mtp-bridge
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败 (exit $LASTEXITCODE)" }
    Write-Host "`nmtp-bridge.exe 已生成: $root\resources\mtp-bridge\mtp-bridge.exe" -ForegroundColor Green
    exit 0
}
Write-Host "VS: $vsBase"

# --- 2. 取最新 MSVC 版本 ---
$msvcDir = Get-ChildItem "$vsBase\VC\Tools\MSVC" -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $msvcDir) { throw '未找到 MSVC 工具链' }
$msvc = $msvcDir.FullName
Write-Host "MSVC: $($msvcDir.Name)"

# --- 3. 取最新 Windows SDK 版本 ---
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
$sdkVer = (Get-ChildItem "$sdk\Lib" -Directory | Where-Object { Test-Path "$($_.FullName)\um\x64" } | Sort-Object Name -Descending | Select-Object -First 1).Name
if (-not $sdkVer) { throw '未找到 Windows SDK' }
Write-Host "SDK: $sdkVer"

# --- 4. 注入环境（等价于 vcvarsall.bat amd64 的关键部分）---
$env:PATH = "$msvc\bin\Hostx64\x64;" + $env:PATH
$env:LIB = "$msvc\lib\x64;$sdk\Lib\$sdkVer\ucrt\x64;$sdk\Lib\$sdkVer\um\x64"
$env:INCLUDE = "$msvc\include;$sdk\Include\$sdkVer\ucrt;$sdk\Include\$sdkVer\um;$sdk\Include\$sdkVer\shared;$sdk\Include\$sdkVer\winrt"

# --- 5. 发布 ---
dotnet publish mtp-bridge -c Release -r win-x64 -o resources/mtp-bridge -p:IlcUseEnvironmentalTools=true
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败 (exit $LASTEXITCODE)" }

Write-Host "`nmtp-bridge.exe 已生成: $root\resources\mtp-bridge\mtp-bridge.exe" -ForegroundColor Green
