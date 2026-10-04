import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),starter=path.join(root,'starter');
const write=(name,text)=>{const file=path.join(starter,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const lockPath=path.join(starter,'pnpm-lock.yaml');
if(!fs.existsSync(lockPath))throw Error('TRACKED_STARTER_LOCKFILE_REQUIRED');
const lockfile=fs.readFileSync(lockPath,'utf8');
fs.rmSync(starter,{recursive:true,force:true});fs.mkdirSync(starter,{recursive:true});
write('package.json',JSON.stringify({name:'opsdesk-product-trial',version:'1.0.0',private:true,type:'module',scripts:{dev:'vite',build:'tsc -b && vite build',test:'vitest run'},dependencies:{'@vitejs/plugin-react':'5.0.4',vite:'7.1.7',typescript:'5.9.2',vitest:'3.2.4',tsx:'4.20.5',react:'19.1.1','react-dom':'19.1.1','@types/react':'19.1.16','@types/react-dom':'19.1.9'}},null,2)+'\n');
write('pnpm-lock.yaml',lockfile);
write('index.html','<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
write('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',useDefineForClassFields:true,lib:['ES2022','DOM','DOM.Iterable'],allowJs:false,skipLibCheck:true,esModuleInterop:true,allowSyntheticDefaultImports:true,strict:true,forceConsistentCasingInFileNames:true,module:'ESNext',moduleResolution:'Bundler',resolveJsonModule:true,isolatedModules:true,noEmit:true,jsx:'react-jsx'},include:['src','tests','vite.config.ts']},null,2)+'\n');
write('vite.config.ts',"import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()]});\n");
write('README.md','# OpsDesk\n\nImplementation pending.\n');
write('src/types.ts',`export type Severity='P0'|'P1'|'P2'|'P3';
export type IncidentStatus='OPEN'|'INVESTIGATING'|'RESOLVED';
export interface Incident {id:string;title:string;description:string;severity:Severity;status:IncidentStatus;createdAt:string;updatedAt:string}
export interface IncidentInput {title:string;description:string;severity:Severity}
export interface IncidentFilters {query?:string;severity?:Severity|'ALL';status?:IncidentStatus|'ALL'}
export interface IncidentExport {version:1;exportedAt:string;incidents:Incident[]}
`);
write('src/domain.ts',`import type {Incident,IncidentFilters,IncidentInput,IncidentStatus,Severity} from './types';
export const SLA_HOURS:Record<Severity,number>={P0:1,P1:4,P2:24,P3:72};
export function createIncident(_input:IncidentInput,_now=new Date(),_idFactory:()=>string=()=>crypto.randomUUID()):Incident{throw Error('TODO')}
export function editIncident(_incident:Incident,_patch:Partial<Pick<Incident,'title'|'description'|'severity'>>,_now=new Date()):Incident{throw Error('TODO')}
export function transitionIncident(_incident:Incident,_status:IncidentStatus,_now=new Date()):Incident{throw Error('TODO')}
export function deleteIncident(_incidents:Incident[],_id:string):Incident[]{throw Error('TODO')}
export function sortIncidents(_incidents:Incident[]):Incident[]{throw Error('TODO')}
export function filterIncidents(_incidents:Incident[],_filters:IncidentFilters):Incident[]{throw Error('TODO')}
export function slaDeadline(_incident:Incident):string{throw Error('TODO')}
export function slaState(_incident:Incident,_now=new Date()):'RESOLVED'|'WITHIN_SLA'|'OVERDUE'{throw Error('TODO')}
`);
write('src/storage.ts',`import type {Incident} from './types';export const STORAGE_VERSION=1;export const STORAGE_KEY='opsdesk.state';
export interface StorageLike {getItem(key:string):string|null;setItem(key:string,value:string):void}
export function encodeStorage(_incidents:Incident[]):string{throw Error('TODO')}
export function decodeStorage(_raw:string|null):Incident[]{throw Error('TODO')}
export function loadIncidents(_storage:StorageLike):Incident[]{throw Error('TODO')}
export function saveIncidents(_storage:StorageLike,_incidents:Incident[]):void{throw Error('TODO')}
`);
write('src/io.ts',`import type {Incident} from './types';export const EXPORT_VERSION=1;
export function exportIncidents(_incidents:Incident[],_now=new Date()):string{throw Error('TODO')}
export function importIncidents(_text:string,_existing:Incident[]):Incident[]{throw Error('TODO')}
`);
write('src/App.tsx',`export default function App(){return <main><h1>OpsDesk</h1><p>Implementation pending.</p></main>}
`);
write('src/main.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import App from './App';import './styles.css';createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
`);
write('src/styles.css','/* Build the responsive OpsDesk interface here. */\n');
for(const name of ['IncidentForm','IncidentList','IncidentDetail'])write(`src/components/${name}.tsx`,`export function ${name}(){return null}\n`);
write('tests/domain.test.ts',`import{describe,it,expect}from'vitest';import{createIncident,editIncident,transitionIncident,sortIncidents,filterIncidents,slaState}from'../src/domain';
describe('incident domain',()=>{const now=new Date('2026-01-01T00:00:00Z');it('creates stable timestamped incidents',()=>{const x=createIncident({title:'DB down',description:'writes fail',severity:'P0'},now,()=> 'fixed');expect(x).toMatchObject({id:'fixed',status:'OPEN',createdAt:now.toISOString(),updatedAt:now.toISOString()})});it('edits and transitions immutably',()=>{const x=createIncident({title:'a',description:'b',severity:'P1'},now,()=> 'i'),y=editIncident(x,{title:'c'},new Date('2026-01-01T01:00:00Z')),z=transitionIncident(y,'RESOLVED');expect(x.title).toBe('a');expect(y.id).toBe(x.id);expect(z.status).toBe('RESOLVED')});it('sorts, filters and computes SLA',()=>{const p2=createIncident({title:'Cache latency',description:'edge',severity:'P2'},now,()=> 'p2'),p0=createIncident({title:'Database',description:'primary',severity:'P0'},now,()=> 'p0');expect(sortIncidents([p2,p0]).map(x=>x.id)).toEqual(['p0','p2']);expect(filterIncidents([p2,p0],{query:'EDGE'}).map(x=>x.id)).toEqual(['p2']);expect(slaState(p0,new Date('2026-01-01T01:00:00.001Z'))).toBe('OVERDUE')})});
`);
write('tests/storage.test.ts',`import{describe,it,expect}from'vitest';import{encodeStorage,decodeStorage,STORAGE_VERSION}from'../src/storage';const incident={id:'i',title:'t',description:'d',severity:'P1' as const,status:'OPEN' as const,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};describe('storage',()=>{it('round trips a versioned payload',()=>{expect(STORAGE_VERSION).toBe(1);expect(decodeStorage(encodeStorage([incident]))).toEqual([incident])});it('fails safely on corrupt data',()=>expect(decodeStorage('{bad')).toEqual([]))});
`);
write('tests/io.test.ts',`import{describe,it,expect}from'vitest';import{exportIncidents,importIncidents}from'../src/io';const incident={id:'i',title:'t',description:'d',severity:'P1' as const,status:'OPEN' as const,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};describe('import/export',()=>{it('round trips without duplicate ids',()=>{const text=exportIncidents([incident]);expect(importIncidents(text,importIncidents(text,[]))).toEqual([incident])});it('rejects invalid input without mutating existing data',()=>{const existing=[incident];expect(()=>importIncidents('{bad',existing)).toThrow();expect(existing).toEqual([incident])})});
`);
write('tests/ui.test.ts',`import{describe,it,expect}from'vitest';import React from'react';import{renderToStaticMarkup}from'react-dom/server';import App from'../src/App';describe('product interface',()=>{it('server-renders semantic incident controls',()=>{const html=renderToStaticMarkup(React.createElement(App));expect(html).toMatch(/<main/);expect(html).toMatch(/<form/);expect(html).toMatch(/<label/);expect(html).toMatch(/search/i)})});
`);
console.log(starter);
