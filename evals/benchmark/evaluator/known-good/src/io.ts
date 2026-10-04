import type{Incident}from'./types';import{migratePayload,validatePayload}from'./storage';
export const EXPORT_VERSION=2;
export function exportIncidents(incidents:Incident[],now=new Date()):string{return JSON.stringify({...validatePayload({version:2,incidents}),exportedAt:now.toISOString()})}
export function importIncidents(text:string,existing:Incident[]):Incident[]{let parsed:unknown;try{parsed=JSON.parse(text)}catch{throw Error('Invalid import JSON')}const incoming=migratePayload(parsed).incidents,map=new Map(existing.map(item=>[item.id,item]));for(const item of incoming)map.set(item.id,item);return[...map.values()].map(item=>structuredClone(item))}
