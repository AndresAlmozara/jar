import { createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto';

export const CHATGPT_AUTHORIZE_URL='https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL='https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_ISSUER='https://auth.openai.com';
export const CHATGPT_RESOURCE='https://api.openai.com/v1';
export const CHATGPT_SCOPES=Object.freeze(['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct']);
export const DYNAMIC_CLIENT_ID='dynamic_agent_client';
export const PLAN_SCOPE='chatgpt.tokens.use.direct';
export const isIssuedClientId=value=>typeof value==='string'&&value!==DYNAMIC_CLIENT_ID&&/^[A-Za-z0-9._~-]{8,256}$/.test(value);
export const issuedClientIdClass=value=>typeof value!=='string'||!value?'absent':value.startsWith('oaiapp_')?'oaiapp':'other';

export class ChatGptAuthError extends Error {
  constructor(code,{terminal=false,cause,diagnostics=null}={}){super(code,{cause});this.name='ChatGptAuthError';this.code=code;this.terminal=terminal;
    if(diagnostics)this.diagnostics=diagnostics;}
}
const fail=(code,options)=>{throw new ChatGptAuthError(code,options)};
const b64url=bytes=>Buffer.from(bytes).toString('base64url');

export function createAuthorizationSecrets({random=randomBytes}={}){
  const state=b64url(random(32)),nonce=b64url(random(32)),codeVerifier=b64url(random(64));
  return {state,nonce,codeVerifier,codeChallenge:b64url(createHash('sha256').update(codeVerifier).digest()),consumed:false};
}

export function authorizationUrl({secrets,redirectUri,hostId,issuedClientId=null,appName='jar'}){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri))fail('CALLBACK_URI_INVALID');
  const initial=!issuedClientId,clientId=issuedClientId??DYNAMIC_CLIENT_ID;
  const url=new URL(CHATGPT_AUTHORIZE_URL),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,
    scope:CHATGPT_SCOPES.join(' '),resource:CHATGPT_RESOURCE,state:secrets.state,nonce:secrets.nonce,
    code_challenge_method:'S256',code_challenge:secrets.codeChallenge,ext_agent_host_id:hostId};
  if(initial)params.agent_name_hint=appName;
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  return url.toString();
}

function sameValue(actual,expected){
  if(typeof actual!=='string'||typeof expected!=='string')return false;
  const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
}

export function consumeAuthorizationCallback(input,{secrets,issuedClientId=null}={}){
  if(secrets.consumed)fail('DUPLICATE_CALLBACK');
  secrets.consumed=true;
  const params=input instanceof URLSearchParams?input:new URL(input).searchParams;
  if(!sameValue(params.get('state'),secrets.state))fail('OAUTH_STATE_MISMATCH');
  if(params.get('error'))fail('OAUTH_AUTHORIZATION_REJECTED');
  const code=params.get('code');if(!code)fail('OAUTH_CODE_MISSING');
  const callbackClient=params.get('client_id');
  let clientId=issuedClientId;
  if(!issuedClientId){
    if(!isIssuedClientId(callbackClient))fail('REGISTRATION_INCOMPLETE');
    clientId=callbackClient;
  }else if(callbackClient&&callbackClient!==issuedClientId)fail('UNEXPECTED_CLIENT_ID');
  return {code,issuedClientId:clientId,callbackIssuedClientIdPresent:typeof callbackClient==='string'&&callbackClient.length>0,
    callbackIssuedClientIdClass:issuedClientIdClass(callbackClient)};
}

async function safeJson(response){try{return await response.json();}catch{return {};}}
export async function exchangeAuthorizationCode({code,issuedClientId,codeVerifier,redirectUri,fetchImpl=globalThis.fetch}){
  const body=new URLSearchParams({grant_type:'authorization_code',client_id:issuedClientId,code,code_verifier:codeVerifier,
    redirect_uri:redirectUri,resource:CHATGPT_RESOURCE});
  let response;try{response=await fetchImpl(CHATGPT_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});}
  catch(cause){fail('OAUTH_TOKEN_NETWORK_FAILURE',{cause});}
  if(!response.ok){const data=await safeJson(response);fail(data.error==='invalid_grant'?'OAUTH_CODE_INVALID':'OAUTH_TOKEN_EXCHANGE_FAILED');}
  return safeJson(response);
}

