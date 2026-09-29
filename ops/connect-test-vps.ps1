$ErrorActionPreference = 'Stop'
$taskKey = Join-Path $env:USERPROFILE '.ssh\maximum_vps'
if (-not (Test-Path -LiteralPath $taskKey)) { throw 'SSH key not found on this Windows account.' }
& ssh -i $taskKey -o IdentitiesOnly=yes -o HostKeyAlias=maximum-vps-371333-current -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -p 22 maximum-admin@89.125.214.188
exit $LASTEXITCODE
