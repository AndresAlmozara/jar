import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { disableTelemetry, enableTelemetry, jarHome, readTelemetryConfig } from "./config.js";
import { TelemetryRecorder } from "./recorder.js";
import { exportStudy, maintainTelemetry, reportStudy, telemetryDoctor, telemetryStatus } from "./maintenance.js";

export const MAINTENANCE_TASK_NAME="JAR Telemetry Maintenance";

function value(args,name,fallback=null){const index=args.indexOf(name);return index>=0?args[index+1]:fallback}
function has(args,name){return args.includes(name)}
function currentRuntime(home){try{const current=JSON.parse(fs.readFileSync(path.join(home,"current.json"),"utf8"));return {runtimeId:current.runtimeId,sourceCommit:current.sourceCommit,runtimeRoot:current.runtimeRoot,entrypoint:current.entrypoint}}catch{return null}}

function xml(value){return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;")}
function currentUserSid(){const result=spawnSync("whoami.exe",["/user","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true}),match=(result.stdout||"").match(/^"[^"]+","([^"]+)"/m);return result.status===0?match?.[1]||null:null}
function localBoundary(date){const pad=value=>String(value).padStart(2,"0");return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`}

export function maintenanceTaskXml({launcher,userSid,minutes=30,start=new Date(Date.now()+60000)}={}) {
  if(!launcher||!userSid||!Number.isInteger(minutes)||minutes<1)throw new Error("scheduler XML inputs are invalid");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Pinned JAR metadata telemetry maintenance; no model or network collector.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${localBoundary(start)}</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>${xml(launcher)}</Command><Arguments>telemetry maintain</Arguments></Exec></Actions>
</Task>`;
}

export function schedulerStatus() {
  if(process.platform!=="win32")return {ok:false,state:"NOT_COVERED_NON_WINDOWS"};
  const result=spawnSync("schtasks.exe",["/Query","/TN",MAINTENANCE_TASK_NAME,"/FO","LIST","/V"],{encoding:"utf8",windowsHide:true});return result.status===0?{ok:true,state:"registered"}:{ok:false,state:"missing",code:result.status};
}

export function registerMaintenanceTask({jarHome:home,minutes=30}={}) {
  if(process.platform!=="win32")return {ok:false,state:"NOT_COVERED_NON_WINDOWS"};
  const launcher=path.join(home,"bin","jar.cmd"),userSid=currentUserSid();if(!fs.existsSync(launcher))return {ok:false,state:"installed_launcher_missing",launcher};if(!userSid)return {ok:false,state:"user_sid_unavailable"};
  const file=path.join(os.tmpdir(),`jar-telemetry-task-${process.pid}-${Date.now()}.xml`);
  try{fs.writeFileSync(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(maintenanceTaskXml({launcher,userSid,minutes}),"utf16le")]));const result=spawnSync("schtasks.exe",["/Create","/TN",MAINTENANCE_TASK_NAME,"/XML",file,"/F"],{encoding:"utf8",windowsHide:true});return result.status===0?{ok:true,state:"registered",taskName:MAINTENANCE_TASK_NAME,launcher}:{ok:false,state:"registration_failed",code:result.status,detail:(result.stderr||result.stdout||"").trim().slice(0,500)}}finally{try{fs.rmSync(file,{force:true})}catch{}}
}

export function setMaintenanceTaskEnabled(enabled) {
  if(process.platform!=="win32")return {ok:false,state:"NOT_COVERED_NON_WINDOWS"};
  const result=spawnSync("schtasks.exe",["/Change","/TN",MAINTENANCE_TASK_NAME,enabled?"/ENABLE":"/DISABLE"],{encoding:"utf8",windowsHide:true});return result.status===0?{ok:true,state:enabled?"enabled":"disabled"}:{ok:false,state:"task_update_failed",code:result.status,detail:(result.stderr||result.stdout||"").trim().slice(0,500)};
}

function restrictWindowsPath(target) {
  if(process.platform!=="win32")return {ok:null,state:"platform_default"};
  const account=process.env.USERDOMAIN&&process.env.USERNAME?`${process.env.USERDOMAIN}\\${process.env.USERNAME}`:process.env.USERNAME;if(!account)return {ok:false,state:"account_unknown"};
  const result=spawnSync("icacls.exe",[target,"/inheritance:r","/grant:r",`${account}:(OI)(CI)F`],{encoding:"utf8",windowsHide:true});return result.status===0?{ok:true,state:"restricted_to_current_user"}:{ok:false,state:"acl_update_failed",code:result.status};
}

export async function runTelemetryCommand(command,args=[],options={}) {
  const home=jarHome(options),runtime=currentRuntime(home);
  if(command==="enable"){
    const root=value(args,"--root");if(!root||!path.isAbsolute(root))throw Object.assign(new Error("--root must be an absolute path"),{code:"JAR_TELEMETRY_ROOT_REQUIRED"});
    const enabled=await enableTelemetry({root,studyDays:Number(value(args,"--study-days","14")),jarHome:home}),acl=has(args,"--no-acl")?{root:{ok:null,state:"skipped"},spool:{ok:null,state:"skipped"}}:{root:restrictWindowsPath(enabled.config.root),spool:restrictWindowsPath(enabled.config.spoolRoot)},scheduler=has(args,"--no-schedule")?{ok:null,state:"skipped"}:registerMaintenanceTask({jarHome:home,minutes:enabled.config.maintenanceMinutes});
    return {ok:scheduler.ok!==false,telemetry:"enabled",root:enabled.config.root,spoolRoot:enabled.config.spoolRoot,studyId:enabled.studyId,status:enabled.studyStatus,reusedStudy:enabled.reusedStudy,runtime,scheduler,acl};
  }
  if(command==="disable"){const result=await disableTelemetry({jarHome:home}),scheduler=setMaintenanceTaskEnabled(false);return {ok:true,...result,scheduler};}
  if(command==="status")return telemetryStatus({jarHome:home});
  if(command==="doctor")return telemetryDoctor({jarHome:home,runtimeIdentity:runtime,scheduler:schedulerStatus()});
  if(command==="maintain")return maintainTelemetry({jarHome:home});
  if(command==="report")return reportStudy({jarHome:home,studyId:value(args,"--study")});
  if(command==="export"){if(!has(args,"--sanitized"))throw Object.assign(new Error("only --sanitized export is supported"),{code:"JAR_TELEMETRY_SANITIZED_EXPORT_REQUIRED"});return exportStudy({jarHome:home,studyId:value(args,"--study")});}
  if(command==="mark"){
    const turn=value(args,"--turn"),label=value(args,"--label"),allowed=new Set(["useful","noisy","missing","unknown"]);if(!turn||!allowed.has(label))throw Object.assign(new Error("--turn and a valid --label are required"),{code:"JAR_TELEMETRY_MARK_INVALID"});
    const recorder=new TelemetryRecorder({jarHome:home,current:runtime||{},adapterId:"jar-cli",dataOrigin:"production"}),result=recorder.record("feedback.recorded",{identifiers:{turn},correlation_status:"partial",correlation_missing_reason:"session_not_supplied",payload:{label}});return {ok:true,label,eventId:result.eventId};
  }
  throw Object.assign(new Error(`unknown telemetry command: ${command||""}`),{code:"JAR_TELEMETRY_COMMAND_UNKNOWN"});
}

export function telemetryUsage(){return "jar telemetry enable --root <absolute-path> [--study-days 14]\njar telemetry status|doctor|maintain\njar telemetry report --study <id>\njar telemetry export --study <id> --sanitized\njar telemetry mark --turn <id> --label useful|noisy|missing|unknown\njar telemetry disable"}
