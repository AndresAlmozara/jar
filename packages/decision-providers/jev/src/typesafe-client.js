const DEFAULT_BASE_URL="https://api.typesafe.ai";
const DEFAULT_MODEL="jev-1.13.0";
const DEFAULT_TIMEOUT_MS=10000;

export class TypeSafeProviderError extends Error {
  constructor(code,message,{status=null,cause=null}={}) {
    super(message,{cause});
    this.name="TypeSafeProviderError";
    this.code=code;
    this.status=status;
  }
}

function errorForStatus(status) {
  if (status===401 || status===403) return ["authentication_failure","TypeSafe authentication failed"];
  if (status===402) return ["insufficient_balance","TypeSafe balance or quota is insufficient"];
  if (status===429) return ["rate_limit","TypeSafe rate limit exceeded"];
  if (status===400 || status===422) return ["validation_error","TypeSafe rejected the request"];
  if (status>=500) return ["server_failure","TypeSafe server request failed"];
  return ["http_failure",`TypeSafe request failed with status ${status}`];
}

function assertObject(value,label) {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new TypeSafeProviderError("unexpected_response",`TypeSafe returned an invalid ${label}`);
}

export class TypeSafeClient {
  constructor({apiKey=process.env.TYPESAFE_API_KEY,baseUrl=DEFAULT_BASE_URL,model=DEFAULT_MODEL,timeoutMs=DEFAULT_TIMEOUT_MS,fetchImpl=globalThis.fetch}={}) {
    this.apiKey=apiKey;
    this.baseUrl=baseUrl.replace(/\/$/,"");
    this.model=model;
    this.timeoutMs=timeoutMs;
    this.fetchImpl=fetchImpl;
  }

  async request(path,{method="GET",body,signal}={}) {
    if (!this.apiKey) throw new TypeSafeProviderError("missing_api_key","TYPESAFE_API_KEY is required");
    if (typeof this.fetchImpl!=="function") throw new TypeSafeProviderError("network_failure","Fetch is unavailable");
    const controller=new AbortController();
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;controller.abort()},this.timeoutMs);
    const abort=()=>controller.abort();
    signal?.addEventListener("abort",abort,{once:true});
    try {
      const response=await this.fetchImpl(`${this.baseUrl}${path}`,{
        method,
        headers:{Authorization:`Bearer ${this.apiKey}`,...(body?{"Content-Type":"application/json"}:{})},
        body:body?JSON.stringify(body):undefined,
        signal:controller.signal,
      });
      if (!response.ok) {
        const [code,message]=errorForStatus(response.status);
        throw new TypeSafeProviderError(code,message,{status:response.status});
      }
      try { return await response.json(); }
      catch (cause) { throw new TypeSafeProviderError("unexpected_response","TypeSafe returned invalid JSON",{cause}); }
    } catch (error) {
      if (error instanceof TypeSafeProviderError) throw error;
      if (timedOut) throw new TypeSafeProviderError("timeout","TypeSafe request timed out");
      if (signal?.aborted) throw new TypeSafeProviderError("cancelled","TypeSafe request was cancelled");
      throw new TypeSafeProviderError("network_failure","TypeSafe network request failed",{cause:error});
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort",abort);
    }
  }

  async listModels(options={}) {
    const data=await this.request("/v1/models",options);
    if (!data || !Array.isArray(data.models)) throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid model list");
    return data.models.map((item)=>{
      assertObject(item,"model entry");
      if (typeof item.name!=="string" || typeof item.description!=="string" || typeof item.release_date!=="string") throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid model entry");
      return {name:item.name,description:item.description,releaseDate:item.release_date};
    });
  }

  async systemOne({state,questions,model=this.model,signal}) {
    const data=await this.request("/v1/systemone",{method:"POST",body:{state,model,questions},signal});
    assertObject(data,"System One response");
    assertObject(data.answers,"System One answers");
    assertObject(data.usage,"System One usage");
    if (typeof data.model!=="string" || !Number.isInteger(data.usage.input_tokens) || !Number.isInteger(data.usage.output_tokens)) throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid System One response");
    return data;
  }
}

export const TYPESAFE_DEFAULTS={baseUrl:DEFAULT_BASE_URL,model:DEFAULT_MODEL,timeoutMs:DEFAULT_TIMEOUT_MS};
