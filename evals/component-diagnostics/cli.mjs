#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {SUITES} from "./datasets.mjs";
import {validateIdentity} from "./identity.mjs";
import {runPreflight} from "./preflight.mjs";
import {runMechanism} from "./mechanism.mjs";
import {dryRun,loadState} from "./controller.mjs";
import {runSlot} from "./live.mjs";
import {buildReport} from "./report.mjs";
import {CAMPAIGN_ROOT,writeJson} from "./common.mjs";

export function parseArgs(argv){const [command,...rest]=argv,out={command};for(let i=0;i<rest.length;i++){const key=rest[i];if(key==="--execute")out.execute=true;else if(["--suite","--treatment","--partition","--slot"].includes(key)&&rest[i+1])out[key.slice(2)]=rest[++i];else throw Object.assign(Error("ARGUMENT_INVALID"),{code:"ARGUMENT_INVALID",argument:key});}return out;}
const emit=value=>console.log(JSON.stringify(value,null,2));
export async function main(argv=process.argv.slice(2)){const args=parseArgs(argv);if(args.command==="list")return emit({suites:SUITES,commands:["list","identity","preflight","mechanism --suite <id|all> --treatment <id|all> --partition <development|calibration|evaluation-only|all>","campaign --dry-run","run-slot --slot <slot-id> --execute","resume --execute","report"]});if(args.command==="identity")return emit(validateIdentity());if(args.command==="preflight")return emit(await runPreflight());if(args.command==="mechanism"){const result=await runMechanism({suite:args.suite??"all",treatment:args.treatment??"all",partition:args.partition??"all"});writeJson(path.join(CAMPAIGN_ROOT,`mechanism-${args.partition??"all"}.json`),result);return emit({status:"COMPLETE",rows:result.rows.length,groups:result.groups,mainModelTurnsStarted:0});}if(args.command==="campaign"&&argv.includes("--dry-run"))return emit(dryRun());if(args.command==="run-slot"){if(!args.execute)throw Object.assign(Error("LIVE_EXECUTION_REQUIRES_EXECUTE"),{code:"LIVE_EXECUTION_REQUIRES_EXECUTE"});return emit(await runSlot(args.slot));}if(args.command==="resume"){if(!args.execute)throw Object.assign(Error("LIVE_EXECUTION_REQUIRES_EXECUTE"),{code:"LIVE_EXECUTION_REQUIRES_EXECUTE"});const evaluationFile=path.join(CAMPAIGN_ROOT,"mechanism-evaluation-only.json");if(!fs.existsSync(evaluationFile))writeJson(evaluationFile,await runMechanism({suite:"all",partition:"evaluation-only"}));for(;;){const state=loadState({create:true});if(state.running)throw Object.assign(Error("STARTED_UNRESOLVED_REQUIRES_AUDIT"),{code:"STARTED_UNRESOLVED_REQUIRES_AUDIT",running:state.running});if(state.nextIndex>=state.plannedSlots.length)break;const slot=state.plannedSlots[state.nextIndex],out=await runSlot(slot.slotId);emit({progress:{completed:out.state.nextIndex,planned:out.state.plannedSlots.length,started:out.state.startedProductTurns,last:slot.slotId,status:out.result.status}});if(out.result.status!=="COMPLETE"&&out.state.status!=="REPLACEMENT_READY")break;}return emit(buildReport());}if(args.command==="report")return emit(buildReport());throw Object.assign(Error("COMMAND_REQUIRED"),{code:"COMMAND_REQUIRED"});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:"ERROR",code:error.code??error.message,details:error.report??error.running??null},null,2));process.exitCode=2;});
