// Entirely synthetic. No real request, prompt, credentials or tool arguments.
export const fn = name => ({type:"function", name, strict:false, parameters:{type:"object", properties:{}}});
export const custom = {type:"custom", name:"grammar", format:{type:"grammar", syntax:"lark", definition:'start: "ok"'}};
export const fixtures = {
  top:{tools:[fn("alpha"), fn("beta"), fn("gamma")]},
  additional:{input:[{type:"additional_tools", role:"developer", tools:[fn("alpha")]}]},
  search:{input:[{type:"tool_search_output", call_id:"synthetic-call", status:"completed", execution:"client", tools:[fn("beta")]}]},
  combined:{tools:[fn("alpha")], input:[{type:"additional_tools", role:"developer", tools:[fn("beta")]},
    {type:"tool_search_output", call_id:"synthetic-call", status:"completed", execution:"client", tools:[fn("gamma")]}]},
  namespace:{tools:[{type:"namespace", name:"fixture", tools:[fn("alpha"), custom]}]},
  custom:{tools:[custom]},
  duplicate:{tools:[fn("alpha")], input:[{type:"additional_tools", role:"developer", tools:[fn("alpha")]}]},
  codeMode:{tools:[{...custom, name:"exec", description:"declare namespace tools { function alpha(input: {secret: string}): void; }"}]},
  empty:{tools:[], input:[]}, missing:{input:[]}, malformed:{tools:{}}, unknown:{tools:[{type:"unrecognized_tool", name:"alpha", schema:{}}]},
  prompt:{tools:[fn("alpha")], instructions:"SYNTHETIC_PROMPT_MARKER",
    input:[{type:"message", role:"user", content:[{type:"input_text", text:"SYNTHETIC_CONVERSATION_MARKER"}]}]},
};
export const authHeaders = {aUtHoRiZaTiOn:"SYNTHETIC_AUTH_SECRET", "Proxy-Authorization":"SYNTHETIC_PROXY_SECRET",
  Cookie:"SYNTHETIC_COOKIE_SECRET", "Set-Cookie":"SYNTHETIC_SET_COOKIE_SECRET", "X-Api-Key":"SYNTHETIC_API_SECRET",
  "X-Provider-Token":"SYNTHETIC_TOKEN_SECRET", "Unexpected-Provider-Credential":"SYNTHETIC_UNKNOWN_SECRET"};
export const oversizedRequest = () => JSON.stringify({instructions:"x".repeat(262145)});
