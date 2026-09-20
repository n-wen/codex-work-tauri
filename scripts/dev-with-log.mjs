#!/usr/bin/env node
/**
 * Run `tauri dev` while teeing stdout/stderr to logs/dev.log
 * so agents / other terminals can tail the file.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(root, 'logs');
const logPath = join(logDir, 'dev.log');

mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString();
const log = createWriteStream(logPath, { flags: 'a' });
log.write(`\n===== codex-work dev start ${stamp} =====\n`);

const child = spawn('npx', ['tauri', 'dev'], {
  cwd: root,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

function pipe(stream, out) {
  stream.on('data', (chunk) => {
    out.write(chunk);
    log.write(chunk);
  });
}

pipe(child.stdout, process.stdout);
pipe(child.stderr, process.stderr);

child.on('error', (err) => {
  const msg = `[dev-with-log] failed to start: ${err}\n`;
  process.stderr.write(msg);
  log.write(msg);
  process.exit(1);
});

const shutdown = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  log.write(
    `===== codex-work dev end code=${code} signal=${signal ?? ''} ${new Date().toISOString()} =====\n`,
  );
  log.end();
  process.exit(code ?? (signal ? 1 : 0));
});

console.error(`[dev-with-log] writing to ${logPath}`);
