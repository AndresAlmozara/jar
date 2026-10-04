export type Severity='P0'|'P1'|'P2'|'P3';
export type IncidentStatus='OPEN'|'INVESTIGATING'|'RESOLVED';
export interface Incident {id:string;title:string;description:string;severity:Severity;status:IncidentStatus;createdAt:string;updatedAt:string}
export interface IncidentInput {title:string;description:string;severity:Severity}
export interface IncidentFilters {query?:string;severity?:Severity|'ALL';status?:IncidentStatus|'ALL'}
export interface IncidentExport {version:1;exportedAt:string;incidents:Incident[]}
