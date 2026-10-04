import type{Activity,Incident,LegacyIncident,StorageV2}from'./types';
export const STORAGE_VERSION=2,STORAGE_KEY='opsdesk.state';
export interface StorageLike{getItem(key:string):string|null;setItem(key:string,value:string):void}
const severities=['P0','P1','P2','P3'],statuses=['OPEN','ACKNOWLEDGED','RESOLVED'],kinds=['CREATED','ACKNOWLEDGED','SEVERITY_CHANGED','ASSIGNEE_CHANGED','RESOLVED','REOPENED'];
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const time=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const text=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
function legacy(value:unknown):value is LegacyIncident{return object(value)&&text(value.id)&&text(value.title)&&text(value.description)&&severities.includes(String(value.severity))&&['OPEN','INVESTIGATING','RESOLVED'].includes(String(value.status))&&time(value.createdAt)&&time(value.updatedAt)&&Date.parse(String(value.createdAt))<=Date.parse(String(value.updatedAt))}
function legacyEvent(id:string,sequence:number,kind:Activity['kind'],happenedAt:string,before?:string,after?:string):Activity{return{id:`${id}:activity:${sequence}`,incidentId:id,sequence,kind,happenedAt,...(before?{before}:{}),...(after?{after}:{})}}
function migrateLegacy(item:LegacyIncident):Incident{
  const activity=[legacyEvent(item.id,1,'CREATED',item.createdAt,undefined,'OPEN')];
  if(item.status!=='OPEN')activity.push(legacyEvent(item.id,2,'ACKNOWLEDGED',item.updatedAt,'OPEN','ACKNOWLEDGED'));
  if(item.status==='RESOLVED')activity.push(legacyEvent(item.id,3,'RESOLVED',item.updatedAt,'ACKNOWLEDGED','RESOLVED'));
  return{...item,status:item.status==='INVESTIGATING'?'ACKNOWLEDGED':item.status,assignee:null,activity};
}
function validateActivity(value:unknown,incident:Record<string,unknown>,seen:Set<string>):asserts value is Activity{
  if(!object(value)||!text(value.id)||seen.has(String(value.id))||value.incidentId!==incident.id||!Number.isInteger(value.sequence)||Number(value.sequence)<1||!kinds.includes(String(value.kind))||!time(value.happenedAt))throw Error('Invalid activity');
  if(Date.parse(String(value.happenedAt))<Date.parse(String(incident.createdAt))||Date.parse(String(value.happenedAt))>Date.parse(String(incident.updatedAt)))throw Error('Invalid activity time');seen.add(String(value.id));
}
function validateIncident(value:unknown,activityIds:Set<string>):asserts value is Incident{
  if(!object(value)||!text(value.id)||!text(value.title)||!text(value.description)||!severities.includes(String(value.severity))||!statuses.includes(String(value.status))||(value.assignee!==null&&typeof value.assignee!=='string')||!time(value.createdAt)||!time(value.updatedAt)||Date.parse(String(value.createdAt))>Date.parse(String(value.updatedAt))||!Array.isArray(value.activity)||value.activity.length===0)throw Error('Invalid incident');
  let lifecycle='OPEN',lastTime=-Infinity;
  value.activity.forEach((entry,index)=>{validateActivity(entry,value,activityIds);if(entry.sequence!==index+1||Date.parse(entry.happenedAt)<lastTime)throw Error('Invalid activity order');lastTime=Date.parse(entry.happenedAt);if(index===0&&entry.kind!=='CREATED')throw Error('Missing created activity');if(entry.kind==='ACKNOWLEDGED'&&lifecycle==='OPEN')lifecycle='ACKNOWLEDGED';else if(entry.kind==='RESOLVED'&&lifecycle==='ACKNOWLEDGED')lifecycle='RESOLVED';else if(entry.kind==='REOPENED'&&lifecycle==='RESOLVED')lifecycle='OPEN';else if(['ACKNOWLEDGED','RESOLVED','REOPENED'].includes(entry.kind))throw Error('Invalid activity lifecycle')});
  if(lifecycle!==value.status)throw Error('Activity does not match incident status');
}
export function validatePayload(value:unknown):StorageV2{
  if(!object(value)||value.version!==2||!Array.isArray(value.incidents))throw Error('Unsupported or malformed OpsDesk payload');
  const incidentIds=new Set<string>(),activityIds=new Set<string>();for(const item of value.incidents){validateIncident(item,activityIds);if(incidentIds.has(item.id))throw Error('Duplicate incident id');incidentIds.add(item.id)}
  return structuredClone(value) as unknown as StorageV2;
}
export function migratePayload(value:unknown):StorageV2{
  if(!object(value))throw Error('Malformed OpsDesk payload');
  if(value.version===2)return validatePayload(value);
  if(value.version!==1||!Array.isArray(value.incidents)||!value.incidents.every(legacy))throw Error('Unsupported or malformed OpsDesk payload');
  if(new Set(value.incidents.map(item=>item.id)).size!==value.incidents.length)throw Error('Duplicate incident id');
  return validatePayload({version:2,incidents:value.incidents.map(migrateLegacy)});
}
export const encodeStorage=(incidents:Incident[])=>JSON.stringify(validatePayload({version:2,incidents}));
export function decodeStorage(raw:string|null):Incident[]{try{return migratePayload(JSON.parse(raw??'')).incidents}catch{return[]}}
export const loadIncidents=(storage:StorageLike)=>decodeStorage(storage.getItem(STORAGE_KEY));
export const saveIncidents=(storage:StorageLike,incidents:Incident[])=>storage.setItem(STORAGE_KEY,encodeStorage(incidents));
