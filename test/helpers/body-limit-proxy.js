// A stand-in for a web server in front of MetaCode (or Supabase) with a
// request body limit, like nginx's client_max_body_size (its default is 1 MB):
// everything is forwarded to `target`, except a request whose body is larger
// than `limit` bytes, which gets nginx's own 413 page over HTTP/1.1 (so
// Chromium's console reads "413 (Request Entity Too Large)").
// opts.cors: add CORS headers to that page (a gateway that does, for a
// cross-origin target such as Supabase).
const http = require('http');

function bodyLimitProxy(target, limit, opts) {
  opts = opts || {};
  const t = new URL(target);
  const refused = [];         // { method, path, bytes }
  const passed = [];          // { method, path, bytes }
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => {
      if (size > limit) {
        refused.push({ method: req.method, path: req.url, bytes: size });
        const headers = { 'Content-Type': 'text/html' };
        if (opts.cors) Object.assign(headers, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*' });
        res.writeHead(413, 'Request Entity Too Large', headers);
        return res.end('<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n');
      }
      passed.push({ method: req.method, path: req.url, bytes: size });
      const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: req.headers }, upRes => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => up.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  return {
    server, refused, passed,
    async start() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      this.url = 'http://127.0.0.1:' + server.address().port;
      return this.url;
    },
    close() { server.closeAllConnections(); return new Promise(r => server.close(r)); }
  };
}

module.exports = { bodyLimitProxy };
