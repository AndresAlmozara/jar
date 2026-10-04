param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedManifestHash
)
$ErrorActionPreference='Stop'
$inputRoot='C:\M11\input'
$outputRoot='C:\M11\output'
$workRoot='C:\M11\work'
$receiptPath=Join-Path $outputRoot 'codex-runtime-preflight.json'

if ([Environment]::UserName -ne 'WDAGUtilityAccount' -or $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount') {
  throw 'Refusing non-Sandbox identity before filesystem or process activity.'
}
if (Test-Path -LiteralPath $workRoot) { throw 'Fresh guest work root required.' }
if (Test-Path -LiteralPath $receiptPath) { throw 'Receipt already exists.' }
$manifestPath=Join-Path $inputRoot 'manifest.json'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant() -ne $ExpectedManifestHash) { throw 'Manifest hash mismatch.' }
$manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 'm11.runtime-preflight-package.v1') { throw 'Unexpected manifest schema.' }

function Get-RelativeSnapshot([string]$Root) {
  $rows=@()
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
    $relative=$file.FullName.Substring($Root.Length).TrimStart('\')
    $rows += [pscustomobject]@{path=$relative;size=$file.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()}
  }
  return @($rows | Sort-Object path)
}
function Get-ForbiddenRoots {
  $paths=@(
    'C:\Users\WDAGUtilityAccount\.codex','C:\Users\WDAGUtilityAccount\.agents',
    'C:\Users\WDAGUtilityAccount\.aws','C:\Users\WDAGUtilityAccount\.azure',
    'C:\Users\WDAGUtilityAccount\.ssh','C:\Users\WDAGUtilityAccount\.kube',
    'C:\ProgramData\OpenAI\Codex'
  )
  return @($paths | ForEach-Object { [pscustomobject]@{path=$_;exists=(Test-Path -LiteralPath $_)} })
}
function Get-ObservedProcesses([int]$NodePid) {
  $all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  $wanted=New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$wanted.Add($NodePid)
  $changed=$true
  while($changed) {
    $changed=$false
    foreach($process in $all) {
      if ($wanted.Contains([int]$process.ParentProcessId) -and $wanted.Add([int]$process.ProcessId)) { $changed=$true }
    }
  }
  return @($all | Where-Object { $wanted.Contains([int]$_.ProcessId) } | ForEach-Object {
    $imagePath=$_.ExecutablePath
    if (-not $imagePath) { try { $imagePath=(Get-Process -Id $_.ProcessId -ErrorAction Stop).Path } catch {} }
    $imageHash=$null
    if ($imagePath -ieq 'C:\Windows\System32\conhost.exe') { $imageHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $imagePath).Hash.ToLowerInvariant() }
    [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;creationDate=[string]$_.CreationDate;executablePath=$imagePath;imageSha256=$imageHash;consoleCommandLine=if($_.Name -eq 'conhost.exe'){$_.CommandLine}else{$null}}
  })
}
function Save-ProcessObservation($Row) {
  $key="$($Row.pid)|$($Row.creationDate)"
  $prior=$observedProcesses[$key]
  # A late CIM sample during exit may lose image access. Retain earlier measured
  # identity only for the same PID/creation time, never infer it from the name.
  if ($prior -and $Row.creationDate -and $prior.parentPid -eq $Row.parentPid -and $prior.name -eq $Row.name -and -not $Row.executablePath) {
    $Row.executablePath=$prior.executablePath;$Row.imageSha256=$prior.imageSha256
  }
  if ($prior -and $Row.creationDate -and $prior.parentPid -eq $Row.parentPid -and $prior.name -eq $Row.name -and -not $Row.consoleCommandLine) { $Row.consoleCommandLine=$prior.consoleCommandLine }
  $observedProcesses[$key]=$Row
}

