// pm2 process file for running MetaCode on a server — see docs/deploy-vps.md.
//
//   pm2 start ecosystem.config.cjs                          first start
//   pm2 startOrReload ecosystem.config.cjs --update-env     after an update (both apps)
//   pm2 logs metacode                                       what the server says (Wisp/proxy hints included)
//   pm2 logs metacode-opencode                              what the AI service says
//
// Two apps:
//   metacode           server.js, the website and its API (PORT, default 3000)
//   metacode-opencode  opencode/server.mjs, MetaCode's OpenCode service, which
//                      talks to the AI providers (on 127.0.0.1:4097, not
//                      reachable from outside) — see docs/opencode-service.md
//
// MetaCode is told not to start the service itself (OPENCODE_SERVICE_MANAGED=off),
// since pm2 runs it here. Both run in fork mode, one process each: scraper jobs,
// their live progress and the Wisp WebSockets live in MetaCode's memory, so
// cluster mode (several processes behind one port) would split them up.
// Settings (keys, PORT, PUBLIC_URL) come from .env next to server.js, which
// both apps read; not from here.
const fs = require('fs');
const path = require('path');

// A Python virtual environment in .venv (docs/deploy-vps.md, step 3) is used
// for Analyze CSV, the scraper's server engine and the AI service's requests
// to the gateway.
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
    env: Object.assign({}, env, { OPENCODE_SERVICE_MANAGED: 'off' })
  }, {
    name: 'metacode-opencode',
    script: 'opencode/server.mjs',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    exp_backoff_restart_delay: 200,   // a port still held by the previous copy: try again, waiting longer each time
    kill_timeout: 3000,               // on stop, running AI answers get up to ~2.5 s to finish or say why they stopped
    time: true,
    env
  }]
};