function decodePart(value,code){try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail(code);}}
function decodeJwt(idToken){
  if(typeof idToken!=='string'||!idToken)fail('ID_TOKEN_MISSING');const parts=idToken.split('.');if(parts.length!==3)fail('ID_TOKEN_INVALID');
  return {header:decodePart(parts[0],'ID_TOKEN_INVALID'),claims:decodePart(parts[1],'ID_TOKEN_INVALID'),
    signed:Buffer.from(`${parts[0]}.${parts[1]}`),signature:Buffer.from(parts[2],'base64url')};
}
async function loadJwks(fetchImpl){
  let discovery;try{discovery=await fetchImpl(`${CHATGPT_ISSUER}/.well-known/openid-configuration`);}catch(cause){fail('OIDC_DISCOVERY_FAILED',{cause});}
  if(!discovery.ok)fail('OIDC_DISCOVERY_FAILED');const metadata=await safeJson(discovery);
  if(metadata.issuer!==CHATGPT_ISSUER)fail('ID_TOKEN_ISSUER_MISMATCH');
  let uri;try{uri=new URL(metadata.jwks_uri);}catch{fail('OIDC_JWKS_URI_INVALID');}
  if(uri.protocol!=='https:'||uri.origin!==CHATGPT_ISSUER)fail('OIDC_JWKS_URI_INVALID');
  let response;try{response=await fetchImpl(uri);}catch(cause){fail('OIDC_JWKS_FAILED',{cause});}
  if(!response.ok)fail('OIDC_JWKS_FAILED');return safeJson(response);
}

function audienceMatches(claims,issuedClientId){
  if(typeof claims.aud==='string')return sameValue(claims.aud,issuedClientId);
  if(!Array.isArray(claims.aud)||claims.aud.length===0||claims.aud.some(value=>typeof value!=='string'))return false;
  if(!claims.aud.some(value=>sameValue(value,issuedClientId)))return false;
  return claims.aud.length===1||sameValue(claims.azp,issuedClientId);
}

export async function validateIdToken({idToken,issuedClientId,nonce,fetchImpl=globalThis.fetch,jwks=null,now=()=>Date.now()}={}){
  const decoded=decodeJwt(idToken);
  if(decoded.header.alg!=='RS256'||typeof decoded.header.kid!=='string')fail('ID_TOKEN_ALGORITHM_REJECTED');
  const set=jwks??await loadJwks(fetchImpl),key=set?.keys?.find(item=>item.kid===decoded.header.kid&&item.kty==='RSA');
  if(!key)fail('ID_TOKEN_SIGNING_KEY_NOT_FOUND');
  let cryptoKey,valid=false;try{
    cryptoKey=await webcrypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    valid=await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5',cryptoKey,decoded.signature,decoded.signed);
  }catch{fail('ID_TOKEN_INVALID_SIGNATURE');}
  if(!valid)fail('ID_TOKEN_INVALID_SIGNATURE');
  const claims=decoded.claims,current=Math.floor(now()/1000);
  if(claims.iss!==CHATGPT_ISSUER)fail('ID_TOKEN_ISSUER_MISMATCH');
  if(!audienceMatches(claims,issuedClientId))fail('ID_TOKEN_AUDIENCE_MISMATCH',{diagnostics:{idTokenAudienceMatchesIssuedClient:false}});
  if(!Number.isInteger(claims.exp)||claims.exp<=current)fail('ID_TOKEN_EXPIRED');
  if(!sameValue(claims.nonce,nonce))fail('ID_TOKEN_NONCE_MISMATCH');
  if(typeof claims.sub!=='string'||!claims.sub)fail('ID_TOKEN_SUBJECT_MISSING');
  return {subject:claims.sub,issuer:claims.iss,expiration:claims.exp};
}

export function validateTokenResponse(data,{requirePlanPermission=true}={}){
  if(!data||typeof data!=='object'||typeof data.access_token!=='string'||!data.access_token||typeof data.id_token!=='string'||!data.id_token)
    fail('TOKEN_RESPONSE_INVALID');
  const scopes=new Set(typeof data.scope==='string'?data.scope.split(/\s+/).filter(Boolean):[]);
  if(scopes.has('offline_access')&&(!data.refresh_token||typeof data.refresh_token!=='string'))fail('REFRESH_TOKEN_MISSING');
  if(!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=0)fail('TOKEN_RESPONSE_INVALID');
  if(requirePlanPermission&&!scopes.has(PLAN_SCOPE))fail('CHATGPT_PLAN_PERMISSION_NOT_GRANTED');
  return {scopes:[...scopes].sort(),planPermission:scopes.has(PLAN_SCOPE)};
}

export async function refreshTokenRequest({issuedClientId,refreshToken,fetchImpl=globalThis.fetch}){
  const body=new URLSearchParams({grant_type:'refresh_token',client_id:issuedClientId,refresh_token:refreshToken,resource:CHATGPT_RESOURCE});
  let response;try{response=await fetchImpl(CHATGPT_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});}
  catch(cause){fail('AUTH_REFRESH_TEMPORARY_FAILURE',{cause});}
  if(!response.ok){const data=await safeJson(response);if(data.error==='invalid_grant')fail('REAUTHORIZATION_REQUIRED',{terminal:true});
    fail(response.status>=500?'AUTH_REFRESH_TEMPORARY_FAILURE':'AUTH_REFRESH_FAILED');}
  return safeJson(response);
}
