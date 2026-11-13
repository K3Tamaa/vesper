import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Run a command and collect output. Never uses a shell: every argument stays
 * one argv entry, so a URL can never be interpreted as code.
 */
export function run(command, args, options = {}) {
  const { timeout = 60_000, env = process.env, cwd } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Long-running process with line-oriented output, used by download jobs.
 */
export class LineProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const splitter = (stream, channel) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line) this.emit('line', { channel, line });
        }
      });
      stream.on('end', () => {
        if (buffer.trim()) this.emit('line', { channel, line: buffer.trim() });
      });
    };

    splitter(this.child.stdout, 'stdout');
    splitter(this.child.stderr, 'stderr');

    this.child.on('error', (error) => this.emit('failed', error));
    this.child.on('close', (code, signal) => this.emit('exit', { code, signal }));
  }

  get pid() {
    return this.child.pid;
  }

  stop(signal = 'SIGTERM') {
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch {
      try { this.child.kill(signal); } catch {}
    }
  }
}
