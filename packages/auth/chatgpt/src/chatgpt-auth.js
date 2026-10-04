import http from 'node:http';
import { spawn } from 'node:child_process';
import { ChatGptCredentialStore } from './storage.js';
import { ChatGptAuthError, createAuthorizationSecrets, authorizationUrl, consumeAuthorizationCallback,
  exchangeAuthorizationCode, validateIdToken, validateTokenResponse, refreshTokenRequest, PLAN_SCOPE } from './oauth.js';

const toMillis=value=>{if(value==null)return null;const n=Number(value);if(Number.isFinite(n))return n>1e12?n:n*1000;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;};
const profileState=(profile,now,minimumValidityMs=120000)=>{
  if(!profile?.accessToken)return 'reauthorization_required';
  if(Number(profile.accessExpiresAt)>now+minimumValidityMs)return 'valid';
  return profile.refreshToken?'refresh_required':'reauthorization_required';
};
export function safeAuthStatus(profile,{now=Date.now()}={}){
  const tokenState=profileState(profile,now),authenticated=tokenState!=='reauthorization_required';
  return {authenticated,planPermission:authenticated&&Array.isArray(profile?.scopes)&&profile.scopes.includes(PLAN_SCOPE),tokenState,
    issuedClientPresent:typeof profile?.issuedClientId==='string'&&profile.issuedClientId.length>0};
}
export function runtimeAuthFromStatus(status){
  const ready=status.authenticated&&status.planPermission&&['valid','refresh_required'].includes(status.tokenState);
  return {authMode:'jar_owned_chatgpt_oauth',envKey:'JAR_ACCESS_TOKEN',credentialPresent:ready,
    authState:status.tokenState,planPermission:status.planPermission,issuedClientPresent:status.issuedClientPresent,
    credentialPersistedInRepo:false,credentialPersistedByJar:status.authenticated,providerAccessVerified:status.planPermission};
}

