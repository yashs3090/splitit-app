// Slice A1.1 (docs/before-production.md §5): the Vercel settings the friend-test deploy depends on.
// Checked against https://vercel.com/docs/project-configuration/vercel-json (2026-11-25).

// The project's pattern for reading files in tests (the app tsconfig has no Node types).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');

type VercelJson = {
  buildCommand?: unknown;
  outputDirectory?: unknown;
  framework?: unknown;
  rewrites?: unknown;
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};

const config = JSON.parse(fs.readFileSync(`${process.cwd()}/vercel.json`, 'utf8')) as VercelJson;
const pkg = JSON.parse(fs.readFileSync(`${process.cwd()}/package.json`, 'utf8')) as {
  scripts: Record<string, string>;
};

describe('vercel.json', () => {
  it('builds through npm run export:web, whose pre-hook copies the Tesseract assets', () => {
    expect(config.buildCommand).toBe('npm run export:web');
    expect(pkg.scripts['preexport:web']).toMatch(/copy-tesseract-assets/);
  });

  it('serves the dist/ folder that export:web writes', () => {
    expect(config.outputDirectory).toBe('dist');
    expect(pkg.scripts['export:web']).toMatch(/expo export\b.*-p web/);
  });

  it('uses no framework preset ("Other")', () => {
    expect(config.framework).toBeNull();
  });

  // Changed 2026-11-26 (app links, docs/setup/app-links.md): the single SPA rewrite now skips
  // /.well-known/, so a missing apple-app-site-association / assetlinks.json is a 404 rather than
  // index.html served as 200. Vercel serves real files before rewrites either way
  // (https://vercel.com/docs/project-configuration/vercel-json#rewrites: "precedence is given to the
  // filesystem prior to rewrites being applied").
  it('rewrites every path except /.well-known/ to /index.html, so a deep link like /b/<code> does not 404', () => {
    expect(config.rewrites).toEqual([{ source: '/:path((?!\\.well-known/).*)', destination: '/index.html' }]);
  });

  // The same pattern as a plain RegExp (path-to-regexp turns `/:path(X)` into `^/(X)$`). Vercel's own
  // matcher isn't run here: check the live site with curl (docs/setup/app-links.md).
  describe('which paths the SPA rewrite matches', () => {
    const rewrite = (config.rewrites as { source: string }[])[0]!;
    const inner = /^\/:path\((.*)\)$/.exec(rewrite.source)?.[1];
    const re = new RegExp(`^/(${inner ?? 'never-matches-$'})$`);

    it.each(['/', '/b/AbCdEf1234', '/b/AbCdEf1234/', '/sign-in', '/auth/callback', '/bills/123', '/well-known/x', '/x/.well-known/y'])(
      'rewrites %s',
      (path) => {
        expect(re.test(path)).toBe(true);
      },
    );

    it.each(['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json', '/.well-known/other'])(
      'does not rewrite %s',
      (path) => {
        expect(re.test(path)).toBe(false);
      },
    );
  });

  it('sends both well-known files as application/json and keeps the existing headers', () => {
    const header = (source: string, key: string) =>
      config.headers?.find((h) => h.source === source)?.headers.find((x) => x.key === key)?.value;
    expect(header('/.well-known/apple-app-site-association', 'Content-Type')).toBe('application/json');
    expect(header('/.well-known/assetlinks.json', 'Content-Type')).toBe('application/json');
    expect(header('/_expo/static/(.*)', 'Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(header('/tesseract/lang/(.*).gz', 'Content-Type')).toBe('application/gzip');
    expect(header('/tesseract/(.*)', 'Cache-Control')).toMatch(/max-age=86400/);
    expect(header('/opencv/(.*)', 'Cache-Control')).toMatch(/max-age=86400/);
  });

  it('writes the well-known files before every web build and dev server', () => {
    for (const hook of ['preexport:web', 'preweb', 'prestart']) {
      expect(pkg.scripts[hook]).toMatch(/write-well-known/);
    }
  });
});
