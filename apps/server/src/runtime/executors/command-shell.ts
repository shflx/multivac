import { powershellCommandShell } from './powershell-command.js';
export interface CommandShell {
  readonly name: string;
  readonly syntax: string;
  launch(command: string): { file: string; args: string[] };
}

/** 根 bash 保留私有握手 fd；原命令不继承握手，命令完成与整个树退出分开核对。 */
export const BASH_ANCHOR_COMMAND = '/bin/bash --noprofile --norc -c "$1" 3<&- 4>&-; multivac_command_status=$?; printf "%s\\n" "$multivac_command_status" >&4; IFS= read -r -u 3; exit "$multivac_command_status"';
export const bashCommandShell: CommandShell = {
  name: 'bash', syntax: 'bash（--noprofile --norc）',
  launch: command => ({ file: '/bin/bash', args: ['--noprofile', '--norc', '-c', BASH_ANCHOR_COMMAND, 'multivac-bash', command] }),
};

export function createCommandShell(platform: NodeJS.Platform = process.platform): CommandShell {
  return platform === 'win32' ? powershellCommandShell() : bashCommandShell;
}
