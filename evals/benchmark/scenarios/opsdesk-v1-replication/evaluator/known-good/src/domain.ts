import type {Incident,IncidentFilters,IncidentInput,IncidentStatus,Severity} from './types';export const SLA_HOURS:Record<Severity,number>={P0:1,P1:4,P2:24,P3:72};
export function createIncident(input:IncidentInput,now=new Date(),idFactory=()=>crypto.randomUUID()):Incident{const stamp=now.toISOString();return{id:idFactory(),...input,status:'OPEN',createdAt:stamp,updatedAt:stamp}}
export function editIncident(i:Incident,p:Partial<Pick<Incident,'title'|'description'|'severity'>>,now=new Date()):Incident{return{...i,...p,updatedAt:now.toISOString()}}
export function transitionIncident(i:Incident,status:IncidentStatus,now=new Date()):Incident{return{...i,status,updatedAt:now.toISOString()}}
export function deleteIncident(xs:Incident[],id:string){return xs.filter(x=>x.id!==id)}
export function sortIncidents(xs:Incident[]){const rank={P0:0,P1:1,P2:2,P3:3};return[...xs].sort((a,b)=>rank[a.severity]-rank[b.severity]||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))}
export function filterIncidents(xs:Incident[],f:IncidentFilters){const q=f.query?.toLowerCase()??'';return sortIncidents(xs.filter(x=>(!q||`${x.title} ${x.description}`.toLowerCase().includes(q))&&(!f.severity||f.severity==='ALL'||x.severity===f.severity)&&(!f.status||f.status==='ALL'||x.status===f.status)))}
export function slaDeadline(i:Incident){return new Date(Date.parse(i.createdAt)+SLA_HOURS[i.severity]*3600000).toISOString()}
export function slaState(i:Incident,now=new Date()):'RESOLVED'|'WITHIN_SLA'|'OVERDUE'{return i.status==='RESOLVED'?'RESOLVED':now.getTime()<=Date.parse(slaDeadline(i))?'WITHIN_SLA':'OVERDUE'}
