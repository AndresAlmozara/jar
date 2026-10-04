$ErrorActionPreference='Stop'
$output='C:\JAR\output';$runId=$null
function Write-VerifierMarker([string]$Name,[string]$Stage){
 [ordered]@{schemaVersion='jar.sandbox-verifier-marker.v1';runId=$runId;stage=$Stage;timestamp=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output ($Name+'.json')) -Encoding UTF8
}
try {
 if([Environment]::UserName -ne 'WDAGUtilityAccount'){throw 'Sandbox required.'}
 if(-not(Test-Path -LiteralPath $output -PathType Container)){throw 'Mapped output unavailable.'}
 $planPath='C:\JAR\input\plan.json';if(-not(Test-Path -LiteralPath $planPath -PathType Leaf)){throw 'Verifier plan unavailable.'}
 $plan=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json;$runId=[string]$plan.runId
 if($runId -notmatch '^[0-9a-f]{64}$'){throw 'Verifier run identity invalid.'}
 Write-VerifierMarker 'bootstrap-started' 'bootstrap_started'
 . 'C:\JAR\input\scripts\m11-capture-network-guard.ps1';$null=Get-M11CaptureNetworkBoundary
 Write-VerifierMarker 'network-check-passed' 'network_check_passed'
 foreach($required in @('C:\JAR\input\runtime\node.exe','C:\JAR\input\scripts\live-sandbox-verifier-guest.mjs',('C:\JAR\input\verifier\'+$plan.entrypoint))){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw 'Verifier staged file unavailable.'}}
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName='C:\JAR\input\runtime\node.exe';$psi.Arguments='C:\JAR\input\scripts\live-sandbox-verifier-guest.mjs';$psi.WorkingDirectory='C:\JAR';$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.EnvironmentVariables.Clear()
 foreach($pair in @{SystemRoot='C:\Windows';WINDIR='C:\Windows';TEMP='C:\Windows\Temp';TMP='C:\Windows\Temp'}.GetEnumerator()){$psi.EnvironmentVariables[$pair.Key]=$pair.Value}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;if(-not $process.Start()){throw 'Verifier driver start failed.'}
 Write-VerifierMarker 'verifier-driver-started' 'verifier_driver_started'
 if(-not $process.WaitForExit(30000)){& C:\Windows\System32\taskkill.exe /PID $process.Id /T /F|Out-Null;throw 'Verifier driver timeout.'}
 if($process.ExitCode -ne 0){throw 'Verifier driver failed.'}
} catch {
 if(Test-Path -LiteralPath $output -PathType Container){[ordered]@{schemaVersion='jar.sandbox-verifier-failure.v1';runId=$runId;stage='bootstrap';code='VERIFIER_BOOTSTRAP_FAILED';timestamp=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output 'failure.json') -Encoding UTF8}
 & C:\Windows\System32\shutdown.exe /s /t 0 /f
}
