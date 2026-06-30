import { spawn } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.VIDIQ_TOKEN || 'vidiq_fbp35c01WLKBpeW9H5nhnoJEKKS2NcmtWYj_yvZX';
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
