/** Windows 只追踪本次根和已观察后代。CIM 查询/停止失败必须保持未确认，不能把终止命令成功当退出证明。 */
export const WINDOWS_PROCESS_TREE_TRACKER = String.raw`
function processTree(root) {
  const known=new Map();let rootSeen=false;
  const ps=(script)=>{
    const systemRoot=process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    return execFileSync(systemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);"+script,'utf16le').toString('base64')],
      {encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024,windowsHide:true,env:process.env}).trim();
  };
  function snapshot() {
    const value=JSON.parse(ps("$rows=@(Get-CimInstance Win32_Process | ForEach-Object { if($_.ProcessId -gt 0){@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;identity=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('O')}else{$null});group=0}} });ConvertTo-Json -InputObject $rows -Compress"));
    if(!Array.isArray(value) || value.some(p=>!Number.isSafeInteger(p.pid)||p.pid<=0||!Number.isSafeInteger(p.ppid)||(p.identity!==null && typeof p.identity!=='string') || known.has(p.pid) && !p.identity)) throw Error('Invalid CIM snapshot');
    return value;
  }
  function observe() {
    const all=snapshot();
    let added=true;
    while(added){
      added=false;
      for(const p of all){
        if(known.has(p.pid) || !p.identity)continue;
        const parent=all.find(v=>v.pid===p.ppid);
        if(p.pid===root && !rootSeen || parent && known.get(parent.pid)?.identity===parent.identity){known.set(p.pid,p);if(p.pid===root)rootSeen=true;added=true;}
      }
    }
    return all.filter(p=>known.get(p.pid)?.identity===p.identity);
  }
  return {
    observe,rootObserved:()=>rootSeen,identities:()=>[...known.values()],
    signal(){
      for(const p of observe().reverse()){
        if(!/^[-0-9T:.+Z]+$/.test(p.identity))throw Error('Invalid creation identity');
        ps("$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+p.pid+"';if($p -and $p.CreationDate.ToUniversalTime().ToString('O') -eq '"+p.identity+"'){$r=Invoke-CimMethod -InputObject $p -MethodName Terminate;if($r.ReturnValue -ne 0){throw 'Terminate not confirmed'}}");
      }
    }
  };
}
`;

/** Job Object 后端保留在 ProcessSupervisor 装配点；本轮不引入原生辅助程序。 */
export const WINDOWS_COMMAND_SUPERVISOR = String.raw`
const fs=require('node:fs');
const {spawn,execFileSync}=require('node:child_process');
const readline=require('node:readline');
const input=readline.createInterface({input:process.stdin});
${WINDOWS_PROCESS_TREE_TRACKER}
let config,child,tree,poll,timer,stopping=false,rootExited=false,childClosed=false,code=null,finished=false,unlocked=false,bytes=0,overflow=false,timedOut=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function stop(){stopping=true;try{tree?.signal();}catch{}}
function finish(spawnError=false){
 if(finished)return;finished=true;clearInterval(poll);clearTimeout(timer);
 const receipt={token:config.token,pid:child?.pid??null,code,stopping,spawnError,timedOut,timeoutMillis:config.timeoutMillis,groupStopped:true,treeStopped:true,tracked:tree?.identities()??[],bytes,overflow,endedAt:new Date().toISOString()};
 fs.writeFileSync(config.receipt+'.pending',JSON.stringify(receipt),{mode:0o600,flush:true});fs.renameSync(config.receipt+'.pending',config.receipt);
 process.stdout.write(JSON.stringify({done:true})+'\n',()=>process.exit(0));
}
input.once('line',line=>{
 config=JSON.parse(line);fs.writeFileSync(config.log,'',{mode:0o600,flag:'wx'});
 child=spawn(config.shellLaunch.file,config.shellLaunch.args,{cwd:config.directory,env:config.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});
 child.once('spawn',()=>{tree=processTree(child.pid);});
 child.once('error',()=>finish(true));
 child.once('close',()=>{childClosed=true;});
 child.once('exit',exitCode=>{rootExited=true;code=exitCode;send({rootExited:true,code});});
 const output=chunk=>{
  bytes+=chunk.length;
  if(config.maxBytes!==null && bytes>config.maxBytes){overflow=true;stop();}
  fs.appendFileSync(config.log,chunk);
  if(fs.statSync(config.log).size>2*1024*1024){const data=fs.readFileSync(config.log).subarray(-1024*1024);const first=data.indexOf(10);fs.writeFileSync(config.log,first<0?data:data.subarray(first+1));}
  send({output:chunk.toString('base64')});
 };
 child.stdout.on('data',output);child.stderr.on('data',output);
 poll=setInterval(()=>{
  try{
   const members=tree?.observe();
   if(tree?.rootObserved() && !unlocked){unlocked=true;if(!stopping){child.stdin.end('\n');send({pid:child.pid});}}
   if(stopping)stop();
   if(rootExited && childClosed && tree?.rootObserved() && members?.length===0)finish();
  }catch{ /* 查询失败保留监护器、停止入口和租约。 */ }
 },250);
 if(config.timeoutMillis)timer=setTimeout(()=>{timedOut=true;send({timedOut:true});stop();},config.timeoutMillis);
 input.on('line',stop);
 if(stopping)stop();
});
input.on('close',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
`;
