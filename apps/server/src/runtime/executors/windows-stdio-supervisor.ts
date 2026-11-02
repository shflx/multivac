import { WINDOWS_PROCESS_TREE_TRACKER } from './windows-process-supervisor.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { childEnvironment, programLaunch } from '../program-launch.js';

/** 根 Node 先握手再启动目标；IPC 单独传退出事实，stdout/stderr 只传目标字节。 */
export const WINDOWS_STDIO_ROOT = String.raw`
const {spawn}=require('node:child_process');
const config=JSON.parse(process.argv[1]);
let initial=Buffer.alloc(0),started=false;
function start(chunk){
 initial=Buffer.concat([initial,chunk]);const newline=initial.indexOf(10);if(newline<0)return;
 process.stdin.pause();process.stdin.removeListener('data',start);
 started=true;
 const child=spawn(config.file,config.args,{cwd:config.cwd,env:process.env,shell:false,windowsVerbatimArguments:!!config.windowsVerbatimArguments,windowsHide:true,stdio:['pipe','inherit','inherit']});
 child.stdin.on('error',()=>{});
 if(initial.length>newline+1)child.stdin.write(initial.subarray(newline+1));
 process.stdin.pipe(child.stdin);
 child.once('error',()=>process.send?.({targetClosed:true,spawnError:true}));
 child.once('close',code=>process.send?.({targetClosed:true,code}));
}
process.stdin.on('data',start);
process.on('message',message=>{if(message?.release && started)process.exit(0);});
`;

export const WINDOWS_STDIO_SUPERVISOR = String.raw`
const {spawn,execFileSync}=require('node:child_process');
${WINDOWS_PROCESS_TREE_TRACKER}
const config=JSON.parse(process.argv[1]);
let tree,stopping=false,unlocked=false,inputEnded=false,rootExited=false,targetClosed=false,spawnError=false,targetCode=null,pending=[],pendingBytes=0;
const child=spawn(process.execPath,['-e',${JSON.stringify(WINDOWS_STDIO_ROOT)},JSON.stringify(config)],{cwd:config.cwd,env:process.env,windowsHide:true,stdio:['pipe','inherit','inherit','ipc']});
child.stdin.on('error',()=>{});
child.stdin.on('drain',()=>process.stdin.resume());
process.stdin.on('data',chunk=>{
 if(stopping)return;
 if(unlocked){if(!child.stdin.write(chunk))process.stdin.pause();}
 else{pendingBytes+=chunk.length;if(pendingBytes>2000000)stop();else pending.push(chunk);}
});
child.on('error',()=>{if(!child.pid)process.exit(127);});
child.on('spawn',()=>{tree=processTree(child.pid);});
child.on('message',message=>{if(message?.targetClosed){targetClosed=true;spawnError ||= !!message.spawnError;targetCode=message.code??null;}});
child.on('close',()=>{rootExited=true;});
function stop(){stopping=true;child.stdin.end();try{tree?.signal();}catch{}}
process.stdin.on('end',()=>{if(config.stopOnInputEnd!==false)stop();else{inputEnded=true;if(unlocked)child.stdin.end();}});process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.on('message',message=>{if(message?.stop)stop();});process.on('disconnect',stop);
setInterval(()=>{
 try{
  const members=tree?.observe();
  if(tree?.rootObserved() && !unlocked){
   unlocked=true;
   if(!stopping){child.stdin.write('\n');for(const chunk of pending)if(!child.stdin.write(chunk))process.stdin.pause();pending=[];pendingBytes=0;if(inputEnded)child.stdin.end();}
  }
  if(stopping)stop();
  if(targetClosed && members?.length===1 && members[0].pid===child.pid && child.connected)child.send({release:true});
  if(rootExited && tree?.rootObserved() && members?.length===0)process.exit(spawnError?127:config.stopOnInputEnd===false&&stopping?124:targetCode??0);
 }catch{ /* 无法查询身份时保留进程归属，不能证明已停止。 */ }
},250);
`;

/** 直接执行目标程序；独立监护器在目标与已观察后代全部退出后才关闭。 */
export function spawnWindowsObservedCommand(file: string, args: string[], cwd: string, source: NodeJS.ProcessEnv = process.env,
  extraEnvironment: NodeJS.ProcessEnv = {}): ChildProcess {
  const environment = { ...childEnvironment(source, 'win32'), ...extraEnvironment };
  const launch = programLaunch(file, args, 'win32', environment);
  return spawn(process.execPath, ['-e', WINDOWS_STDIO_SUPERVISOR, JSON.stringify({ ...launch, cwd, stopOnInputEnd: false })], {
    cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}

export function stopWindowsObservedCommand(child: ChildProcess): void {
  if (child.connected) child.send({ stop: true });
}
