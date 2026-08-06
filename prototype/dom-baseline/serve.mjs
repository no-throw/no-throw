// PROTOTYPE — throwaway (#26). Static server so the probe page runs as a real document.
import http from 'node:http';
import fs from 'node:fs';
http
  .createServer((req, res) => {
    const raw = req.url.split('?')[0];
    const p = raw === '/' ? '/out/fuzz.html' : raw;
    let body;
    try {
      body = fs.readFileSync('.' + p);
    } catch {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain' });
    res.end(body);
  })
  .listen(8731, () => console.log('http://localhost:8731/'));
