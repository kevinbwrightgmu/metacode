// Run by sandbox.test.js under the same Node permission flags as the sandbox
// process: reports what the process is allowed to do.
const fs = require('fs');
const path = require('path');
const result = {};
try { fs.readFileSync(path.join(__dirname, '..', '..', '.env.example')); result.readEnvFile = 'allowed'; } catch (e) { result.readEnvFile = e.code; }
try { fs.writeFileSync(path.join(__dirname, 'should-not-exist.txt'), 'x'); result.write = 'allowed'; } catch (e) { result.write = e.code; }
try { require('child_process').spawnSync('id'); result.spawn = 'allowed'; } catch (e) { result.spawn = e.code; }
result.env = Object.keys(process.env);
process.send(result, () => process.exit(0));
