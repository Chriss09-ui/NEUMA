param([ValidateSet('x64', 'arm64')][string]$Architecture = $env:VSCMD_ARG_TGT_ARCH)
$ErrorActionPreference = 'Stop'
if (!$Architecture) { throw 'Use an x64 or ARM64 Visual Studio Developer PowerShell session.' }
if ($env:VSCMD_ARG_TGT_ARCH -ne $Architecture) { throw 'Select the matching Visual Studio target architecture first.' }
$TaskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$TaskOutput = Join-Path $TaskRoot "native/isolation/bin/win32-$Architecture"
New-Item -ItemType Directory -Force $TaskOutput | Out-Null
Push-Location $TaskOutput
try {
  & cl.exe /nologo /std:c++17 /W4 /WX /O2 /MT /EHsc /DUNICODE /D_UNICODE (Join-Path $PSScriptRoot 'windows.cpp') /Fe:neuma-isolation.exe /link userenv.lib advapi32.lib bcrypt.lib /MANIFEST:EMBED "/MANIFESTINPUT:$(Join-Path $PSScriptRoot 'windows.manifest')"
  if ($LASTEXITCODE -ne 0) { throw 'Native helper build failed.' }
  Remove-Item -ErrorAction SilentlyContinue '*.obj'
} finally { Pop-Location }
