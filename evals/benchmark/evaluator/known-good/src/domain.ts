import type{Activity,ActivityKind,Incident,IncidentFilters,IncidentInput,IncidentStatus,Severity}from'./types';

export const SLA_HOURS:Record<Severity,number>={P0:1,P1:4,P2:24,P3:72};
const stamp=(value:Date)=>{const time=value.getTime();if(!Number.isFinite(time))throw Error('Invalid timestamp');return value.toISOString()};
const event=(incidentId:string,sequence:number,kind:ActivityKind,happenedAt:string,before?:string|null,after?:string|null):Activity=>({id:`${incidentId}:activity:${sequence}`,incidentId,sequence,kind,happenedAt,...(before!==undefined?{before}:{}),...(after!==undefined?{after}:{})});
function append(incident:Incident,kind:ActivityKind,now:Date,before?:string|null,after?:string|null):Incident{
  const happenedAt=stamp(now),last=incident.activity.at(-1);
  if(Date.parse(happenedAt)<Date.parse(last?.happenedAt??incident.createdAt))throw Error('Activity time cannot move backwards');
  const next=event(incident.id,(last?.sequence??0)+1,kind,happenedAt,before,after);
  return{...incident,updatedAt:happenedAt,activity:[...incident.activity,next]};
}
export function createIncident(input:IncidentInput,now=new Date(),idFactory:()=>string=()=>crypto.randomUUID()):Incident{
  const createdAt=stamp(now),id=idFactory(),assignee=input.assignee?.trim()||null;
  if(!id.trim()||!input.title.trim()||!input.description.trim())throw Error('Incident id, title, and description are required');
  return{id,title:input.title.trim(),description:input.description.trim(),severity:input.severity,assignee,status:'OPEN',createdAt,updatedAt:createdAt,activity:[event(id,1,'CREATED',createdAt,null,'OPEN')]};
}
export function editIncident(incident:Incident,patch:Partial<Pick<Incident,'title'|'description'|'severity'|'assignee'>>,now=new Date()):Incident{
  const happenedAt=stamp(now);if(Date.parse(happenedAt)<Date.parse(incident.updatedAt))throw Error('Edit time cannot move backwards');
  const title=patch.title===undefined?incident.title:patch.title.trim(),description=patch.description===undefined?incident.description:patch.description.trim();
  if(!title||!description)throw Error('Title and description are required');
  let next:Incident={...incident,title,description,updatedAt:happenedAt,activity:[...incident.activity]};
  if(patch.severity!==undefined&&patch.severity!==incident.severity){const before=next.severity;next={...append(next,'SEVERITY_CHANGED',now,before,patch.severity),severity:patch.severity};}
  const assignee=patch.assignee===undefined?incident.assignee:patch.assignee?.trim()||null;
  if(assignee!==incident.assignee){const before=next.assignee;next={...append(next,'ASSIGNEE_CHANGED',now,before,assignee),assignee};}
  return next;
}
export function transitionIncident(incident:Incident,status:IncidentStatus,now=new Date()):Incident{
  const rule:Record<IncidentStatus,Partial<Record<IncidentStatus,ActivityKind>>>={OPEN:{ACKNOWLEDGED:'ACKNOWLEDGED'},ACKNOWLEDGED:{RESOLVED:'RESOLVED'},RESOLVED:{OPEN:'REOPENED'}};
  const kind=rule[incident.status][status];if(!kind)throw Error(`Invalid lifecycle transition: ${incident.status} -> ${status}`);
  return{...append(incident,kind,now,incident.status,status),status};
}
export const deleteIncident=(incidents:Incident[],id:string)=>incidents.filter(item=>item.id!==id);
export function orderedActivity(activity:Activity[]):Activity[]{return[...activity].sort((a,b)=>a.sequence-b.sequence||a.happenedAt.localeCompare(b.happenedAt)||a.id.localeCompare(b.id))}
export function sortIncidents(incidents:Incident[]):Incident[]{const rank:Record<Severity,number>={P0:0,P1:1,P2:2,P3:3};return[...incidents].sort((a,b)=>rank[a.severity]-rank[b.severity]||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))}
export function filterIncidents(incidents:Incident[],filters:IncidentFilters):Incident[]{const query=filters.query?.trim().toLowerCase()??'';return sortIncidents(incidents.filter(item=>(!query||`${item.title} ${item.description} ${item.assignee??''}`.toLowerCase().includes(query))&&(!filters.severity||filters.severity==='ALL'||item.severity===filters.severity)&&(!filters.status||filters.status==='ALL'||item.status===filters.status)))}
export const slaDeadline=(incident:Incident)=>new Date(Date.parse(incident.createdAt)+SLA_HOURS[incident.severity]*3_600_000).toISOString();
export function slaState(incident:Incident,now=new Date()):'RESOLVED'|'WITHIN_SLA'|'OVERDUE'{return incident.status==='RESOLVED'?'RESOLVED':now.getTime()<=Date.parse(slaDeadline(incident))?'WITHIN_SLA':'OVERDUE'}
