param([ValidateSet('x64', 'arm64')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw 'Run this script in a Visual Studio 2022 developer shell configured for the requested target architecture.'
}
$TargetArchitecture = $env:VSCMD_ARG_TGT_ARCH
if ($TargetArchitecture -ne $Architecture) { throw "Developer shell target must be $Architecture." }
$OutputDirectory = Join-Path $PSScriptRoot "bin/win32-$Architecture"
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$Executable = Join-Path $OutputDirectory 'neuma-projects.exe'
$Object = Join-Path $OutputDirectory 'windows.obj'
& cl.exe /nologo /std:c++17 /EHsc /O2 /MT /DUNICODE /D_UNICODE /utf-8 (Join-Path $PSScriptRoot 'windows.cpp') "/Fo$Object" "/Fe$Executable" /link iphlpapi.lib ws2_32.lib ole32.lib uuid.lib
if ($LASTEXITCODE -ne 0) { throw 'Windows project helper compilation failed.' }
Remove-Item $Object
