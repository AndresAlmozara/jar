export type Severity='P0'|'P1'|'P2'|'P3';
export type IncidentStatus='OPEN'|'ACKNOWLEDGED'|'RESOLVED';
export type ActivityKind='CREATED'|'ACKNOWLEDGED'|'SEVERITY_CHANGED'|'ASSIGNEE_CHANGED'|'RESOLVED'|'REOPENED';
export interface Activity{id:string;incidentId:string;sequence:number;kind:ActivityKind;happenedAt:string;before?:string|null;after?:string|null}
export interface Incident{id:string;title:string;description:string;severity:Severity;assignee:string|null;status:IncidentStatus;createdAt:string;updatedAt:string;activity:Activity[]}
export interface IncidentInput{title:string;description:string;severity:Severity;assignee?:string|null}
export interface IncidentFilters{query?:string;severity?:Severity|'ALL';status?:IncidentStatus|'ALL'}
export interface LegacyIncident{id:string;title:string;description:string;severity:Severity;status:'OPEN'|'INVESTIGATING'|'RESOLVED';createdAt:string;updatedAt:string}
export interface StorageV1{version:1;incidents:LegacyIncident[]}
export interface StorageV2{version:2;incidents:Incident[]}
export interface IncidentExport extends StorageV2{exportedAt:string}
