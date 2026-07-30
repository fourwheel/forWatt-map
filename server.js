// Minimal zero-dep static server for local preview. GitHub Pages serves these
// same files directly; the for.Watt coverage is a static data/forwatt-coverage.json
// kept fresh by .github/workflows/update-coverage.yml.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if ((req.headers['accept-encoding'] || '').includes('gzip') && buf.length > 4096 && /\.(json|js|css|html|svg)$/.test(file)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return res.end(zlib.gzipSync(buf));
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}).listen(PORT, () => console.log(`VNB-Karte clone: http://localhost:${PORT}`));
