import { PROCESS_TREE_TRACKER } from './process-tree-tracker.js';
/** 私有 bash 监护器：核对本次根、组和可靠观察到的后代；采样间主动脱组且未观察到的进程不保证回收。 */
export const BASH_PROCESS_SUPERVISOR = String.raw`
const fs = require('node:fs');
const {spawn, execFileSync} = require('node:child_process');
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
${PROCESS_TREE_TRACKER}
let child, tree, config, timer, poll, killTimer, rootExited=false, code=null, stopping=false, finished=false, timedOut=false, bytes=0, overflow=false, killRequested=false;
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
function signalGroup(signal) {
  try { tree?.signal(signal); } catch { /* 核对失败不按未知 PID 发信号；保留停止核对。 */ }
}
function stop() {
  stopping=true;
  signalGroup('SIGTERM');
  killTimer ??= setTimeout(()=>{killRequested=true;signalGroup('SIGKILL');},config?.graceMillis ?? 1000);
}
function finish(spawnError=false) {
  if(finished) return;
  finished=true;
  clearInterval(poll); clearTimeout(timer); clearTimeout(killTimer);
  const receipt={token:config.token,pid:child?.pid ?? null,code,stopping,spawnError,timedOut,timeoutMillis:config.timeoutMillis,groupStopped:true,treeStopped:true,tracked:tree?.identities() ?? [],bytes,overflow,endedAt:new Date().toISOString()};
  fs.writeFileSync(config.receipt+'.pending',JSON.stringify(receipt),{mode:0o600});
  fs.renameSync(config.receipt+'.pending',config.receipt);
  process.stdout.write(JSON.stringify({done:true})+'\n',()=>process.exit(0));
}
input.once('line',line=>{
  config=JSON.parse(line);
  fs.writeFileSync(config.log,'',{mode:0o600,flag:'wx'});
  child=spawn('/bin/bash',['--noprofile','--norc','-c',config.command],{
    cwd:config.directory,env:config.env,detached:true,stdio:['ignore','pipe','pipe']
  });
  child.once('spawn',()=>{tree=processTree(child.pid);try{tree.observe();}catch{}send({pid:child.pid});if(stopping) stop();});
  child.once('error',()=>finish(true));
  child.once('exit',exitCode=>{code=exitCode;rootExited=true;send({rootExited:true,code});});
  const output=chunk=>{
    bytes+=chunk.length;
    if(config.maxBytes !== null && bytes>config.maxBytes) { overflow=true;stop(); }
    fs.appendFileSync(config.log,chunk);
    if(fs.statSync(config.log).size>2*1024*1024) {
      const data=fs.readFileSync(config.log).subarray(-1024*1024);
      const first=data.indexOf(10);
      fs.writeFileSync(config.log,first<0?data:data.subarray(first+1));
    }
    send({output:chunk.toString('base64')});
  };
  child.stdout.on('data',output);child.stderr.on('data',output);
  poll=setInterval(()=>{
    try {
      const members=tree?.observe();
      if(rootExited && members?.length===0) finish();
      else if(killRequested) signalGroup('SIGKILL');
    } catch { /* 核对失败时继续保留监护器与停止入口。 */ }
  },50);
  if(config.timeoutMillis) timer=setTimeout(()=>{timedOut=true;send({timedOut:true});stop();},config.timeoutMillis);
  input.on('line',stop);
  if(stopping) stop();
});
input.on('close',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
`;