export function openSystemBrowser(url,{spawnProcess=spawn}={}){
  if(process.platform!=='win32')throw new ChatGptAuthError('BROWSER_OPEN_UNSUPPORTED');
  const child=spawnProcess('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,detached:true,shell:false,stdio:'ignore'});child.unref();
}

async function callbackListener(secrets,{timeoutMs=180000,createServer=http.createServer,issuedClientId=null}={}){
  let settle,settled=false;const result=new Promise((resolve,reject)=>{settle={resolve,reject};});
  const server=createServer((request,response)=>{
    if(request.method!=='GET'||!request.url?.startsWith('/auth/callback')){response.writeHead(404).end();return;}
    try{const value=consumeAuthorizationCallback(new URL(request.url,'http://127.0.0.1').searchParams,{secrets,issuedClientId});
      response.writeHead(200,{'content-type':'text/plain; charset=utf-8'}).end('Authorization received. You may close this window.');settled=true;settle.resolve(value);
    }catch(error){response.writeHead(400,{'content-type':'text/plain; charset=utf-8'}).end('Authorization rejected. Return to JAR.');settled=true;settle.reject(error);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(),redirectUri=`http://127.0.0.1:${address.port}/auth/callback`;
  const timer=setTimeout(()=>{if(!settled)settle.reject(new ChatGptAuthError('OAUTH_ATTEMPT_EXPIRED'));},timeoutMs);
  return {redirectUri,wait:async()=>{try{return await result;}finally{clearTimeout(timer);await new Promise(resolve=>server.close(resolve));}}};
}

export class ChatGptAuthService {
  constructor({store=new ChatGptCredentialStore(),fetchImpl=globalThis.fetch,openBrowser=openSystemBrowser,now=()=>Date.now(),listener=callbackListener}={}){
    this.store=store;this.fetchImpl=fetchImpl;this.openBrowser=openBrowser;this.now=now;this.listener=listener;
  }
  async status(){return safeAuthStatus(await this.store.readProfile(),{now:this.now()});}
  async signIn(){
    return this.store.withLock(async()=>{
      const hostId=await this.store.ensureHostId(),previous=await this.store.readProfile(),secrets=createAuthorizationSecrets(),
        diagnostics={registrationMode:previous?.issuedClientId?'returning':'initial',callbackIssuedClientIdPresent:false,
          callbackIssuedClientIdClass:'absent',tokenExchangeClientIdMatchesCallback:false,idTokenPresent:false,
          idTokenAudienceMatchesIssuedClient:false,accessTokenPresent:false};
      try{
        const pending=await this.listener(secrets,{issuedClientId:previous?.issuedClientId??null}),url=authorizationUrl({secrets,redirectUri:pending.redirectUri,hostId,
          issuedClientId:previous?.issuedClientId??null,appName:'jar'});
        this.openBrowser(url);const callback=await pending.wait();
        diagnostics.callbackIssuedClientIdPresent=callback.callbackIssuedClientIdPresent??diagnostics.registrationMode==='initial';
        diagnostics.callbackIssuedClientIdClass=callback.callbackIssuedClientIdClass??(diagnostics.callbackIssuedClientIdPresent?(callback.issuedClientId?.startsWith('oaiapp_')?'oaiapp':'other'):'absent');
        if(previous?.issuedClientId&&callback.issuedClientId!==previous.issuedClientId)throw new ChatGptAuthError('UNEXPECTED_CLIENT_ID');
        const exchangeClientId=callback.issuedClientId;
        diagnostics.tokenExchangeClientIdMatchesCallback=diagnostics.callbackIssuedClientIdPresent&&exchangeClientId===callback.issuedClientId;
        const tokenResponse=await exchangeAuthorizationCode({code:callback.code,issuedClientId:exchangeClientId,codeVerifier:secrets.codeVerifier,
          redirectUri:pending.redirectUri,fetchImpl:this.fetchImpl});
        const accessToken=tokenResponse.access_token,idToken=tokenResponse.id_token,refreshToken=tokenResponse.refresh_token??null;
        diagnostics.accessTokenPresent=typeof accessToken==='string'&&accessToken.length>0;
        diagnostics.idTokenPresent=typeof idToken==='string'&&idToken.length>0;
        const tokenMeta=validateTokenResponse(tokenResponse,{requirePlanPermission:true});
        const identity=await validateIdToken({idToken,issuedClientId:exchangeClientId,nonce:secrets.nonce,fetchImpl:this.fetchImpl,now:this.now});
        diagnostics.idTokenAudienceMatchesIssuedClient=true;
        if(previous?.subject&&previous.subject!==identity.subject)throw new ChatGptAuthError('ACCOUNT_IDENTITY_CHANGED');
        const savedAt=this.now(),profile={schemaVersion:1,extAgentHostId:hostId,issuedClientId:exchangeClientId,subject:identity.subject,
          issuer:identity.issuer,accessToken,refreshToken,idToken,
          scopes:tokenMeta.scopes,accessExpiresAt:savedAt+Number(tokenResponse.expires_in)*1000,earliestRefreshAt:toMillis(tokenResponse.earliest_refresh_at),
          createdAt:previous?.createdAt??new Date(savedAt).toISOString(),updatedAt:new Date(savedAt).toISOString()};
        await this.store.writeProfile(profile);
        return safeAuthStatus(profile,{now:savedAt});
      }catch(error){
        if(error instanceof ChatGptAuthError)error.diagnostics={...diagnostics,...error.diagnostics};
        throw error;
      }
    },{timeoutMs:5000});
  }
  async logout(){
    return this.store.withLock(async()=>{const profile=await this.store.readProfile();if(!profile)return {authenticated:false,remoteRevocationConfirmed:false};
      await this.store.writeProfile({...profile,accessToken:null,refreshToken:null,idToken:null,scopes:[],accessExpiresAt:null,
        earliestRefreshAt:null,updatedAt:new Date(this.now()).toISOString()});return {authenticated:false,remoteRevocationConfirmed:false};});
  }
  async usableAccessToken({minimumValidityMs=120000}={}){
    if(!Number.isSafeInteger(minimumValidityMs)||minimumValidityMs<120000||minimumValidityMs>3600000)throw new ChatGptAuthError('AUTH_VALIDITY_WINDOW_INVALID');
    return this.store.withLock(async()=>{
      let profile=await this.store.readProfile();if(!profile)throw new ChatGptAuthError('REAUTHORIZATION_REQUIRED',{terminal:true});
      const state=profileState(profile,this.now(),minimumValidityMs);if(state==='valid')return profile.accessToken;
      if(state==='reauthorization_required')throw new ChatGptAuthError('REAUTHORIZATION_REQUIRED',{terminal:true});
      if(profile.earliestRefreshAt&&this.now()<profile.earliestRefreshAt){
        if(minimumValidityMs===120000&&Number(profile.accessExpiresAt)>this.now())return profile.accessToken;
        throw new ChatGptAuthError('REFRESH_NOT_YET_ALLOWED',{diagnostics:{retryAfterMs:Math.ceil(profile.earliestRefreshAt-this.now())}});}
      let tokens;try{tokens=await refreshTokenRequest({issuedClientId:profile.issuedClientId,refreshToken:profile.refreshToken,fetchImpl:this.fetchImpl});}
      catch(error){if(error.terminal){profile={...profile,accessToken:null,refreshToken:null,idToken:null,accessExpiresAt:null,earliestRefreshAt:null,
          updatedAt:new Date(this.now()).toISOString()};await this.store.writeProfile(profile);}throw error;}
      const tokenMeta=validateTokenResponse({...tokens,id_token:profile.idToken},{requirePlanPermission:true});
      const savedAt=this.now(),rotated={...profile,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,
        idToken:profile.idToken,scopes:tokenMeta.scopes,accessExpiresAt:savedAt+Number(tokens.expires_in)*1000,
        earliestRefreshAt:toMillis(tokens.earliest_refresh_at),updatedAt:new Date(savedAt).toISOString()};
      await this.store.writeProfile(rotated);
      if(Number(rotated.accessExpiresAt)<=this.now()+minimumValidityMs)throw new ChatGptAuthError('AUTH_TOKEN_LIFETIME_INSUFFICIENT');
      return rotated.accessToken;
    });
  }
}
