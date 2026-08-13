'use strict';

const { spawn } = require('node:child_process');

const running = new Set();

/** Run Fly's deploy command in exactly the directory configured for the project. */
function deploy(project) {
  if (running.has(project.id)) throw new Error('A deployment is already running for this project');
  running.add(project.id);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FLY_BIN || 'fly', ['deploy'], {
      cwd: project.directory,
      windowsHide: true,
      shell: false,
    });
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (err) => reject(new Error(`Could not start fly deploy: ${err.message}`)));
    child.once('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(output.trim() || `fly deploy exited with code ${code}`));
    });
  }).finally(() => running.delete(project.id));
}

module.exports = { deploy };
