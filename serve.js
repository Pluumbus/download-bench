#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'samples');

const TYPES = {
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const FILES = ['picture.png', 'document.pdf', 'table.xlsx'];

function fileFromUrl(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const cleaned = decoded.replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;

  const file = join(ROOT, cleaned);
  const rel = relative(ROOT, file);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.includes(':')) return null;
  return file;
}

function send(res, status, body) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    send(res, 405, 'Разрешены только GET и HEAD\n');
    return;
  }

  const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  if (pathname === '/') {
    const body = FILES.map((name) => `http://${HOST}:${PORT}/${name}`).join('\n') + '\n';
    send(res, 200, req.method === 'HEAD' ? '' : body);
    return;
  }

  const file = fileFromUrl(pathname);
  if (!file) {
    send(res, 400, 'Некорректный путь\n');
    return;
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    send(res, 404, 'Файл не найден\n');
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, 'Файл не найден\n');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
    console.error(`Порт ${PORT} занят.`);
    console.error('PowerShell: $env:PORT=3456; node serve.js');
    console.error('Git Bash:   PORT=3456 node serve.js');
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`samples/ доступны на http://${HOST}:${PORT}/`);
  for (const name of FILES) console.log(`  http://${HOST}:${PORT}/${name}`);
});
