function New-M11NetworkFailure([string]$Code,[string]$SafeMessage) {
  $exception=[InvalidOperationException]::new($SafeMessage)
  $exception.Data['M11Code']=$Code
  return $exception
}

function Get-M11CaptureNetworkBoundary {
  try { $adapters=@(Get-NetAdapter -ErrorAction Stop) }
  catch { throw (New-M11NetworkFailure 'NETWORK_ADAPTER_INVENTORY_UNAVAILABLE' 'Network adapter inventory is unavailable.') }

  try { $defaultRoutes=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop) }
  catch {
    if ($_.FullyQualifiedErrorId -eq 'CmdletizationQuery_NotFound,Get-NetRoute') { $defaultRoutes=@() }
    else { throw (New-M11NetworkFailure 'NETWORK_ROUTE_INVENTORY_UNAVAILABLE' 'IPv4 route inventory is unavailable.') }
  }

  $activeAdapterCount=@($adapters|Where-Object Status -eq 'Up').Count
  $defaultRouteCount=$defaultRoutes.Count
  if($activeAdapterCount -gt 0){throw (New-M11NetworkFailure 'ACTIVE_NETWORK_ADAPTER_PRESENT' 'An active network adapter is present.')}
  if($defaultRouteCount -gt 0){throw (New-M11NetworkFailure 'DEFAULT_IPV4_ROUTE_PRESENT' 'A default IPv4 route is present.')}
  return [pscustomobject]@{activeAdapterCount=$activeAdapterCount;defaultIpv4RouteCount=$defaultRouteCount}
}
