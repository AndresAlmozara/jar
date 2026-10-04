# Pure observation semantics, also exercised without launching Codex by regression tests.
function Get-ProcessClassification($Row, $Launch, $Identity) {
  if ($Row.name -eq 'node.exe' -and $Row.pid -eq $Launch.nodePid -and $Row.executablePath -ieq 'C:\M11\work\runtime\node.exe') { return 'EXPECTED_RUNTIME_PROCESS' }
  if ($Row.name -eq 'codex.exe' -and $Row.pid -eq $Launch.codexPid -and $Row.parentPid -eq $Launch.nodePid -and $Row.executablePath -ieq 'C:\M11\work\runtime\codex.exe') { return 'EXPECTED_RUNTIME_PROCESS' }
  if ($Row.name -eq 'conhost.exe' -and $Row.parentPid -in @($Launch.nodePid,$Launch.codexPid) -and
      $Row.executablePath -ieq 'C:\Windows\System32\conhost.exe' -and $Identity.signatureStatus -eq 'Valid' -and
      $Identity.signer -match '(^|, )CN=Microsoft Windows(,|$)' -and $Identity.sha256 -match '^[0-9a-f]{64}$' -and
      $Row.imageSha256 -eq $Identity.sha256 -and
      $Row.consoleCommandLine -match '^(?:"?(?:\\\?\?\\)?C:\\Windows\\System32\\conhost\.exe"?)\s+0x[0-9a-f]+(?:\s+-ForceV1)?\s*$') { return 'EXPECTED_OS_INFRASTRUCTURE' }
  return 'UNEXPECTED'
}
function Get-DriverLifecycle($ExitCode, $Driver, [bool]$BarrierObserved) {
  $reportComplete=$BarrierObserved -and $Driver.barrier -eq 'TWO_THREAD_START_RESPONSES_BEFORE_ANY_TURN_START' -and $null -ne $Driver.checks -and
    -not $Driver.failureCode -and $Driver.shutdown.graceful -eq $true -and $Driver.shutdown.exitCode -eq 0 -and $null -eq $Driver.shutdown.signal
  if ($reportComplete -and $Driver.passed -eq $true -and $ExitCode -eq 0) { return 'COMPLETED_PASS' }
  if ($reportComplete -and $Driver.passed -eq $false -and $ExitCode -eq 2) { return 'COMPLETED_VALIDATION_FAILURE' }
  return 'ABNORMAL_OR_INCOMPLETE'
}
function Get-WriteClassification([string]$Path) {
  if ($Path -in @('control\spawned.json','control\observer-ready','control\barrier.json','control\barrier-observed','runtime-preflight-result.json')) { return 'EXPECTED_OBSERVER_WRITE' }
  if ($Path -in @('codex\.sandbox_migration','codex\installation_id') -or $Path -match '^state\\(goals_1|logs_2|memories_1|queue_1|state_5)\.sqlite(-wal|-shm)?$') { return 'EXPECTED_RUNTIME_WRITE' }
  return 'UNEXPECTED'
}
