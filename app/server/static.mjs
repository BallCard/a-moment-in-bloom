import {readFile, stat} from 'node:fs/promises';
import {extname} from 'node:path';
import {gzip as gzipCallback} from 'node:zlib';
import {promisify} from 'node:util';
const gzip = promisify(gzipCallback);
// Only Vite fingerprinted bundles are immutable. GLBs, thumbs and manifest keep
// their URLs across releases and must revalidate, otherwise fixes remain hidden.
const compressed = new Map();
let compressedBytes = 0;
function acceptsGzip(value = '') {
  const entries = value.split(',').map(part => part.trim().split(';'));
  const entry = entries.find(([name]) => name.toLowerCase() === 'gzip')
    ?? entries.find(([name]) => name === '*');
  return Boolean(entry && !entry.slice(1).some(p => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(p)));
}
export async function serveStatic(req, res, path, pathname, mime) {
  const info = await stat(path);
  if (!info.isFile()) throw Error('not_file');
  const type = mime[extname(path)] ?? 'application/octet-stream';
  const zipped = /^(text\/|application\/json|image\/svg)/.test(type) && acceptsGzip(req.headers['accept-encoding']);
  const tag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${zipped ? 'gz' : 'raw'}"`;
  const headers = {'Content-Type': type, 'ETag': tag, 'Vary': 'Accept-Encoding',
    'Cache-Control': /^\/assets\/[^/]+-[\w-]{8,}\.(js|css)$/.test(pathname)
      ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate'};
  if (zipped) headers['Content-Encoding'] = 'gzip';
  if (req.headers['if-none-match']?.split(',').map(x => x.trim()).some(x => x === tag || x === '*')) {
    res.writeHead(304, headers); res.end(); return;
  }
  let data;
  if (zipped) {
    const key = `${path}:${tag}`;
    data = compressed.get(key);
    if (!data) {
      data = await gzip(await readFile(path));
      // A concurrent request may already have populated this representation.
      if (compressed.has(key)) data = compressed.get(key);
      // Bounded process cache; no model buffers are retained here.
      if (!compressed.has(key) && data.length <= 8 * 1024 * 1024) {
        while (compressedBytes + data.length > 8 * 1024 * 1024) {
          const first = compressed.keys().next().value;
          compressedBytes -= compressed.get(first).length; compressed.delete(first);
        }
        compressed.set(key, data); compressedBytes += data.length;
      }
    }
  } else if (req.method !== 'HEAD') data = await readFile(path);
  headers['Content-Length'] = data?.length ?? info.size;
  res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : data);
}
