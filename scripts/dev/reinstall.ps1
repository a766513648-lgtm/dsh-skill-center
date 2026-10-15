# Build, pack and install Skill Center into the DSH desktop profile.
#
# Only needed while iterating on a checkout; a packaged release is installed with
# a single `dsh plugin --profile desktop add <tgz>`.
#
# Usage:
#   pwsh -File scripts/reinstall.ps1                 # real page
#   pwsh -File scripts/reinstall.ps1 -Variant minimal
param(
    [ValidateSet('real', 'minimal')]
    [string]$Variant = 'real',
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$desktop = 'O:\DSH_DeskTop\DSH NEXT'
$cli = Join-Path $desktop 'resources\app\lib\desktop-cli.js'
$exe = Join-Path $desktop 'DSH NEXT.exe'
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$targetModule = Join-Path $profileDir 'node_modules\@dsh-workship\skill-center'

Write-Host "== variant: $Variant =="
node (Join-Path $PSScriptRoot 'variant.mjs') $Variant
if ($LASTEXITCODE -ne 0) { throw "variant switch failed" }

Push-Location $project
try {
    Write-Host '== typecheck + build + tests =='
    npm run verify
    if ($LASTEXITCODE -ne 0) { throw "verify failed" }

    Write-Host '== pack =='
    Get-ChildItem -Filter '*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
    npm pack
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
    $tgz = (Get-ChildItem -Filter '*.tgz' | Select-Object -First 1).FullName
    Write-Host "package: $tgz"

    Write-Host '== install =='
    # pnpm decides "already up to date" from the lockfile, so the installed copy
    # is removed first; otherwise a rebuild never reaches the profile.
    if (Test-Path $targetModule) { Remove-Item -Recurse -Force -LiteralPath (Resolve-Path $targetModule).Path }
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe $cli plugin --profile $Profile add $tgz
    if ($LASTEXITCODE -ne 0) { throw "install failed" }
    Write-Host "installed into $profileDir"
}
finally {
    Pop-Location
}
