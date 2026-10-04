$ErrorActionPreference='Stop'
$workRoot=[IO.Path]::GetFullPath('C:\M11\work')
if($workRoot -ne 'C:\M11\work'){throw 'Refusing unexpected cleanup target.'}
if(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($workRoot+'\'),[StringComparison]::OrdinalIgnoreCase)}){throw 'Owned process still running.'}
if(Test-Path -LiteralPath $workRoot){Remove-Item -LiteralPath $workRoot -Recurse -Force}
