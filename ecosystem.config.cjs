// pm2 process file for running MetaCode on a server — see docs/deploy-vps.md.
//
//   pm2 start ecosystem.config.cjs     first start
//   pm2 reload metacode                after an update
//   pm2 logs metacode                  what the server says (Wisp/proxy hints included)
//
// One process, fork mode: scraper jobs, their live progress and the Wisp
// WebSockets live in this process's memory, so cluster mode (several
// processes behind one port) would split them up. Settings (keys, PORT,
// PUBLIC_URL) come from .env next to server.js, not from here.
const fs = require('fs');
const path = require('path');

// A Python virtual environment in .venv (docs/deploy-vps.md, step 3) is used
// for Analyze CSV, the AI requests and the scraper's server engine.
const venvBin = path.join(__dirname, '.venv', 'bin');
const env = { NODE_ENV: 'production' };
if (fs.existsSync(venvBin)) env.PATH = venvBin + path.delimiter + (process.env.PATH || '');

module.exports = {
  apps: [{
    name: 'metacode',
    script: 'server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    time: true,            // timestamps in pm2 logs
    env
  }]
};
