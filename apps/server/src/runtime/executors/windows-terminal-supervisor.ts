import { WINDOWS_PROCESS_TREE_TRACKER } from './windows-process-supervisor.js';

/** ConPTY 中的根只负责握手与继承控制台，不改写 CLI 配置或把输出当作生命周期协议。 */
export const WINDOWS_TERMINAL_ROOT = String.raw`
const {spawn}=require('node:child_process');
const config=JSON.parse(process.argv[1]);
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on('data',function unlock(chunk){
 if(!chunk.includes(13) && !chunk.includes(10))return;
 process.stdin.pause();process.stdin.removeListener('data',unlock);
 if(process.stdin.isTTY)process.stdin.setRawMode(false);
 const child=spawn(config.file,config.args,{cwd:config.cwd,env:process.env,shell:false,windowsVerbatimArguments:!!config.windowsVerbatimArguments,stdio:'inherit'});
 child.once('error',()=>{process.stderr.write('CLI could not start\r\n');process.exit(127);});
 child.once('close',code=>process.exit(code??1));
});
`;

/** 监护进程只传状态，不读终端正文；宿主 IPC 断开后继续清理自己的观察范围。 */
export const WINDOWS_TERMINAL_WATCHER = String.raw`
const {execFileSync}=require('node:child_process');
${WINDOWS_PROCESS_TREE_TRACKER}
const tree=processTree(Number(process.argv[1]));
let stopping=false,ready=false,started=false;
process.on('message',message=>{if(message?.stop)stopping=true;});
process.on('disconnect',()=>{stopping=true;});
const send=message=>{if(process.connected)process.send(message,error=>{if(error)stopping=true;});};
setInterval(()=>{
 try{
  const members=tree.observe();send({observed:true});
  if(tree.rootObserved() && !ready){ready=true;send({ready:true});}
  if(ready && !started && members.some(p=>p.ppid===Number(process.argv[1]))){started=true;send({started:true});}
  if(stopping)tree.signal();
  if(ready && members.length===0){if(process.connected)process.send({stopped:true},()=>process.exit(0));else process.exit(0);}
 }catch{send({queryFailed:true});}
},250);
`;