$forbiddenBefore=Get-ForbiddenRoots
New-Item -ItemType Directory -Path $workRoot | Out-Null
foreach($file in $manifest.files) {
  $source=[IO.Path]::GetFullPath((Join-Path $inputRoot $file.relativePath))
  $target=[IO.Path]::GetFullPath((Join-Path $workRoot $file.relativePath))
  if (-not $source.StartsWith(([IO.Path]::GetFullPath($inputRoot)+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Input path escaped root.' }
  if (-not $target.StartsWith(([IO.Path]::GetFullPath($workRoot)+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Target path escaped root.' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Package file mismatch: $($file.relativePath)" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}
$control=Join-Path $workRoot 'control'
New-Item -ItemType Directory -Path $control | Out-Null
. (Join-Path $workRoot 'runtime-preflight\observation.ps1')
$consolePath='C:\Windows\System32\conhost.exe'
$consoleSignature=Get-AuthenticodeSignature -LiteralPath $consolePath
$consoleIdentity=[pscustomobject]@{path=$consolePath;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $consolePath).Hash.ToLowerInvariant();signatureStatus=[string]$consoleSignature.Status;signer=$consoleSignature.SignerCertificate.Subject}

$nodePath=Join-Path $workRoot 'runtime\node.exe'
$codexPath=Join-Path $workRoot 'runtime\codex.exe'
$driverPath=Join-Path $workRoot 'runtime-preflight\driver.mjs'
$expectationsPath=Join-Path $workRoot 'runtime-preflight\expectations.json'
$driverResult=Join-Path $workRoot 'runtime-preflight-result.json'
$psi=[Diagnostics.ProcessStartInfo]::new()
$psi.FileName=$nodePath
$psi.WorkingDirectory='C:\M11\work\project'
$psi.UseShellExecute=$false
$psi.CreateNoWindow=$true
$psi.RedirectStandardOutput=$true
$psi.RedirectStandardError=$true
$psi.Arguments=('"{0}" "{1}" "{2}" "{3}" "{4}"' -f $driverPath,$codexPath,$expectationsPath,$driverResult,$control)
$psi.EnvironmentVariables.Clear()
$cleanEnv=[ordered]@{
  SystemRoot='C:\Windows';WINDIR='C:\Windows';SystemDrive='C:';COMSPEC='C:\Windows\System32\cmd.exe';
  PATH='C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0';PATHEXT='.COM;.EXE;.BAT;.CMD';
  USERNAME='WDAGUtilityAccount';USERPROFILE='C:\Users\WDAGUtilityAccount';APPDATA='C:\Users\WDAGUtilityAccount\AppData\Roaming';
  LOCALAPPDATA='C:\Users\WDAGUtilityAccount\AppData\Local';TEMP='C:\M11\work\tmp';TMP='C:\M11\work\tmp';
  CODEX_HOME='C:\M11\work\codex';CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED='1'
}
foreach($entry in $cleanEnv.GetEnumerator()) { $psi.EnvironmentVariables[$entry.Key]=$entry.Value }
foreach($dir in @($cleanEnv.TEMP,$cleanEnv.CODEX_HOME,'C:\M11\work\state','C:\M11\work\logs')) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Copy-Item -LiteralPath (Join-Path $workRoot 'frozen\config.toml') -Destination (Join-Path $cleanEnv.CODEX_HOME 'config.toml')
Copy-Item -LiteralPath (Join-Path $workRoot 'frozen\model-catalog.json') -Destination (Join-Path $cleanEnv.CODEX_HOME 'model-catalog.json')
$before=Get-RelativeSnapshot $workRoot

$observedProcesses=@{}
$networkRows=@{}
$networkApiAvailable=$null -ne (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)
$observerStages=New-Object 'System.Collections.Generic.List[string]'
$process=[Diagnostics.Process]::new();$process.StartInfo=$psi
if (-not $process.Start()) { throw 'Node observer process did not start.' }
$spawnedPath=Join-Path $control 'spawned.json';$barrierPath=Join-Path $control 'barrier.json'
$observerReady=Join-Path $control 'observer-ready';$barrierObserved=Join-Path $control 'barrier-observed'
while(-not $process.HasExited) {
  if ((Test-Path -LiteralPath $spawnedPath) -and -not (Test-Path -LiteralPath $observerReady)) {
    foreach($row in Get-ObservedProcesses $process.Id) { Save-ProcessObservation $row }
    [IO.File]::WriteAllText($observerReady,"observed`n",[Text.UTF8Encoding]::new($false));$observerStages.Add('SPAWNED')
  }
  if ((Test-Path -LiteralPath $barrierPath) -and -not (Test-Path -LiteralPath $barrierObserved)) {
    foreach($row in Get-ObservedProcesses $process.Id) { Save-ProcessObservation $row }
    [IO.File]::WriteAllText($barrierObserved,"observed`n",[Text.UTF8Encoding]::new($false));$observerStages.Add('RPC_BARRIER')
  }
  $current=@(Get-ObservedProcesses $process.Id)
  foreach($row in $current) { Save-ProcessObservation $row }
  if ($networkApiAvailable) {
    $pids=@($current | ForEach-Object {$_.pid})
    foreach($connection in @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$pids -contains $_.OwningProcess})) {
      $key="$($connection.OwningProcess)|$($connection.LocalAddress)|$($connection.LocalPort)|$($connection.RemoteAddress)|$($connection.RemotePort)|$($connection.State)"
      $networkRows[$key]=[pscustomobject]@{protocol='tcp';pid=[int]$connection.OwningProcess;localAddress=$connection.LocalAddress;localPort=$connection.LocalPort;remoteAddress=$connection.RemoteAddress;remotePort=$connection.RemotePort;state="$($connection.State)"}
    }
    foreach($endpoint in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object {$pids -contains $_.OwningProcess})) {
      $key="udp|$($endpoint.OwningProcess)|$($endpoint.LocalAddress)|$($endpoint.LocalPort)"
      $networkRows[$key]=[pscustomobject]@{protocol='udp';pid=[int]$endpoint.OwningProcess;localAddress=$endpoint.LocalAddress;localPort=$endpoint.LocalPort;remoteAddress=$null;remotePort=$null;state='BOUND'}
    }
  }
  Start-Sleep -Milliseconds 50
}
$process.WaitForExit()
$nodeStdout=$process.StandardOutput.ReadToEnd();$nodeStderr=$process.StandardError.ReadToEnd();$nodeExit=$process.ExitCode
if (-not (Test-Path -LiteralPath $driverResult)) { throw "Driver result missing (exit $nodeExit)." }
$driver=Get-Content -Raw -LiteralPath $driverResult | ConvertFrom-Json
$after=Get-RelativeSnapshot $workRoot
$beforeByPath=@{};foreach($row in $before){$beforeByPath[$row.path]=$row}
$writes=@($after | Where-Object {-not $beforeByPath.ContainsKey($_.path) -or $beforeByPath[$_.path].sha256 -ne $_.sha256} | ForEach-Object {
  [pscustomobject]@{path=$_.path;size=$_.size;sha256=$_.sha256;classification=(Get-WriteClassification $_.path)}
})
$forbiddenAfter=Get-ForbiddenRoots
$forbiddenCreated=@($forbiddenAfter | Where-Object {$_.exists -and -not ($forbiddenBefore | Where-Object {$_.path -eq $_.path}).exists})
$processRows=@($observedProcesses.Values | Sort-Object pid)
$launch=Get-Content -Raw -LiteralPath $spawnedPath | ConvertFrom-Json
foreach($row in $processRows) { $row | Add-Member -NotePropertyName classification -NotePropertyValue (Get-ProcessClassification $row $launch $consoleIdentity) }
$unexpectedProcesses=@($processRows | Where-Object {$_.classification -eq 'UNEXPECTED'})
$consoleDuplicates=@($processRows | Where-Object {$_.classification -eq 'EXPECTED_OS_INFRASTRUCTURE'} | Group-Object parentPid | Where-Object {$_.Count -gt 1})
$driverLifecycle=Get-DriverLifecycle $nodeExit $driver ($observerStages.Contains('RPC_BARRIER'))
$network=@($networkRows.Values)
$externalNetwork=@($network | Where-Object {
  $_.remoteAddress -and $_.remoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::')
})
$checks=[ordered]@{
  manifestAndFilesVerified=$true;observerSawSpawned=$observerStages.Contains('SPAWNED');observerSawRpcBarrier=$observerStages.Contains('RPC_BARRIER');
  exactProcessTree=($launch.nodePid -eq $process.Id -and $unexpectedProcesses.Count -eq 0 -and $consoleDuplicates.Count -eq 0 -and @($processRows | Where-Object {$_.classification -eq 'EXPECTED_RUNTIME_PROCESS'}).Count -eq 2);
  noExternalConnections=($externalNetwork.Count -eq 0);noForbiddenRootsCreated=($forbiddenCreated.Count -eq 0);
  driverPassed=($driver.passed -eq $true);nodeExitedCleanly=($driverLifecycle -eq 'COMPLETED_PASS');driverLifecycleCompleted=($driverLifecycle -ne 'ABNORMAL_OR_INCOMPLETE');noUnexpectedWrites=(@($writes | Where-Object classification -eq 'UNEXPECTED').Count -eq 0);noModelRequest=($driver.modelRequests -eq 0 -and $driver.turnStartRequests -eq 0)
}
$passed=@($checks.Values | Where-Object {$_ -ne $true}).Count -eq 0
$receipt=[ordered]@{
  schemaVersion='m11.codex.runtime-preflight.v1';receiptKind='GUEST_DYNAMIC_STARTUP_PREFLIGHT';gateB=if($passed){'DYNAMIC_PREFLIGHT_PASS_PENDING_HOST_ADMISSION'}else{'DYNAMIC_PREFLIGHT_FAIL'};
  safeForLoopbackCapture=$false;runtimeCaptureAuthorized=$false;account=[Environment]::UserName;profile=$env:USERPROFILE;
  package=[ordered]@{manifestSha256=$ExpectedManifestHash;fileCount=$manifest.files.Count;codexSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $codexPath).Hash.ToLowerInvariant()};
  checks=$checks;driver=$driver;driverLifecycle=$driverLifecycle;nodeExitCode=$nodeExit;consoleIdentity=$consoleIdentity;
  processObservation=[ordered]@{stages=@($observerStages);processes=$processRows;unexpected=$unexpectedProcesses;nodeStdoutBytes=[Text.Encoding]::UTF8.GetByteCount($nodeStdout);nodeStderrBytes=[Text.Encoding]::UTF8.GetByteCount($nodeStderr);nodeStderrSha256=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($nodeStderr))).Replace('-','').ToLowerInvariant())};
  networkObservation=[ordered]@{apiAvailable=$networkApiAvailable;connections=$network;externalConnections=$externalNetwork;activeAdapters=@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up').Count;ipv4DefaultRoutes=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue).Count};
  filesystemObservation=[ordered]@{writes=$writes;forbiddenBefore=$forbiddenBefore;forbiddenAfter=$forbiddenAfter;forbiddenCreated=$forbiddenCreated};
  runtimeAdmission='NOT_EVALUATED_BY_GUEST';modelRequests=0;turnStartRequests=0;rawConfigsPersisted=$false;rawRequestsPersisted=$false;
  blockers=if($passed){@('HOST_RUNTIME_ADMISSION_EVALUATION_REQUIRED','MODEL_REQUEST_NOT_AUTHORIZED')}else{@('DYNAMIC_RUNTIME_PREFLIGHT_FAILED','MODEL_REQUEST_NOT_AUTHORIZED')}
}
$json=$receipt|ConvertTo-Json -Depth 16
$stream=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false));$writer.Write($json);$writer.Write("`n");$writer.Flush()}finally{$writer.Dispose()}
if(-not $passed){throw 'Dynamic runtime preflight failed; inspect metadata-only receipt.'}
