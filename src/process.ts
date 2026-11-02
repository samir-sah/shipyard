import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface CommandOptions {
  timeoutMs: number;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        const text = decoders[stream].write(chunk);
        captured = (captured + text).slice(-65_536);
        options.onOutput?.(stream, text);
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = decoders[stream].end();
        if (text) options.onOutput?.(stream, text);
      }
      if (timedOut) reject(new Error(`Command exceeded ${options.timeoutMs} ms`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${captured.slice(-1_500).trim()}`));
      else resolve(captured);
    });
  });
}
