import fs from 'node:fs';

export async function resolve(specifier,context,nextResolve){
  try{return await nextResolve(specifier,context);}catch(error){
    if(error?.code!=='ERR_MODULE_NOT_FOUND'||!context.parentURL||(!specifier.startsWith('./')&&!specifier.startsWith('../')))throw error;
    const base=new URL(specifier,context.parentURL);
    for(const suffix of ['.ts','.tsx']){
      const candidate=new URL(base.href+suffix);
      if(fs.existsSync(candidate))return{url:candidate.href,shortCircuit:true};
    }
    throw error;
  }
}
