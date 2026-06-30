import { spawn } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.VIDIQ_TOKEN;
if (!token) {
  console.error("Error: VIDIQ_TOKEN environment variable is not set.");
  process.exit(1);
}
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const proc = spawn(command, [
  '-y',
  'mcp-remote',
  'https://mcp.vidiq.com/mcp',
  '--header',
  `Authorization: Bearer ${token}`
], {
  stdio: 'inherit',
  shell: true
});

proc.on('exit', (code) => {
  process.exit(code || 0);
});
