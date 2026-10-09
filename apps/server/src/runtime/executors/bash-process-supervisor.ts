/** 私有 bash 监护器：只核对启动时创建的进程组，主动脱离该组的进程不在托管范围内。 */
export const BASH_PROCESS_SUPERVISOR = String.raw`
const fs = require('node:fs');
const {spawn, execFileSync} = require('node:child_process');
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
let child, config, timer, poll, killTimer, rootExited=false, code=null, stopping=false, finished=false, timedOut=false;
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
function members() {
  if (!child?.pid) return [];
  return execFileSync('/bin/ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:1000})
    .trim().split('\n').map(line=>line.trim().split(/\s+/))
    .filter(parts=>Number(parts[1])===child.pid && !parts[2]?.startsWith('Z'));
}
function signalGroup(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid,signal); } catch(e) { if(e.code!=='ESRCH') send({error:'进程组信号发送失败'}); }
}
function stop() {
  stopping=true;
  signalGroup('SIGTERM');
  killTimer ??= setTimeout(()=>signalGroup('SIGKILL'),config?.graceMillis ?? 1000);
}
function finish(spawnError=false) {
  if(finished) return;
  finished=true;
  clearInterval(poll); clearTimeout(timer); clearTimeout(killTimer);
  const receipt={token:config.token,pid:child?.pid ?? null,code,stopping,spawnError,timedOut,timeoutMillis:config.timeoutMillis,groupStopped:true,endedAt:new Date().toISOString()};
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
  child.once('spawn',()=>{send({pid:child.pid});if(stopping) stop();});
  child.once('error',()=>finish(true));
  child.once('exit',exitCode=>{code=exitCode;rootExited=true;send({rootExited:true,code});});
  const output=chunk=>{
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
    if(!rootExited) return;
    try { if(members().length===0) finish(); } catch { /* 核对失败时继续保留监护器与停止入口。 */ }
  },50);
  if(config.timeoutMillis) timer=setTimeout(()=>{timedOut=true;send({timedOut:true});stop();},config.timeoutMillis);
  input.on('line',stop);
  if(stopping) stop();
});
input.on('close',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
`;
