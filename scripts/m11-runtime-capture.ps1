param(
  [Parameter(Mandatory=$true)][ValidateSet('baseline','filtered')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestHash
)
$ErrorActionPreference='Stop'
$inputRoot='C:\M11\input';$outputRoot='C:\M11\output';$workRoot='C:\M11\work'
if([Environment]::UserName -ne 'WDAGUtilityAccount' -or $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount'){throw 'Refusing non-Sandbox identity before filesystem or process activity.'}
$failurePath=Join-Path $outputRoot ("m11-{0}-bootstrap-failure.json" -f $Mode)
$stage='initial-validation'
function New-M11BootstrapException([string]$Code,[string]$SafeMessage) {$exception=[InvalidOperationException]::new($SafeMessage);$exception.Data['M11Code']=$Code;return $exception}
function Get-M11CaptureServerReadinessDecision([bool]$Ready,[bool]$Exited,[bool]$Expired) {if($Ready){return 'READY'};if($Exited){return 'EXITED_BEFORE_READY'};if($Expired){return 'READINESS_TIMEOUT'};return 'WAIT'}
function Test-M11CaptureFinalization($ServerState,$DriverState,[bool]$CandidateExists) {return ($CandidateExists -and $ServerState.requestValidationPassed -eq $true -and $ServerState.responseCompletedSent -eq $true -and $ServerState.responseStreamClosed -eq $true -and $ServerState.captureCandidateComplete -eq $true -and $ServerState.captureCandidatePersisted -eq $true -and $DriverState.turnStartRpcAccepted -eq $true -and $DriverState.turnCompletedNotificationObserved -eq $true -and $DriverState.turnTerminalStatus -eq 'COMPLETED')}
function New-M11BootstrapFailureRecord([string]$Mode,[string]$Stage,[Management.Automation.ErrorRecord]$Failure,$Details) {
  $allowedCodes=@('NETWORK_ADAPTER_INVENTORY_UNAVAILABLE','NETWORK_ROUTE_INVENTORY_UNAVAILABLE','ACTIVE_NETWORK_ADAPTER_PRESENT','DEFAULT_IPV4_ROUTE_PRESENT','NODE_START_FAILURE','SERVER_SCRIPT_START_FAILURE','PLAN_LOAD_FAILURE','PLAN_VALIDATION_FAILURE','LOOPBACK_BIND_FAILURE','READY_FILE_WRITE_FAILURE','SERVER_EXITED_BEFORE_READY','SERVER_READINESS_TIMEOUT','CAPTURE_DRIVER_START_FAILURE','DRIVER_SCRIPT_START_FAILURE','CODEX_PROCESS_START_FAILURE','CODEX_INITIALIZE_FAILURE','THREAD_START_FAILURE','TURN_START_FAILURE','TURN_START_RPC_FAILURE','PROVIDER_REQUEST_VALIDATION_FAILURE','PROVIDER_RESPONSE_START_FAILURE','PROVIDER_RESPONSE_PROTOCOL_FAILURE','TURN_COMPLETION_NOT_OBSERVED','TURN_COMPLETED_WITH_FAILURE','CAPTURE_FINALIZATION_FAILURE','MODEL_REQUEST_NOT_OBSERVED','DRIVER_PROTOCOL_FAILURE','DRIVER_TIMEOUT','DRIVER_EXITED_NONZERO','CAPTURE_SERVER_REQUEST_REJECTED','UNKNOWN_CAPTURE_DRIVER_FAILURE')
  $candidate=[string]$Failure.Exception.Data['M11Code'];$code=if($allowedCodes -contains $candidate){$candidate}else{'BOOTSTRAP_FAILED'}
  $message=switch($code){
    'NETWORK_ADAPTER_INVENTORY_UNAVAILABLE' {'Network adapter inventory was unavailable; capture refused.'}
    'NETWORK_ROUTE_INVENTORY_UNAVAILABLE' {'IPv4 route inventory was unavailable; capture refused.'}
    'ACTIVE_NETWORK_ADAPTER_PRESENT' {'An active network adapter was observed; capture refused.'}
    'DEFAULT_IPV4_ROUTE_PRESENT' {'A default IPv4 route was observed; capture refused.'}
    'NODE_START_FAILURE' {'The capture-server process could not be started.'}
    'SERVER_SCRIPT_START_FAILURE' {'The capture-server script failed during initialization.'}
    'PLAN_LOAD_FAILURE' {'The capture plan could not be loaded.'}
    'PLAN_VALIDATION_FAILURE' {'The capture plan failed validation.'}
    'LOOPBACK_BIND_FAILURE' {'The capture server could not bind the frozen loopback endpoint.'}
    'READY_FILE_WRITE_FAILURE' {'The capture server could not publish readiness.'}
    'SERVER_EXITED_BEFORE_READY' {'The capture server exited before readiness.'}
    'SERVER_READINESS_TIMEOUT' {'The capture server remained alive without becoming ready.'}
    'CAPTURE_DRIVER_START_FAILURE' {'The capture-driver process could not be started.'}
    'DRIVER_SCRIPT_START_FAILURE' {'The capture-driver script failed before Codex startup.'}
    'CODEX_PROCESS_START_FAILURE' {'The Codex process could not be started.'}
    'CODEX_INITIALIZE_FAILURE' {'Codex app-server initialization failed.'}
    'THREAD_START_FAILURE' {'Codex thread/start failed.'}
    'TURN_START_FAILURE' {'Codex turn/start or turn completion failed.'}
    'TURN_START_RPC_FAILURE' {'Codex rejected or failed the turn/start RPC.'}
    'PROVIDER_REQUEST_VALIDATION_FAILURE' {'The observed provider request failed capture validation.'}
    'PROVIDER_RESPONSE_START_FAILURE' {'The synthetic provider response could not be started.'}
    'PROVIDER_RESPONSE_PROTOCOL_FAILURE' {'The synthetic provider response stream failed.'}
    'TURN_COMPLETION_NOT_OBSERVED' {'No terminal Codex turn completion notification was observed.'}
    'TURN_COMPLETED_WITH_FAILURE' {'Codex reported a non-success terminal turn state.'}
    'CAPTURE_FINALIZATION_FAILURE' {'The complete capture candidate could not be finalized after turn completion.'}
    'MODEL_REQUEST_NOT_OBSERVED' {'No provider request reached the capture server.'}
    'DRIVER_PROTOCOL_FAILURE' {'The capture-driver observed an invalid app-server protocol event.'}
    'DRIVER_TIMEOUT' {'The capture-driver exceeded its bounded execution time.'}
    'DRIVER_EXITED_NONZERO' {'The capture-driver exited non-zero without a more specific safe classification.'}
    'CAPTURE_SERVER_REQUEST_REJECTED' {'The capture server observed but rejected the provider request.'}
    'UNKNOWN_CAPTURE_DRIVER_FAILURE' {'The capture-driver failed without safe structured state.'}
    default {'Capture bootstrap failed closed.'}
  }
  $record=[ordered]@{schemaVersion='m11.capture-bootstrap-failure.v1';mode=$Mode;stage=$Stage;errorCode=$code;message=$message;timestamp=[DateTime]::UtcNow.ToString('o')}
  if($Details){foreach($key in @('processStarted','readyFileAppeared','childExitCode','stderrBytes','stderrSha256','driverProcessStarted','driverExitCode','driverStderrBytes','driverStderrSha256','codexProcessStarted','codexExitCode','initializedObserved','threadStartObserved','turnStartObserved','turnCompletedObserved','turnStartRpcAccepted','turnStartedNotificationObserved','turnCompletedNotificationObserved','turnTerminalStatus','captureServerRequestObserved','requestMethodMatch','requestPathMatch','requestValidationPassed','validationDiagnosticsSchemaVersion','validationFailureCodes','requestShapeFingerprint','topLevelKeySetHash','unknownTopLevelKeyCount','requiredFieldPresenceBitmap','toolContainerPresent','toolInventoryEvaluable','observedToolCount','observedToolNamesHash','expectedToolCount','expectedToolNamesHash','toolInventoryMatch','modelPresent','modelHashMatches','runtimeMetadataPolicyId','runtimeMetadataValidationPassed','unknownRuntimeMetadataKeyCount','captureScopeCompletenessState','httpResponseStarted','responseCreatedSent','responseCompletedSent','responseStreamClosed','captureCandidateCreated','captureCandidateComplete','captureCandidatePersisted')){if($Details.Contains($key)){$record[$key]=$Details[$key]}}}
  return $record
}
$failureDetails=$null
try {
if(Test-Path -LiteralPath $workRoot){throw 'Fresh guest work root required.'}
$receiptPath=Join-Path $outputRoot ("m11-{0}-capture.json" -f $Mode)
$pendingReceiptPath="$receiptPath.pending"
if((Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $pendingReceiptPath)){throw 'Capture receipt path is not fresh.'}
$manifestPath=Join-Path $inputRoot 'manifest.json'
if((Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant() -ne $ExpectedManifestHash){throw 'Manifest hash mismatch.'}
$manifest=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
if($manifest.schemaVersion -ne 'm11.runtime-capture-package.v1' -or $manifest.safeForLoopbackCapture -ne $true -or $manifest.runtimeAdmission -ne 'ADMITTED_COMPLETE_FOR_SCOPE' -or $manifest.endpoint -ne 'http://127.0.0.1:43187/v1' -or $manifest.networking -ne 'DISABLED'){throw 'Capture gate is not open.'}
$admission=Get-Content -Raw -LiteralPath (Join-Path $inputRoot 'evidence\runtime\codex\admission.json')|ConvertFrom-Json
if($admission.outcome -ne 'ADMITTED_COMPLETE_FOR_SCOPE' -or $admission.admittedRuntimeProfileId -ne $manifest.admittedRuntimeProfileId){throw 'Admission mismatch.'}
$credentialNames=@(Get-ChildItem Env:|Where-Object {$_.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_)'})
if($credentialNames.Count -ne 0){throw 'Unexpected credential environment.'}
[uint32]$credentialCount=0;[IntPtr]$credentialPointer=[IntPtr]::Zero
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class M11CaptureCredentials {
 [DllImport("advapi32.dll",EntryPoint="CredEnumerateW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Enumerate(string filter,uint flags,out uint count,out IntPtr credentials);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
try{$credentialResult=[M11CaptureCredentials]::Enumerate($null,0,[ref]$credentialCount,[ref]$credentialPointer);$credentialError=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($credentialResult -and $credentialCount -ne 0){throw 'Unexpected saved credentials.'};if(-not $credentialResult -and $credentialError -ne 1168){throw 'Credential inventory unavailable.'}}finally{if($credentialPointer -ne [IntPtr]::Zero){[M11CaptureCredentials]::CredFree($credentialPointer)}}
$forbidden=@('C:\Users\WDAGUtilityAccount\.codex','C:\Users\WDAGUtilityAccount\.agents','C:\Users\WDAGUtilityAccount\.aws','C:\Users\WDAGUtilityAccount\.azure','C:\Users\WDAGUtilityAccount\.ssh','C:\Users\WDAGUtilityAccount\.kube','C:\ProgramData\OpenAI\Codex')
if(@($forbidden|Where-Object {Test-Path -LiteralPath $_}).Count -ne 0){throw 'Unexpected normal-state root.'}
$stage='network-boundary'
$networkGuardManifestPath='scripts/m11-capture-network-guard.ps1'
$networkGuardEntry=@($manifest.files|Where-Object relativePath -eq $networkGuardManifestPath)
$networkGuardPath=Join-Path $inputRoot 'scripts\m11-capture-network-guard.ps1'
if($networkGuardEntry.Count -ne 1 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $networkGuardPath).Hash.ToLowerInvariant() -ne $networkGuardEntry[0].sha256){throw 'Network guard binding mismatch.'}
. $networkGuardPath
$networkBoundary=Get-M11CaptureNetworkBoundary
$stage='package-staging'
New-Item -ItemType Directory -Path $workRoot|Out-Null
foreach($file in $manifest.files){
 $source=[IO.Path]::GetFullPath((Join-Path $inputRoot $file.relativePath));$target=[IO.Path]::GetFullPath((Join-Path $workRoot $file.relativePath))
 if(-not $source.StartsWith(([IO.Path]::GetFullPath($inputRoot)+'\'),[StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith(([IO.Path]::GetFullPath($workRoot)+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Package path escaped root.'}
 if((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant() -ne $file.sha256){throw "Package hash mismatch: $($file.relativePath)"}
 New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath $source -Destination $target
}
if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $workRoot 'runtime\codex.exe')).Hash.ToLowerInvariant() -ne $manifest.codexSha256){throw 'Codex hash mismatch.'}
foreach($binding in $manifest.requiredBindings){if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $workRoot $binding.path)).Hash.ToLowerInvariant() -ne $binding.sha256){throw "Required binding mismatch: $($binding.path)"}}
$clean=[ordered]@{SystemRoot='C:\Windows';WINDIR='C:\Windows';SystemDrive='C:';COMSPEC='C:\Windows\System32\cmd.exe';PATH='C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0';PATHEXT='.COM;.EXE;.BAT;.CMD';USERNAME='WDAGUtilityAccount';USERPROFILE='C:\Users\WDAGUtilityAccount';APPDATA='C:\Users\WDAGUtilityAccount\AppData\Roaming';LOCALAPPDATA='C:\Users\WDAGUtilityAccount\AppData\Local';TEMP='C:\M11\work\tmp';TMP='C:\M11\work\tmp';CODEX_HOME='C:\M11\work\codex';CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED='1'}
foreach($dir in @($clean.TEMP,$clean.CODEX_HOME,'C:\M11\work\project','C:\M11\work\control')){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
Copy-Item -LiteralPath (Join-Path $workRoot 'fixtures\m11-frozen\config.toml') -Destination (Join-Path $clean.CODEX_HOME 'config.toml')
Copy-Item -LiteralPath (Join-Path $workRoot 'fixtures\m11-frozen\model-catalog.json') -Destination (Join-Path $clean.CODEX_HOME 'model-catalog.json')
function Start-CleanNode([string]$Role,[string[]]$Arguments){$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=Join-Path $workRoot 'runtime\node.exe';$psi.WorkingDirectory=$workRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.Arguments=($Arguments|ForEach-Object {'"'+($_ -replace '"','\"')+'"'}) -join ' ';$psi.EnvironmentVariables.Clear();foreach($item in $clean.GetEnumerator()){$psi.EnvironmentVariables[$item.Key]=$item.Value};$process=[Diagnostics.Process]::new();$process.StartInfo=$psi;try{$started=$process.Start()}catch{if($Role -eq 'capture-server'){throw (New-M11BootstrapException 'NODE_START_FAILURE' 'Capture-server process start failed.')};if($Role -eq 'capture-driver'){throw (New-M11BootstrapException 'CAPTURE_DRIVER_START_FAILURE' 'Capture-driver process start failed.')};throw};if(-not $started){if($Role -eq 'capture-server'){throw (New-M11BootstrapException 'NODE_START_FAILURE' 'Capture-server process start failed.')};if($Role -eq 'capture-driver'){throw (New-M11BootstrapException 'CAPTURE_DRIVER_START_FAILURE' 'Capture-driver process start failed.')};throw 'Process start failed.'};return $process}
$plan=Join-Path $workRoot ("fixtures\m11-capture-runtime\{0}.json" -f $Mode);$ready=Join-Path $workRoot 'control\server-ready'
$serverFailure=Join-Path $workRoot 'control\server-start-failure.json';$requestState=Join-Path $workRoot 'control\server-state.json';$driverState=Join-Path $workRoot 'control\driver-state.json';$captureCandidate=Join-Path $workRoot 'control\capture-candidate.json'
$stage='capture-server-start'
$server=Start-CleanNode 'capture-server' @((Join-Path $workRoot 'scripts\m11-runtime-capture-server.mjs'),$plan,$receiptPath,$captureCandidate,$ready,$serverFailure,$requestState)
try{
 $limit=[DateTime]::UtcNow.AddSeconds(15);while($true){$decision=Get-M11CaptureServerReadinessDecision (Test-Path -LiteralPath $ready) $server.HasExited ([DateTime]::UtcNow -gt $limit)
  if($decision -eq 'READY'){break}
  if($decision -eq 'EXITED_BEFORE_READY'){$server.WaitForExit();$stderr=$server.StandardError.ReadToEnd();$stderrBuffer=[Text.Encoding]::UTF8.GetBytes($stderr);$stderrHash=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($stderrBuffer))).Replace('-','').ToLowerInvariant();$failureDetails=@{processStarted=$true;readyFileAppeared=$false;childExitCode=$server.ExitCode;stderrBytes=$stderrBuffer.Length;stderrSha256=$stderrHash};$serverCode='SERVER_EXITED_BEFORE_READY';if(Test-Path -LiteralPath $serverFailure){try{$serverReport=Get-Content -Raw -LiteralPath $serverFailure|ConvertFrom-Json;if($serverReport.schemaVersion -eq 'm11.capture-server-start-failure.v1' -and $serverReport.errorCode -in @('SERVER_SCRIPT_START_FAILURE','PLAN_LOAD_FAILURE','PLAN_VALIDATION_FAILURE','LOOPBACK_BIND_FAILURE','READY_FILE_WRITE_FAILURE')){$serverCode=$serverReport.errorCode}}catch{}};throw (New-M11BootstrapException $serverCode 'Capture server exited before readiness.')}
  if($decision -eq 'READINESS_TIMEOUT'){$failureDetails=@{processStarted=$true;readyFileAppeared=$false;childExitCode=$null;stderrBytes=$null;stderrSha256=$null};throw (New-M11BootstrapException 'SERVER_READINESS_TIMEOUT' 'Capture server readiness timed out.')}
  Start-Sleep -Milliseconds 25
 }
 $stage='codex-capture-driver'
 $failureDetails=@{driverProcessStarted=$false;captureServerRequestObserved=$false}
 $driver=Start-CleanNode 'capture-driver' @((Join-Path $workRoot 'scripts\m11-runtime-capture-driver.mjs'),(Join-Path $workRoot 'runtime\codex.exe'),$plan,(Join-Path $workRoot 'fixtures\m11-frozen\thread-inputs.json'),$driverState)
 $driverStarted=$true
 if(-not $driver.WaitForExit(60000)){$driver.Kill();$driver.WaitForExit();$driverCode='DRIVER_TIMEOUT'}else{$driverCode=$null}
 $driverStderr=$driver.StandardError.ReadToEnd();$driverStderrBuffer=[Text.Encoding]::UTF8.GetBytes($driverStderr);$driverStderrHash=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($driverStderrBuffer))).Replace('-','').ToLowerInvariant()
 if($driver.ExitCode -ne 0 -and -not $server.HasExited){$null=$server.WaitForExit(5000)}
 $driverReport=$null;if(Test-Path -LiteralPath $driverState){try{$candidate=Get-Content -Raw -LiteralPath $driverState|ConvertFrom-Json;if($candidate.schemaVersion -eq 'm11.capture-driver-state.v2'){$driverReport=$candidate}}catch{}}
 $requestReport=$null;$requestObserved=$false;if(Test-Path -LiteralPath $requestState){try{$candidate=Get-Content -Raw -LiteralPath $requestState|ConvertFrom-Json;if($candidate.schemaVersion -eq 'm11.capture-server-state.v3'){$requestReport=$candidate;$requestObserved=($candidate.requestObserved -eq $true)}}catch{}}
 $failureDetails=@{driverProcessStarted=$driverStarted;driverExitCode=$driver.ExitCode;driverStderrBytes=$driverStderrBuffer.Length;driverStderrSha256=$driverStderrHash;captureServerRequestObserved=$requestObserved}
 if($driverReport){foreach($key in @('codexProcessStarted','codexExitCode','initializedObserved','threadStartObserved','turnStartObserved','turnCompletedObserved','turnStartRpcAccepted','turnStartedNotificationObserved','turnCompletedNotificationObserved','turnTerminalStatus')){$failureDetails[$key]=$driverReport.$key};if(-not $driverCode -and $driver.ExitCode -ne 0 -and $driverReport.failureCode -in @('DRIVER_SCRIPT_START_FAILURE','CODEX_PROCESS_START_FAILURE','CODEX_INITIALIZE_FAILURE','THREAD_START_FAILURE','TURN_START_RPC_FAILURE','TURN_COMPLETION_NOT_OBSERVED','TURN_COMPLETED_WITH_FAILURE','DRIVER_PROTOCOL_FAILURE','DRIVER_TIMEOUT','DRIVER_EXITED_NONZERO')){$driverCode=$driverReport.failureCode}}
 elseif(-not $driverCode -and $driver.ExitCode -ne 0){$driverCode='UNKNOWN_CAPTURE_DRIVER_FAILURE'}
 $serverCode=$null;if($requestReport){foreach($key in @('requestMethodMatch','requestPathMatch','requestValidationPassed','validationDiagnosticsSchemaVersion','validationFailureCodes','requestShapeFingerprint','topLevelKeySetHash','unknownTopLevelKeyCount','requiredFieldPresenceBitmap','toolContainerPresent','toolInventoryEvaluable','observedToolCount','observedToolNamesHash','expectedToolCount','expectedToolNamesHash','toolInventoryMatch','modelPresent','modelHashMatches','runtimeMetadataPolicyId','runtimeMetadataValidationPassed','unknownRuntimeMetadataKeyCount','captureScopeCompletenessState','httpResponseStarted','responseCreatedSent','responseCompletedSent','responseStreamClosed','captureCandidateCreated','captureCandidateComplete','captureCandidatePersisted')){$failureDetails[$key]=$requestReport.$key};if($requestReport.failureCode -in @('PROVIDER_REQUEST_VALIDATION_FAILURE','PROVIDER_RESPONSE_START_FAILURE','PROVIDER_RESPONSE_PROTOCOL_FAILURE','CAPTURE_FINALIZATION_FAILURE')){$serverCode=$requestReport.failureCode}}
 if($serverCode){throw (New-M11BootstrapException $serverCode 'Capture server failed after request observation.')}
 if($driverCode){throw (New-M11BootstrapException $driverCode 'Capture driver failed.')}
 if($driver.ExitCode -ne 0){throw (New-M11BootstrapException 'DRIVER_EXITED_NONZERO' 'Capture driver failed.')}
 $stage='capture-result-validation'
 if(-not $server.WaitForExit(15000)){$server.Kill();throw (New-M11BootstrapException 'DRIVER_TIMEOUT' 'Capture server did not terminate.')}
 if(Test-Path -LiteralPath $requestState){try{$candidate=Get-Content -Raw -LiteralPath $requestState|ConvertFrom-Json;if($candidate.schemaVersion -eq 'm11.capture-server-state.v3'){$requestReport=$candidate;$requestObserved=($candidate.requestObserved -eq $true);$failureDetails['captureServerRequestObserved']=$requestObserved;foreach($key in @('requestMethodMatch','requestPathMatch','requestValidationPassed','validationDiagnosticsSchemaVersion','validationFailureCodes','requestShapeFingerprint','topLevelKeySetHash','unknownTopLevelKeyCount','requiredFieldPresenceBitmap','toolContainerPresent','toolInventoryEvaluable','observedToolCount','observedToolNamesHash','expectedToolCount','expectedToolNamesHash','toolInventoryMatch','modelPresent','modelHashMatches','runtimeMetadataPolicyId','runtimeMetadataValidationPassed','unknownRuntimeMetadataKeyCount','captureScopeCompletenessState','httpResponseStarted','responseCreatedSent','responseCompletedSent','responseStreamClosed','captureCandidateCreated','captureCandidateComplete','captureCandidatePersisted')){$failureDetails[$key]=$requestReport.$key}}}catch{}}
 if($server.ExitCode -ne 0){$serverCode=if($requestReport.failureCode -in @('PROVIDER_REQUEST_VALIDATION_FAILURE','PROVIDER_RESPONSE_START_FAILURE','PROVIDER_RESPONSE_PROTOCOL_FAILURE','CAPTURE_FINALIZATION_FAILURE')){$requestReport.failureCode}else{'CAPTURE_SERVER_REQUEST_REJECTED'};throw (New-M11BootstrapException $serverCode 'Capture server rejected request.')}
 if(-not $requestObserved){throw (New-M11BootstrapException 'MODEL_REQUEST_NOT_OBSERVED' 'No capture-server request was observed.')}
 $stage='capture-finalization'
 if(-not (Test-M11CaptureFinalization $requestReport $driverReport (Test-Path -LiteralPath $captureCandidate))){throw (New-M11BootstrapException 'CAPTURE_FINALIZATION_FAILURE' 'Capture candidate was not finalizable.')}
 try{$candidateText=Get-Content -Raw -LiteralPath $captureCandidate;$candidateReceipt=$candidateText|ConvertFrom-Json;if($candidateReceipt.version -ne 'captured.model.request.v1' -or $candidateReceipt.evidenceClass -ne 'model_context' -or $candidateReceipt.runtimeCaptureAuthorized -ne $false -or $candidateReceipt.completeness -ne 'COMPLETE'){throw 'Invalid capture candidate.'};$bytes=[Text.Encoding]::UTF8.GetBytes($candidateText);$stream=[IO.File]::Open($pendingReceiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush()}finally{$stream.Dispose()};Move-Item -LiteralPath $pendingReceiptPath -Destination $receiptPath}catch{if(Test-Path -LiteralPath $pendingReceiptPath){Remove-Item -LiteralPath $pendingReceiptPath -Force};throw (New-M11BootstrapException 'CAPTURE_FINALIZATION_FAILURE' 'Capture finalization failed.')}
}finally{if($server -and -not $server.HasExited){$server.Kill()}}
} catch {
  $failure=New-M11BootstrapFailureRecord $Mode $stage $_ $failureDetails
  try {
    $json=$failure|ConvertTo-Json -Compress
    $stream=[IO.File]::Open($failurePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false));$writer.Write($json);$writer.Write("`n");$writer.Flush()}finally{$writer.Dispose()}
  } catch { }
  throw
}
