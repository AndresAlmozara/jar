import {open,readFile,rename,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';

export async function writeCampaignState(path,state){
  await mkdir(dirname(path),{recursive:true});
  const temporary=`${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary,`${JSON.stringify(state,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  await rename(temporary,path);
}

export async function readCampaignState(path){return JSON.parse(await readFile(path,'utf8'));}

export async function appendDecision(path,decision){
  await mkdir(dirname(path),{recursive:true});
  const handle=await open(path,'a');
  try{await handle.write(`${JSON.stringify(decision)}\n`);await handle.sync();}finally{await handle.close();}
}
