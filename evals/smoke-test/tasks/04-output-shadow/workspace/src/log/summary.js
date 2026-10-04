export function summarize(lines){return {errorCode:lines.find(x=>x.includes('ERROR'))?.split(' ')[1]??null,retry:lines.find(x=>x.includes('retry='))?.split('retry=')[1]??null,artifact:null};}
