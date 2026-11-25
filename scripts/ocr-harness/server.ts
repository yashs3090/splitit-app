// Local server for the OCR harness (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 4).
// - Listens on 127.0.0.1 only, on a random free port.
// - Read-only: GET/HEAD only. Serves the harness page, the in-memory page bundle, files under public/
//   (the self-hosted Tesseract assets, later OpenCV), and the listed photos under /photos/.
// - Never writes anything, and never serves a path outside those folders.
// - Answers only requests whose Host header is exactly 127.0.0.1:<its port> (403 otherwise), so a
//   web page that rebinds its own name to 127.0.0.1 can't read photos from it (review R8).
// Also exports `startProxyTrap`: a fake proxy on 127.0.0.1 that the browser is pointed at, so any
// request to another host (from the page or from a worker) lands here, is refused and is recorded.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, resolve, sep } from 'node:path';

export const HOST = '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  // Tesseract.js fetches eng.traineddata.gz and gunzips it itself: no Content-Encoding header.
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OCR harness</title></head>
<body><script src="/harness.js"></script></body></html>
`;

/** True for the harness server's own origin and for in-page URLs (blob:, data:, about:blank). */
export function isLocal(url: string, origin: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:') || url === 'about:blank') return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export type HarnessServer = { origin: string; close(): Promise<void> };

/** A path under `root`, or null if `rel` escapes it or isn't a regular file. */
function fileUnder(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, `.${sep}${rel}`);
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

function listen(server: Server): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, HOST, () => ok((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  return new Promise((ok) => server.close(() => ok()));
}

export async function startHarnessServer(opts: {
  publicDir: string;
  photosDir: string;
  /** Photo file names that may be served (top level of `photosDir`). */
  photos: readonly string[];
  bundle: string;
  /**
   * Serve /opencv/ from this folder (the harness's private build, cvAssets.ts) instead of
   * public/opencv/, so a stale or deleted public copy is never used.
   */
  opencvDir?: string;
}): Promise<HarnessServer> {
  const photos = new Set(opts.photos);
  const sockets = new Set<Socket>();
  // Set once the port is known; nothing can connect before then.
  let ownHost: string | null = null;
  const server = createServer((req, res) => {
    if (ownHost === null || req.headers.host !== ownHost) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === '/') return send(200, TYPES['.html'] ?? 'text/html', PAGE_HTML);
    if (path === '/harness.js') return send(200, TYPES['.js'] ?? 'text/javascript', opts.bundle);

    let file: string | null = null;
    if (path.startsWith('/photos/')) {
      const name = path.slice('/photos/'.length);
      if (photos.has(name)) file = fileUnder(opts.photosDir, name);
    } else if (opts.opencvDir !== undefined && path.startsWith('/opencv/')) {
      file = fileUnder(opts.opencvDir, path.slice('/opencv/'.length));
    } else {
      file = fileUnder(opts.publicDir, path.replace(/^\/+/, ''));
    }
    if (!file) return send(404, 'text/plain', 'not found');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listen(server);
  ownHost = `${HOST}:${port}`;
  return { origin: `http://${ownHost}`, close: () => closeServer(server, sockets) };
}

export type ProxyTrap = { server: string; hits: string[]; close(): Promise<void> };

/**
 * A "proxy" that refuses everything. The browser sends every non-loopback request here (plain HTTP
 * as a request, HTTPS as CONNECT), so nothing reaches the network; each one is recorded in `hits`.
 */
export async function startProxyTrap(): Promise<ProxyTrap> {
  const hits: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? '?'} ${req.url ?? '?'}`);
    res.writeHead(403).end();
  });
  server.on('connect', (req, socket: Socket) => {
    hits.push(`CONNECT ${req.url ?? '?'}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listen(server);
  return { server: `http://${HOST}:${port}`, hits, close: () => closeServer(server, sockets) };
}
