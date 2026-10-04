// Metadata only. No environment, credential store, filesystem or network access.
const source = 'https://raw.githubusercontent.com/openai/codex/0d9c7cbfa6cf1489f55a8a9542b75ddd2c061807/codex-rs/';
export const AUTH_MODES = Object.freeze(['existing_codex_session', 'inherited_access_token', 'inherited_api_key']);

export function authBoundary(authMode = null) {
  if (authMode !== null && !AUTH_MODES.includes(authMode)) throw Error('AUTH_MODE_UNSUPPORTED');
  return {
    schemaVersion: 'jar.auth-boundary.v1', authMode, authState: 'UNKNOWN',
    credentialHandledByJar: false, credentialPersistedByJar: false,
    credentialInspectionPerformed: false, normalConfigMutations: 0,
    normalCodexHomeRequired: authMode === null ? null : authMode === 'existing_codex_session',
    configAuthSeparation: authMode === null ? 'not_selected' : authMode === 'existing_codex_session'
      ? 'cached_auth_namespace_bound_to_codex_home' : 'provider_env_key_supported_owned_home_possible',
    runtimeAuthSupport: authMode === null ? 'not_selected' : 'source_verified_not_exercised',
    appServerDynamicToolsSupported: true,
    hostDiscoveryExcluded: false,
    authSources: [
      { mode: 'existing_codex_session', source: 'runtime_managed_cache', jarMustReadSecret: false,
        jarPersistenceRequired: false, normalCodexHomeRequired: true, appServer: true, dynamicTools: true,
        inheritedConfigRisk: true, hostMutationRisk: 'runtime_state_and_managed_refresh',
        humanAction: 'approve_independent_config_and_state_boundary',
        evidence: source + 'login/src/auth/storage.rs' },
      { mode: 'inherited_access_token', source: 'externally_provisioned_process_environment', jarMustReadSecret: false,
        jarPersistenceRequired: false, normalCodexHomeRequired: false, appServer: true, dynamicTools: true,
        inheritedConfigRisk: 'owned_home_does_not_exclude_host_skill_provider', hostMutationRisk: 'owned_state_requires_review',
        humanAction: 'external_auth_owner_provisions_and_renews_without_jar_reading_values',
        evidence: source + 'model-provider-info/src/lib.rs' },
      { mode: 'explicit_user_token', source: 'client_supplied_rpc_token', selectable: false,
        jarMustReadSecret: true, jarPersistenceRequired: false, normalCodexHomeRequired: false,
        appServer: 'pinned_schema_internal_only_do_not_use', dynamicTools: true,
        inheritedConfigRisk: 'independent_of_auth', hostMutationRisk: 'not_exercised',
        humanAction: 'not_permitted_under_current_constraints',
        evidence: '.jar/overnight/live-readiness-20260930/protocol/v2/LoginAccountParams.json' },
      { mode: 'inherited_api_key', source: 'externally_provisioned_process_environment', jarMustReadSecret: false,
        jarPersistenceRequired: false, normalCodexHomeRequired: false, appServer: true, dynamicTools: true,
        inheritedConfigRisk: 'owned_home_does_not_exclude_host_skill_provider', hostMutationRisk: 'owned_state_requires_review',
        humanAction: 'external_owner_provisions_existing_key_no_key_creation_by_jar',
        evidence: source + 'model-provider-info/src/lib.rs' },
    ],
    evidence: {
      providerEnvironment: source + 'model-provider-info/src/lib.rs',
      authNamespace: source + 'login/src/auth/storage.rs',
      additiveTools: source + 'core/src/tools/spec_plan.rs',
      hostProvider: source + 'app-server/src/extensions.rs',
      oauthDocumentation: 'https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server',
    },
  };
}

// Validate intent before manifest I/O. This never grants authority to execute.
export function validateLiveIntent({ provider = 'offline', prepareOnly = false, executeLive = false, allowNetwork = false } = {}) {
  if ([prepareOnly, executeLive, allowNetwork].some(value => typeof value !== 'boolean')) throw Error('LIVE_BOUNDARY_FLAGS_INVALID');
  if (!['offline', 'live'].includes(provider)) throw Error('LIVE_BOUNDARY_PROVIDER_INVALID');
  if (prepareOnly && (executeLive || allowNetwork)) throw Error('LIVE_BOUNDARY_PREPARE_MUST_STAY_OFFLINE');
  if (allowNetwork && provider !== 'live') throw Error('LIVE_BOUNDARY_LIVE_PROVIDER_REQUIRED');
  if (!prepareOnly && !(provider === 'live' && executeLive && allowNetwork)) throw Error('LIVE_BOUNDARY_EXPLICIT_AUTHORIZATION_REQUIRED');
}
