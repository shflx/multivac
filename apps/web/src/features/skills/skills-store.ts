import type { SkillRecord } from '@multivac/contracts';
export async function skillApi<T>(path = '', input?: unknown): Promise<T> {
 const response=await fetch('/api/skills'+path,input===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 const body=await response.json(); if(!response.ok)throw Error(body.error?.message ?? 'Skill 请求失败。'); return body as T;
}
/** 同一窗口共用目录；迟到快照不能覆盖较新的刷新。草稿由各入口独立保留。 */
class SkillsStore {
 private state: { records:SkillRecord[]; error:string; loaded:boolean }={records:[],error:'',loaded:false};
 private listeners=new Set<()=>void>(); private generation=0;
 snapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 async refresh() { const generation=++this.generation;try {const records=await skillApi<SkillRecord[]>();if(generation!==this.generation)return;this.state={records,error:'',loaded:true};}catch(e){if(generation!==this.generation)return;this.state={...this.state,error:(e as Error).message,loaded:true};}this.listeners.forEach(l=>l()); }
}
export const skillsStore=new SkillsStore();
