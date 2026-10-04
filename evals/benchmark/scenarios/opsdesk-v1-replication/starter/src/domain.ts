import type {Incident,IncidentFilters,IncidentInput,IncidentStatus,Severity} from './types';
export const SLA_HOURS:Record<Severity,number>={P0:1,P1:4,P2:24,P3:72};
export function createIncident(_input:IncidentInput,_now=new Date(),_idFactory=()=>crypto.randomUUID()):Incident{throw Error('TODO')}
export function editIncident(_incident:Incident,_patch:Partial<Pick<Incident,'title'|'description'|'severity'>>,_now=new Date()):Incident{throw Error('TODO')}
export function transitionIncident(_incident:Incident,_status:IncidentStatus,_now=new Date()):Incident{throw Error('TODO')}
export function deleteIncident(_incidents:Incident[],_id:string):Incident[]{throw Error('TODO')}
export function sortIncidents(_incidents:Incident[]):Incident[]{throw Error('TODO')}
export function filterIncidents(_incidents:Incident[],_filters:IncidentFilters):Incident[]{throw Error('TODO')}
export function slaDeadline(_incident:Incident):string{throw Error('TODO')}
export function slaState(_incident:Incident,_now=new Date()):'RESOLVED'|'WITHIN_SLA'|'OVERDUE'{throw Error('TODO')}
