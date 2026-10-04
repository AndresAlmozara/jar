param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestHash,
 [ValidateSet('m12-effect-spike','m13-assist-guest','m14-assist-guest')][string]$Runner='m12-effect-spike')
$ErrorActionPreference='Stop'
if([Environment]::UserName -ne 'WDAGUtilityAccount' -or $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount'){throw 'Sandbox required.'}
$inputRoot='C:\M11\input';$outputRoot='C:\M11\output';$workRoot='C:\M11\work'
$stage='boundary';$process=$null
try {
 if(Test-Path -LiteralPath $workRoot){throw 'Fresh workspace required.'}
 if(@(Get-ChildItem -LiteralPath $outputRoot -Force).Count){throw 'Fresh output required.'}
 $manifestPath=Join-Path $inputRoot 'm12-manifest.json'
 if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedManifestHash){throw 'Manifest mismatch.'}
 $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
 if($manifest.schemaVersion -ne 'm12.isolated-package.v1'){throw 'Manifest schema mismatch.'}
 if(@(Get-ChildItem Env:|Where-Object {$_.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_)'}).Count){throw 'Credential environment present.'}
 $forbidden=@('C:\Users\WDAGUtilityAccount\.codex','C:\Users\WDAGUtilityAccount\.agents','C:\Users\WDAGUtilityAccount\.aws','C:\Users\WDAGUtilityAccount\.azure','C:\Users\WDAGUtilityAccount\.ssh','C:\Users\WDAGUtilityAccount\.kube','C:\ProgramData\OpenAI\Codex')
 if(@($forbidden|Where-Object {Test-Path -LiteralPath $_}).Count){throw 'Normal state present.'}
 Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class M12Credentials {
 [DllImport("advapi32.dll",EntryPoint="CredEnumerateW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Enumerate(string filter,uint flags,out uint count,out IntPtr credentials);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
 [uint32]$count=0;[IntPtr]$pointer=[IntPtr]::Zero
 try{$ok=[M12Credentials]::Enumerate($null,0,[ref]$count,[ref]$pointer);$err=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if(($ok -and $count -ne 0) -or (-not $ok -and $err -ne 1168)){throw 'Credential inventory rejected.'}}finally{if($pointer -ne [IntPtr]::Zero){[M12Credentials]::CredFree($pointer)}}
 $guardPath=Join-Path $inputRoot 'scripts\m11-capture-network-guard.ps1'
 $guard=@($manifest.files|Where-Object relativePath -eq 'scripts/m11-capture-network-guard.ps1')
 if($guard.Count -ne 1 -or (Get-FileHash -LiteralPath $guardPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $guard[0].sha256){throw 'Guard mismatch.'}
 . $guardPath
 $null=Get-M11CaptureNetworkBoundary
 $stage='staging'
 New-Item -ItemType Directory -Path $workRoot|Out-Null
 foreach($file in $manifest.files){
  $source=[IO.Path]::GetFullPath((Join-Path $inputRoot $file.relativePath));$target=[IO.Path]::GetFullPath((Join-Path $workRoot $file.relativePath))
  if(-not $source.StartsWith($inputRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith($workRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path escaped.'}
  if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'File mismatch.'}
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null
  Copy-Item -LiteralPath $source -Destination $target
 }
 foreach($dir in @('codex','tmp','project')){New-Item -ItemType Directory -Path (Join-Path $workRoot $dir)|Out-Null}
 Copy-Item -LiteralPath (Join-Path $workRoot 'fixtures\m11-frozen\model-catalog.json') -Destination (Join-Path $workRoot 'codex\model-catalog.json')
 $clean=[ordered]@{SystemRoot='C:\Windows';WINDIR='C:\Windows';SystemDrive='C:';COMSPEC='C:\Windows\System32\cmd.exe';PATH='C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0';PATHEXT='.COM;.EXE;.BAT;.CMD';USERNAME='WDAGUtilityAccount';USERPROFILE='C:\Users\WDAGUtilityAccount';APPDATA='C:\Users\WDAGUtilityAccount\AppData\Roaming';LOCALAPPDATA='C:\Users\WDAGUtilityAccount\AppData\Local';TEMP='C:\M11\work\tmp';TMP='C:\M11\work\tmp';CODEX_HOME='C:\M11\work\codex';CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED='1'}
 $stage='effect'
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=Join-Path $workRoot 'runtime\node.exe';$psi.Arguments=('scripts/'+$Runner+'.mjs');$psi.WorkingDirectory=$workRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.EnvironmentVariables.Clear()
 foreach($item in $clean.GetEnumerator()){$psi.EnvironmentVariables[$item.Key]=$item.Value}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$psi
 if(-not $process.Start()){throw 'Driver start failed.'}
 $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
 if(-not $process.WaitForExit(150000)){& 'C:\Windows\System32\taskkill.exe' /PID $process.Id /T /F|Out-Null;throw 'Driver timeout.'}
 $stage='disposal'
 $running=@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($workRoot+'\',[StringComparison]::OrdinalIgnoreCase)})
 if($running.Count){throw 'Owned processes remain.'}
 $null=Get-M11CaptureNetworkBoundary
 if(@($forbidden|Where-Object {Test-Path -LiteralPath $_}).Count){throw 'Normal state changed.'}
 $resolved=[IO.Path]::GetFullPath($workRoot)
 if($resolved -ne 'C:\M11\work' -or (Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Invalid cleanup root.'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
 $boundary=[ordered]@{schemaVersion='m12.disposal.v1';ownedProcessesRemaining=0;ownedStateDisposed=(-not(Test-Path -LiteralPath $resolved));normalGuestStateCreated=0;externalNetworkEnabled=$false;driverExitCode=$process.ExitCode}
 $boundary|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $outputRoot 'm12-disposal.json') -Encoding UTF8
}catch{
 [ordered]@{schemaVersion='m12.bootstrap-failure.v1';stage=$stage;code='ISOLATED_EFFECT_FAILED'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $outputRoot 'm12-bootstrap-failure.json') -Encoding UTF8
 throw 'Isolated effect failed; inspect sanitized artifact.'
}
