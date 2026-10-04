param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestHash,
    [switch]$LoopbackSelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# No Codex invocation, help/version probe, provider client or subprocess launcher.
# This is metadata preflight, not a replacement for entrypoint source/control proof.
if ($env:USERNAME -ne 'WDAGUtilityAccount' -or $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount') {
    throw 'Refusing non-Sandbox account/profile'
}
$inputRoot = 'C:\M11\input'
$outputRoot = 'C:\M11\output'
$manifestPath = Join-Path $inputRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) { throw 'Missing dedicated evidence output' }
foreach ($root in @('C:\M11', $inputRoot, $outputRoot)) {
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked experiment root' }
}
if ((Get-Item -LiteralPath $manifestPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked manifest' }
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedManifestHash) {
    throw 'Manifest fingerprint mismatch'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 'm11.staging-manifest.v1') { throw 'Unexpected staging schema' }
$requiredRoles = @('audited-codex-runtime','capture-harness-node','metadata-only-preflight','frozen-runtime-config','frozen-model-catalog','frozen-thread-inputs')
foreach ($role in $requiredRoles) {
    if (@($manifest.files | Where-Object role -eq $role).Count -ne 1) { throw ('Missing or duplicate staged role: ' + $role) }
}
$fileChecks = @()
$allowed = @($manifestPath)
foreach ($file in $manifest.files) {
    if ($file.relativePath -notmatch '^[a-zA-Z0-9_./-]+$' -or $file.relativePath -match '(^|/)\.\.(/|$)' -or $file.relativePath.StartsWith('/')) {
        throw 'Invalid manifest relative path'
    }
    $path = [IO.Path]::GetFullPath((Join-Path $inputRoot $file.relativePath))
    if (-not $path.StartsWith($inputRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Escaping staged path' }
    $ancestor = Split-Path -Parent $path
    while ($ancestor -ne $inputRoot) {
        if ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked staging ancestor' }
        $ancestor = Split-Path -Parent $ancestor
    }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid staged file' }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $file.sha256 -or $item.Length -ne $file.size) { throw 'Staged file fingerprint mismatch' }
    $fileChecks += [ordered]@{path=$file.relativePath; sha256=$actual; size=$item.Length; match=$true}
    $allowed += $path
}
# Inspect only owned staging; never recurse into normal host/user state.
$stagedItems = @(); $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($inputRoot)
while ($pending.Count -gt 0) {
    foreach ($item in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked staging entry' }
        $stagedItems += $item
        if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
    }
}
if (@($stagedItems | Where-Object { -not $_.PSIsContainer -and $_.FullName -notin $allowed }).Count) { throw 'Unexpected staged file' }
$codex = @($fileChecks | Where-Object { $_.path -eq 'runtime/codex.exe' })
if ($codex.Count -ne 1 -or $codex[0].sha256 -ne '8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49') {
    throw 'Audited Codex identity mismatch'
}
$dllChecks = @()
foreach ($identity in @($manifest.identities.codex, $manifest.identities.node)) {
    foreach ($dll in @($identity.imports) + @($identity.delayedImports)) {
        if ($dll -notmatch '^[a-z0-9_.-]+\.dll$') { throw 'Invalid dependency name' }
        $apiSet = $dll.StartsWith('api-ms-') -or $dll.StartsWith('ext-ms-')
        $dllChecks += [ordered]@{name=$dll; source='guest-system32'; exists=(Test-Path -LiteralPath (Join-Path $env:SystemRoot ('System32\' + $dll))); apiSetContract=$apiSet}
    }
}
$workRoot = 'C:\M11\work'
if (Test-Path -LiteralPath $workRoot) { throw 'Refusing pre-existing guest work root' }
foreach ($path in @($workRoot, ($workRoot + '\codex'), ($workRoot + '\project'), ($workRoot + '\inputs'),
    ($workRoot + '\state'), ($workRoot + '\logs'), ($workRoot + '\tmp'))) {
    [void](New-Item -ItemType Directory -Path $path)
}
$ownedCopies = @(
    @('frozen/config.toml', ($workRoot + '\codex\config.toml')),
    @('frozen/model-catalog.json', ($workRoot + '\codex\model-catalog.json')),
    @('frozen/thread-inputs.json', ($workRoot + '\inputs\thread-inputs.json')),
    @('project/package.json', ($workRoot + '\project\package.json'))
)
$ownedCopyChecks = @()
foreach ($copy in $ownedCopies) {
    $source = Join-Path $inputRoot $copy[0]; $target = $copy[1]
    Copy-Item -LiteralPath $source -Destination $target
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $targetHash) { throw 'Guest owned-copy fingerprint mismatch' }
    $ownedCopyChecks += [ordered]@{source=$copy[0]; target=$target; sha256=$targetHash; match=$true}
}
$roots = @()
$ownedHome = 'C:\M11\work\codex'
$project = 'C:\M11\work\project'
foreach ($entry in @(
    @($ownedHome, 'codex-home', $true), @($project, 'project', $true),
    @(($ownedHome + '\config.toml'), 'user-config', $true), @(($project + '\.codex\config.toml'), 'project-config', $true),
    @('C:\ProgramData\OpenAI\Codex\config.toml', 'system-config', $false),
    @('C:\ProgramData\OpenAI\Codex\requirements.toml', 'system-requirements', $false),
    @('C:\ProgramData\OpenAI\Codex\skills', 'system-skills', $false),
    @(($env:USERPROFILE + '\.agents\skills'), 'host-skills', $false),
    @(($env:USERPROFILE + '\.codex'), 'default-codex-home', $false),
    @('C:\.agents\skills', 'ancestor-skills', $false), @('C:\M11\.agents\skills', 'ancestor-skills', $false),
    @('C:\M11\work\.agents\skills', 'ancestor-skills', $false), @(($project + '\.agents\skills'), 'project-skills', $true),
    @(($ownedHome + '\plugins'), 'plugin-state', $true), @(($ownedHome + '\skills'), 'codex-skills', $true),
    @(($ownedHome + '\model-catalog.json'), 'model-catalog', $true)
)) {
    $roots += [ordered]@{path=$entry[0]; source=$entry[1]; exists=(Test-Path -LiteralPath $entry[0]);
        owned=[bool]$entry[2]; access='prospective-read-or-write-not-proven'; possibleContributor=$true; exhaustive=$false}
}
$authRoots = @()
foreach ($path in @(($ownedHome + '\auth.json'), ($ownedHome + '\auth'), ($env:USERPROFILE + '\.codex\auth.json'),
    ($env:USERPROFILE + '\.aws'), ($env:USERPROFILE + '\.azure'), ($env:USERPROFILE + '\.ssh'), ($env:USERPROFILE + '\.kube'))) {
    $authRoots += [ordered]@{path=$path; exists=(Test-Path -LiteralPath $path)}
}
# Names/presence only. Values are never serialized or logged.
$credentialEnvironmentNames = @(Get-ChildItem Env: | Where-Object {
    $_.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_)'
} | ForEach-Object { $_.Name })
$credentialCount = $null
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class M11CredentialPresence {
  [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Enumerate(string filter, uint flags, out uint count, out IntPtr credentials);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
    [uint32]$count = 0; $pointer = [IntPtr]::Zero
    try {
        if ([M11CredentialPresence]::Enumerate($null,0,[ref]$count,[ref]$pointer)) { $credentialCount = $count }
        elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { $credentialCount = 0 }
    } finally { if ($pointer -ne [IntPtr]::Zero) { [M11CredentialPresence]::CredFree($pointer) } }
} catch { $credentialCount = $null }
$network = [ordered]@{activeAdapters=$null; ipv4DefaultRoutes=$null; runtimePathsDisabled='UNKNOWN'}
try {
    $network.activeAdapters = @(Get-NetAdapter | Where-Object Status -eq 'Up').Count
    $network.ipv4DefaultRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object DestinationPrefix -eq '0.0.0.0/0').Count
} catch { }
$loopback = 'NOT_TESTED'
if ($LoopbackSelfTest) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $client = [Net.Sockets.TcpClient]::new(); $peer = $null
    try {
        $listener.Start(1)
        $accept = $listener.AcceptTcpClientAsync()
        if (-not $client.ConnectAsync('127.0.0.1', $listener.LocalEndpoint.Port).Wait(2000) -or -not $accept.Wait(2000)) { throw 'Loopback timeout' }
        $peer = $accept.Result
        $client.ReceiveTimeout = 2000; $client.SendTimeout = 2000; $peer.ReceiveTimeout = 2000; $peer.SendTimeout = 2000
        $client.GetStream().WriteByte(77)
        if ($peer.GetStream().ReadByte() -ne 77) { throw 'Loopback mismatch' }
        $loopback = 'VERIFIED_OWNED_TCP_ONLY'
    } catch { $loopback = 'FAIL' }
    finally { if ($peer) { $peer.Dispose() }; $client.Dispose(); $listener.Stop() }
}
$unexpected = @($roots | Where-Object { $_.exists -and -not $_.owned })
$requiredOwned = @($roots | Where-Object { $_.source -in @('codex-home','project','user-config','model-catalog') -and -not $_.exists })
$fail = $unexpected.Count -gt 0 -or $requiredOwned.Count -gt 0 -or @($authRoots | Where-Object exists).Count -gt 0 -or $credentialEnvironmentNames.Count -gt 0 -or
    @($dllChecks | Where-Object { -not $_.exists -and -not $_.apiSetContract }).Count -gt 0 -or
    ($null -ne $credentialCount -and $credentialCount -gt 0) -or $network.activeAdapters -gt 0 -or $network.ipv4DefaultRoutes -gt 0 -or $loopback -eq 'FAIL'
$receipt = [ordered]@{
    schemaVersion='m11.codex.entrypoint-preflight.v3'; receiptKind='GUEST_FROZEN_METADATA_PREFLIGHT'; gateB=$(if ($fail) {'BLOCKED'} else {'PREFLIGHT_PASS_PENDING_RUNTIME'});
    safeForLoopbackCapture=$false; trackA='VERIFIED_BOUNDARY_ONLY'; runtimeCaptureAuthorized=$false;
    account=$env:USERNAME; profile=$env:USERPROFILE; processArchitecture=$env:PROCESSOR_ARCHITECTURE;
    identity=[ordered]@{expectedVersion=$manifest.expectedCodexVersion; versionBasis='user-pinned hash; not executed'; files=$fileChecks; dependencies=$dllChecks; closure='UNKNOWN_DYNAMIC_HELPERS'};
    ownedCopies=$ownedCopyChecks; configSources=$roots; discoveryRoots=$roots; sourceInventoryExhaustive=$true;
    auth=[ordered]@{paths=$authRoots; credentialEnvironmentNames=$credentialEnvironmentNames; savedCredentialCount=$credentialCount};
    network=$network; loopback=$loopback; effectiveConfig='STATIC_HASH_BOUND_NOT_RUNTIME_RESOLVED'; providerFallback='SOURCE_EXCLUDED_NOT_RUNTIME_OBSERVED';
    writeRoots='OWNED_GUEST_PATHS_PREPARED'; contributorSet='SOURCE_CLOSED_GUEST_ROOTS_OBSERVED'; runtimeAdmission='NOT_EVALUATED';
    runtimeMetadataPolicy=[ordered]@{id=$manifest.runtimeMetadataPolicy.id; evidenceHash=$manifest.runtimeMetadataPolicy.evidenceHash; validation='FUTURE_CAPTURE_ONLY'};
    blockers=@('RUNTIME_PROCESS_AND_EFFECTIVE_CONFIG_EVIDENCE_MISSING', 'MODEL_REQUEST_NOT_AUTHORIZED');
    safetyGate=@(1..12 | ForEach-Object { [ordered]@{id=$_; state=$(if ($fail) {'BLOCKED'} else {'VERIFIED_CONDITIONALLY'}); evidence='source closure plus frozen guest metadata preflight'; conditionalControl='future runtime evidence'; remainingCaveat='No Codex process or model request executed'} });
    mappingAccess='ACCEPTED_BOUNDARY_REPORT_NOT_RETESTED'; codexLaunches=0; modelRequests=0
}
$output = Join-Path $outputRoot 'codex-entrypoint-preflight.json'
if (Test-Path -LiteralPath $output) { throw 'Refusing to overwrite existing evidence' }
$json = $receipt | ConvertTo-Json -Depth 20
$stream = [IO.File]::Open($output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
Write-Output ('Metadata receipt written; Gate B ' + $receipt.gateB + '; capture remains unauthorized.')
