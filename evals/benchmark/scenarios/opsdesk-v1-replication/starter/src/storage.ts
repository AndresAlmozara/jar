import type {Incident} from './types';export const STORAGE_VERSION=1;export const STORAGE_KEY='opsdesk.state';
export interface StorageLike {getItem(key:string):string|null;setItem(key:string,value:string):void}
export function encodeStorage(_incidents:Incident[]):string{throw Error('TODO')}
export function decodeStorage(_raw:string|null):Incident[]{throw Error('TODO')}
export function loadIncidents(_storage:StorageLike):Incident[]{throw Error('TODO')}
export function saveIncidents(_storage:StorageLike,_incidents:Incident[]):void{throw Error('TODO')}
