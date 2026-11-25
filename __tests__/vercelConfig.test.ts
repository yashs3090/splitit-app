// Slice A1.1 (docs/before-production.md §5): the Vercel settings the friend-test deploy depends on.
// Checked against https://vercel.com/docs/project-configuration/vercel-json (2026-11-25).

// The project's pattern for reading files in tests (the app tsconfig has no Node types).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');

type VercelJson = {
  buildCommand?: unknown;
  outputDirectory?: unknown;
  framework?: unknown;
  rewrites?: unknown;
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

  it('rewrites every path to /index.html so a deep link like /b/<code> does not 404', () => {
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });
});
