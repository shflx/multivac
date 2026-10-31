import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { childEnvironment, runProgramSync } from '../runtime/program-launch.js';

/** 只用于实例私有根及配置的 Pi 凭据父目录，不得应用到工作目录或任意用户目录。 */
export function privateDirectoryAclScript(directory: string, fileName?: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop'
$root=Get-Item -LiteralPath ${quote(directory)} -Force
if(-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid private directory'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique
$acl=Get-Acl -LiteralPath $root.FullName
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
foreach($id in $allowed){
 $identity=New-Object Security.Principal.SecurityIdentifier($id)
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $root.FullName -AclObject $acl
$check=Get-Acl -LiteralPath $root.FullName
if(-not $check.AreAccessRulesProtected){throw 'Directory inheritance not protected'}
foreach($rule in $check.Access){
 $id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
 if($id -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit'){throw 'Unexpected directory ACL'}
}
if(@($check.Access).Count -ne $allowed.Count){throw 'Missing directory ACL'}
${fileName ? `$path=Join-Path $root.FullName ${quote(fileName)}
if(Test-Path -LiteralPath $path){
 $file=Get-Item -LiteralPath $path -Force
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid credential file'}
 $acl=Get-Acl -LiteralPath $path
 $acl.SetAccessRuleProtection($false,$false)
 foreach($rule in @($acl.Access | Where-Object {-not $_.IsInherited})){$acl.RemoveAccessRuleSpecific($rule)}
 Set-Acl -LiteralPath $path -AclObject $acl
 $check=Get-Acl -LiteralPath $path
 if($check.AreAccessRulesProtected){throw 'File does not inherit ACL'}
 foreach($rule in $check.Access){
  $id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if($id -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or -not $rule.IsInherited){throw 'Unexpected credential ACL'}
 }
 if(@($check.Access).Count -ne $allowed.Count){throw 'Missing credential ACL'}
}` : ''}
[Console]::Out.Write('multivac-acl-v1')`;
}

export function secureWindowsPrivateDirectory(directory: string, fileName?: string, options: {
  platform?: NodeJS.Platform; run?: typeof runProgramSync;
} = {}): void {
  if ((options.platform ?? process.platform) !== 'win32') return;
  if (fileName && (fileName !== win32.basename(fileName) || /[\\/:\0]/u.test(fileName))) throw new Error('私有文件名无效。');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const before = lstatSync(directory), canonical = realpathSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('私有目录类型无效。');
  if (fileName) {
    try { const stat = lstatSync(join(directory, fileName)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('私有文件类型无效。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const script = privateDirectoryAclScript(canonical, fileName);
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = (options.run ?? runProgramSync)(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', env: childEnvironment(process.env, 'win32'), windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }, 'win32');
  if (result.error || result.status !== 0 || result.stdout !== 'multivac-acl-v1') throw new Error('Windows 私有目录 ACL 无法确认，未写入或重建凭据。');
  const after = lstatSync(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || realpathSync(directory) !== canonical)
    throw new Error('私有目录在 ACL 核对期间发生变化。');
}
export function secureWindowsPrivateFile(path: string): void {
  const directory = dirname(resolve(path));
  secureWindowsPrivateDirectory(directory, basename(path));
}
