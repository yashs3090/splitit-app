// Guards of the OCR harness server (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 4):
// 127.0.0.1 only, read-only, only listed photos, nothing outside public/ and the photo folder.
// Uses temporary folders with made-up files; no receipt photo is involved.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocal, startHarnessServer, startProxyTrap, type HarnessServer } from './server';

function get(url: string, method = 'GET', path?: string, hostHeader?: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const headers = hostHeader === undefined ? {} : { Host: hostHeader };
    const req = request({ host: u.hostname, port: u.port, path: path ?? u.pathname, method, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', fail);
    req.end();
  });
}

describe('isLocal', () => {
  const origin = 'http://127.0.0.1:5000';
  it('allows the server origin and in-page URLs', () => {
    expect(isLocal('http://127.0.0.1:5000/tesseract/worker.min.js', origin)).toBe(true);
    expect(isLocal('blob:http://127.0.0.1:5000/abc', origin)).toBe(true);
    expect(isLocal('data:image/png;base64,AAAA', origin)).toBe(true);
    expect(isLocal('about:blank', origin)).toBe(true);
  });
  it('refuses any other host, port or scheme', () => {
    expect(isLocal('https://cdn.jsdelivr.net/npm/tesseract.js', origin)).toBe(false);
    expect(isLocal('http://127.0.0.1:5001/', origin)).toBe(false);
    expect(isLocal('http://localhost:5000/', origin)).toBe(false);
    expect(isLocal('https://127.0.0.1:5000/', origin)).toBe(false);
    expect(isLocal('not a url', origin)).toBe(false);
  });
});

describe('startHarnessServer', () => {
  let dir: string;
  let server: HarnessServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ocr-harness-test-'));
    mkdirSync(join(dir, 'public', 'tesseract'), { recursive: true });
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'public', 'tesseract', 'worker.min.js'), 'worker');
    writeFileSync(join(dir, 'photos', 'listed.jpg'), 'jpeg');
    writeFileSync(join(dir, 'photos', 'unlisted.jpg'), 'secret');
    writeFileSync(join(dir, 'outside.txt'), 'outside');
    server = await startHarnessServer({
      publicDir: join(dir, 'public'),
      photosDir: join(dir, 'photos'),
      photos: ['listed.jpg'],
      bundle: 'BUNDLE',
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listens on 127.0.0.1', () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves the page, the bundle, public files and listed photos', async () => {
    expect((await get(`${server.origin}/`)).body).toContain('/harness.js');
    expect((await get(`${server.origin}/harness.js`)).body).toBe('BUNDLE');
    const worker = await get(`${server.origin}/tesseract/worker.min.js`);
    expect(worker).toMatchObject({ status: 200, body: 'worker' });
    expect(worker.type).toContain('javascript');
    expect(await get(`${server.origin}/photos/listed.jpg`)).toMatchObject({ status: 200, body: 'jpeg', type: 'image/jpeg' });
  });

  it('refuses any Host header other than 127.0.0.1:<port> (DNS rebinding; review R8)', async () => {
    const port = new URL(server.origin).port;
    expect((await get(`${server.origin}/`, 'GET', '/', `127.0.0.1:${port}`)).status).toBe(200);
    for (const host of [`localhost:${port}`, 'evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`]) {
      const r = await get(`${server.origin}/photos/listed.jpg`, 'GET', '/photos/listed.jpg', host);
      expect({ host, status: r.status, body: r.body }).toEqual({ host, status: 403, body: '' });
    }
  });

  it('does not serve unlisted photos or anything outside its folders', async () => {
    expect((await get(`${server.origin}/photos/unlisted.jpg`)).status).toBe(404);
    expect((await get(server.origin, 'GET', '/../outside.txt')).status).toBe(404);
    expect((await get(server.origin, 'GET', '/%2e%2e/outside.txt')).status).toBe(404);
    expect((await get(server.origin, 'GET', '/photos/..%2Foutside.txt')).status).toBe(404);
    expect((await get(`${server.origin}/tesseract`)).status).toBe(404); // a folder, not a file
  });

  it('is read-only', async () => {
    expect((await get(`${server.origin}/tesseract/worker.min.js`, 'PUT')).status).toBe(405);
    expect((await get(`${server.origin}/tesseract/worker.min.js`, 'POST')).status).toBe(405);
  });
});

describe('startHarnessServer with a private OpenCV folder (Task 9 harness fix)', () => {
  it('serves /opencv/ only from opencvDir, never from public/opencv/, and nothing outside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-harness-cv-'));
    mkdirSync(join(dir, 'public', 'opencv'), { recursive: true });
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'public', 'opencv', 'opencv.js'), 'STALE');
    writeFileSync(join(dir, 'public', 'opencv', 'only-public.js'), 'PUBLIC');
    writeFileSync(join(dir, 'private', 'opencv.js'), 'PRIVATE');
    const server = await startHarnessServer({
      publicDir: join(dir, 'public'),
      photosDir: dir,
      photos: [],
      bundle: '',
      opencvDir: join(dir, 'private'),
    });
    try {
      expect(await get(`${server.origin}/opencv/opencv.js`)).toMatchObject({ status: 200, body: 'PRIVATE' });
      expect((await get(`${server.origin}/opencv/only-public.js`)).status).toBe(404);
      expect((await get(server.origin, 'GET', '/opencv/%2e%2e/public/opencv/opencv.js')).status).toBe(404);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startProxyTrap', () => {
  it('refuses and records every request it receives', async () => {
    const trap = await startProxyTrap();
    try {
      expect(trap.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await get(trap.server, 'GET', 'http://example.com/leak');
      expect(res.status).toBe(403);
      expect(trap.hits).toEqual(['GET http://example.com/leak']);
    } finally {
      await trap.close();
    }
  });
});
