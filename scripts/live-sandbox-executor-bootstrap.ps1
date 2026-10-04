param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestHash)
$ErrorActionPreference='Stop';$mapped='C:\JAR';$work='C:\JARWork'
try {
 if([Environment]::UserName -ne 'WDAGUtilityAccount'){throw 'Sandbox required.'}
 if((Get-FileHash -LiteralPath "$mapped\input\manifest.json" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedManifestHash){throw 'Manifest mismatch.'}
 $manifest=Get-Content -LiteralPath "$mapped\input\manifest.json" -Raw|ConvertFrom-Json
 foreach($file in $manifest.files){$path=[IO.Path]::GetFullPath((Join-Path "$mapped\input" $file.path));if(-not $path.StartsWith("$mapped\input\",[StringComparison]::OrdinalIgnoreCase)){throw 'Path escaped.'};if((Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'File mismatch.'}}
 . "$mapped\input\scripts\m11-capture-network-guard.ps1";$network=Get-M11CaptureNetworkBoundary
 [ordered]@{schemaVersion='jar.sandbox-network-proof.v1';activeAdapterCount=$network.activeAdapterCount;defaultIpv4RouteCount=$network.defaultIpv4RouteCount;toolExecutionNetwork='disabled_by_windows_sandbox'}|ConvertTo-Json|Set-Content -LiteralPath "$mapped\bridge\network-proof.json" -Encoding UTF8
 New-Item -ItemType Directory -Path $work|Out-Null;New-Item -ItemType Directory -Path "$work\tmp"|Out-Null
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName="$mapped\input\runtime\node.exe";$psi.Arguments="$mapped\input\scripts\live-sandbox-executor-guest.mjs";$psi.WorkingDirectory=$mapped;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.EnvironmentVariables.Clear()
 foreach($pair in @{SystemRoot='C:\Windows';WINDIR='C:\Windows';TEMP="$work\tmp";TMP="$work\tmp"}.GetEnumerator()){$psi.EnvironmentVariables[$pair.Key]=$pair.Value}
 # The model turn may run for 600 seconds; allow bounded startup, RPC draining and export too.
 $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;if(-not $p.Start()){throw 'Executor start failed.'};if(-not $p.WaitForExit(900000)){& C:\Windows\System32\taskkill.exe /PID $p.Id /T /F|Out-Null;throw 'Executor timeout.'};if($p.ExitCode -ne 0){throw 'Executor failed.'}
} catch {[ordered]@{schemaVersion='jar.sandbox-executor-failure.v1';code='EXECUTOR_GUEST_FAILED'}|ConvertTo-Json|Set-Content -LiteralPath "$mapped\output\failure.json" -Encoding UTF8;throw}
