import { win32 } from 'node:path';
import type { CommandShell } from './command-shell.js';

/** 逐条保存失败。PowerShell 5.1 的原生程序非零不会自动进入 Error 流，不能只读最后的 $?。 */
export function powershellCommandScript(command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=New-Object Text.UTF8Encoding($false)
$multivacText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$multivacTokens=$null;$multivacParseErrors=$null
$multivacAst=[Management.Automation.Language.Parser]::ParseInput($multivacText,[ref]$multivacTokens,[ref]$multivacParseErrors)
if($multivacParseErrors.Count -gt 0){[Console]::Error.WriteLine('PowerShell syntax error');exit 1}
if($multivacAst.ParamBlock -or $multivacAst.BeginBlock -or $multivacAst.ProcessBlock){[Console]::Error.WriteLine('Use a plain command script without param/begin/process');exit 1}
# 在执行前拒绝无法逐次观察退出码的原生调用，避免多语句中的失败被后续成功掩盖。
$multivacFunctions=@($multivacAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | ForEach-Object {$_.Name})
foreach($multivacStatement in $multivacAst.EndBlock.Statements){
 $multivacNative=@()
 foreach($multivacCall in $multivacStatement.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true)){
  $multivacName=$multivacCall.GetCommandName()
  if(-not $multivacName){[Console]::Error.WriteLine('Dynamic command invocation cannot be checked before execution');exit 1}
  if($multivacName -in $multivacFunctions){continue}
  $multivacInfo=$ExecutionContext.InvokeCommand.GetCommand($multivacName,[Management.Automation.CommandTypes]::All)
  while($multivacInfo -is [Management.Automation.AliasInfo]){$multivacInfo=$multivacInfo.ResolvedCommand}
  if(-not $multivacInfo){[Console]::Error.WriteLine('Command unavailable');exit 1}
  if($multivacInfo.CommandType -eq 'ExternalScript'){[Console]::Error.WriteLine('External PowerShell scripts need a separately reviewed exit protocol');exit 1}
  if($multivacInfo.CommandType -eq 'Application'){$multivacNative+=,$multivacCall}
 }
 if($multivacNative.Count -gt 0){
  $multivacPipeline=$multivacStatement
  if($multivacStatement -is [Management.Automation.Language.AssignmentStatementAst]){$multivacPipeline=$multivacStatement.Right}
  if($multivacNative.Count -ne 1 -or $multivacPipeline -isnot [Management.Automation.Language.PipelineAst] -or $multivacNative[0].Parent -ne $multivacPipeline){
   [Console]::Error.WriteLine('Native calls in loops, branches, nested expressions or multiple native calls in one pipeline cannot be checked; split them into separate top-level statements');exit 1
  }
 }
}
$multivacExitCode=0
$Error.Clear()
$ErrorActionPreference='Continue'
foreach($multivacStatement in $multivacAst.EndBlock.Statements){
 $global:LASTEXITCODE=0
 try{
  . ([ScriptBlock]::Create($multivacStatement.Extent.Text))
  $multivacSucceeded=$?
  if($global:LASTEXITCODE -ne 0 -and $multivacExitCode -eq 0){$multivacExitCode=$global:LASTEXITCODE}
  if((-not $multivacSucceeded -or $Error.Count -gt 0) -and $multivacExitCode -eq 0){$multivacExitCode=1}
 }catch{[Console]::Error.WriteLine($_.ToString());if($multivacExitCode -eq 0){$multivacExitCode=1};break}
}
exit $multivacExitCode`;
}
export function powershellCommandShell(environment: NodeJS.ProcessEnv = process.env): CommandShell {
  return { name: 'powershell', syntax: 'Windows PowerShell 5.1（不是 bash；使用 PowerShell 语法；不加载 profile）',
    launch: command => {
      const encoded = Buffer.from('[void][Console]::In.ReadLine()\n' + powershellCommandScript(command), 'utf16le').toString('base64');
      if (encoded.length > 30000) throw new Error('PowerShell 编码命令超过 Windows 启动长度限制，请拆分命令。');
      return { file: win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded] };
    } };
}
