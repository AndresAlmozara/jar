#!/usr/bin/env node
import path from "node:path";
import {fileURLToPath} from "node:url";
import {SUITES} from "./plan.mjs";
import {validateIdentity} from "./identity.mjs";
import {runPairPreflight} from "./pair-identity.mjs";
import {runPreflight} from "./preflight.mjs";
import {dryRun,loadState} from "./controller.mjs";
import {runSlot} from "./live.mjs";
import {buildReport} from "./report.mjs";

export function parseArgs(argv){const [command,...rest]=argv,out={command};for(let i=0;i<rest.length;i++){if(rest[i]==="--execute")out.execute=true;else if(rest[i]==="--slot"&&rest[i+1])out.slot=rest[++i];else throw Object.assign(Error("ARGUMENT_INVALID"),{code:"ARGUMENT_INVALID",argument:rest[i]});}return out;}
const emit=value=>console.log(JSON.stringify(value,null,2));
export async function main(argv=process.argv.slice(2)){const args=parseArgs(argv);if(args.command==="list")return emit({suites:SUITES,commands:["identity","pair-preflight","preflight","campaign --dry-run","run-slot --slot <id> --execute","resume --execute","report"]});if(args.command==="identity")return emit(validateIdentity());if(args.command==="pair-preflight")return emit(runPairPreflight());if(args.command==="preflight")return emit(await runPreflight());if(args.command==="campaign"&&argv.includes("--dry-run"))return emit(dryRun());if(args.command==="run-slot"){if(!args.execute)throw Object.assign(Error("LIVE_EXECUTION_REQUIRES_EXECUTE"),{code:"LIVE_EXECUTION_REQUIRES_EXECUTE"});return emit(await runSlot(args.slot));}if(args.command==="resume"){if(!args.execute)throw Object.assign(Error("LIVE_EXECUTION_REQUIRES_EXECUTE"),{code:"LIVE_EXECUTION_REQUIRES_EXECUTE"});for(;;){const state=loadState({create:true});if(state.running)throw Object.assign(Error("STARTED_UNRESOLVED_REQUIRES_AUDIT"),{code:"STARTED_UNRESOLVED_REQUIRES_AUDIT",running:state.running});if(state.nextIndex>=state.plannedSlots.length)break;const slot=state.plannedSlots[state.nextIndex],out=await runSlot(slot.slotId);emit({progress:{completed:out.state.nextIndex,planned:out.state.plannedSlots.length,started:out.state.startedProductTurns,last:slot.slotId,status:out.result.status}});if(out.result.status!=="COMPLETE")break;}return emit(buildReport());}if(args.command==="report")return emit(buildReport());throw Object.assign(Error("COMMAND_REQUIRED"),{code:"COMMAND_REQUIRED"});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:"ERROR",code:error.code??error.message,details:error.report??error.running??null},null,2));process.exitCode=2;});
