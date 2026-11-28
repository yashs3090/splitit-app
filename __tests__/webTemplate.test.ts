// Review R10 / visual pass V17: the web page template paints the theme background in light and
// dark before the app loads, and keeps Expo's template placeholders and root element.
// Home mobile refresh, Task 3 (criteria 22-27): the phone-facing head (viewport, theme-color,
// manifest, touch icon, tap highlight), the manifest itself and its icons.
import { colors } from '@/lib/theme';

// The project's pattern for reading files in tests (the app tsconfig has no Node types).
const fs = jest.requireActual<{
  readFileSync(file: string, encoding: 'utf8'): string;
  readFileSync(file: string): Uint8Array;
  existsSync(file: string): boolean;
}>('fs');
const childProcess = jest.requireActual<{
  spawnSync(cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }): { status: number | null; stdout: string; stderr: string };
}>('child_process');
const root = process.cwd();
const html = fs.readFileSync(`${root}/public/index.html`, 'utf8');
const css = (html.match(/<style id="splitit-background">([\s\S]*?)<\/style>/) ?? [])[1] ?? '';
const [light, dark] = css.split('@media (prefers-color-scheme: dark)');

it('keeps the template placeholders and the root element Expo fills', () => {
  expect(html).toContain('%LANG_ISO_CODE%');
  expect(html).toContain('%WEB_TITLE%');
  expect(html).toContain('<div id="root"></div>');
});

it('declares both color schemes', () => {
  expect(html).toContain('<meta name="color-scheme" content="light dark" />');
});

it('paints the light background by default and the dark one under prefers-color-scheme: dark', () => {
  expect(light?.toUpperCase()).toContain(`BACKGROUND-COLOR: ${colors.light.background.toUpperCase()}`);
  expect(dark?.toUpperCase()).toContain(`BACKGROUND-COLOR: ${colors.dark.background.toUpperCase()}`);
});

/** Every `<meta ...>` / `<link ...>` tag in the template, as attribute maps. */
function tags(kind: 'meta' | 'link'): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${kind}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...(m[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? ''])),
  );
}

describe('phone head (criteria 22-24)', () => {
  it('lets content reach the safe areas and never disables zoom', () => {
    const viewport = tags('meta').filter((t) => t.name === 'viewport');
    expect(viewport).toHaveLength(1);
    const parts = (viewport[0]?.content ?? '').split(',').map((p) => p.trim());
    expect(parts).toEqual(expect.arrayContaining(['width=device-width', 'initial-scale=1', 'viewport-fit=cover']));
    expect(html).not.toMatch(/maximum-scale|user-scalable/);
  });

  it('has exactly one theme-color per scheme, equal to the theme backgrounds', () => {
    const theme = tags('meta').filter((t) => t.name === 'theme-color');
    expect(theme).toHaveLength(2);
    const light = theme.find((t) => t.media === '(prefers-color-scheme: light)');
    const dark = theme.find((t) => t.media === '(prefers-color-scheme: dark)');
    expect(light?.content?.toUpperCase()).toBe(colors.light.background.toUpperCase());
    expect(dark?.content?.toUpperCase()).toBe(colors.dark.background.toUpperCase());
  });

  it('links the manifest and touch icon and names the home-screen app', () => {
    const links = tags('link');
    expect(links).toContainEqual(expect.objectContaining({ rel: 'manifest', href: '/manifest.webmanifest' }));
    expect(links).toContainEqual(expect.objectContaining({ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }));
    expect(tags('meta')).toContainEqual(expect.objectContaining({ name: 'apple-mobile-web-app-title', content: 'SplitIt' }));
  });

  it('turns off the tap highlight on html', () => {
    const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '').join('\n');
    expect(css).toMatch(/(^|[\s,}])html\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent\s*;?[^}]*\}/);
  });

  it('has no Smart App Banner meta (AB-10)', () => {
    expect(html).not.toContain('apple-itunes-app');
  });
});

const ICONS = [
  ['public/apple-touch-icon.png', 180],
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
] as const;

describe('manifest (criterion 25)', () => {
  type Manifest = {
    name?: unknown;
    short_name?: unknown;
    start_url?: unknown;
    display?: unknown;
    background_color?: unknown;
    theme_color?: unknown;
    icons?: { src: string; sizes: string; type: string }[];
  };
  const manifest = JSON.parse(fs.readFileSync(`${root}/public/manifest.webmanifest`, 'utf8')) as Manifest;

  it('names the app, opens at / in the browser, and uses the light background', () => {
    expect(manifest).toMatchObject({ name: 'SplitIt', short_name: 'SplitIt', start_url: '/', display: 'browser' });
    expect(String(manifest.background_color).toUpperCase()).toBe(colors.light.background.toUpperCase());
    expect(String(manifest.theme_color).toUpperCase()).toBe(colors.light.background.toUpperCase());
  });

  it('lists 192 and 512 PNG icons whose files exist under public/', () => {
    expect((manifest.icons ?? []).map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    for (const icon of manifest.icons ?? []) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/')).toBe(true);
      expect(fs.existsSync(`${root}/public${icon.src}`)).toBe(true);
    }
  });
});

describe('icons (criterion 26)', () => {
  it.each(ICONS)('%s is a %ipx square PNG under 200 KB', (file, size) => {
    const bytes = fs.readFileSync(`${root}/${file}`);
    // PNG signature, then the IHDR chunk: width at bytes 16-19, height at 20-23 (big-endian).
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([size, size]);
    expect(bytes.byteLength).toBeLessThan(200 * 1024);
  });
});

describe('not gitignored (criterion 27)', () => {
  const checkIgnore = (paths: string[]) => childProcess.spawnSync('git', ['check-ignore', ...paths], { cwd: root, encoding: 'utf8' });

  it('the check can see an ignored path (so an empty answer below means something)', () => {
    const known = checkIgnore(['public/tesseract/anything.js']);
    expect(known.status).toBe(0);
    expect(known.stdout.trim()).toBe('public/tesseract/anything.js');
  });

  it('ignores none of the manifest or icon files', () => {
    const result = checkIgnore(['public/manifest.webmanifest', ...ICONS.map(([file]) => file)]);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1); // 1 = none of the paths is ignored
  });
});

// Appearance (Auto / Light / Dark, lib/themePreference.ts): a Light or Dark choice stored on this
// device wins over prefers-color-scheme from the first paint, before the bundle loads, so there's no
// flash of the wrong theme. An inline script in <head> reads the stored choice and does exactly what
// applyWebAppearance does once the app runs.
describe('Appearance before the bundle loads', () => {
  const { THEME_PREFERENCE_KEY, applyWebAppearance } = jest.requireActual<typeof import('@/lib/themePreference')>('@/lib/themePreference');
  const head = (html.match(/<head>([\s\S]*?)<\/head>/) ?? [])[1] ?? '';
  const script = (head.match(/<script id="splitit-appearance">([\s\S]*?)<\/script>/) ?? [])[1] ?? '';

  /** The parts of the page the script touches, recorded so two runs can be compared. */
  function fakePage() {
    const attrs = new Map<string, string>();
    const meta = (name: string, media: string | null, content: string) => {
      const a = new Map<string, string>([['name', name], ['content', content]]);
      if (media) a.set('media', media);
      return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => void a.set(k, v) };
    };
    const metas = [
      meta('color-scheme', null, 'light dark'),
      meta('theme-color', '(prefers-color-scheme: light)', colors.light.background),
      meta('theme-color', '(prefers-color-scheme: dark)', colors.dark.background),
    ];
    const documentElement = {
      style: { colorScheme: '' },
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null,
    };
    const doc = { documentElement, querySelectorAll: (sel: string) => metas.filter((m) => sel.includes(`"${m.getAttribute('name')}"`)) };
    const snapshot = () => ({
      appearance: attrs.get('data-appearance') ?? null,
      colorScheme: documentElement.style.colorScheme,
      metas: metas.map((m) => m.getAttribute('content')),
    });
    return { doc, snapshot };
  }

  function runScript(stored: string | null | Error) {
    const page = fakePage();
    const localStorage = {
      getItem: (k: string) => {
        if (stored instanceof Error) throw stored;
        return k === THEME_PREFERENCE_KEY ? stored : null;
      },
    };
    // The template's own script, run against the fake page (it may only use these two globals).
    new Function('document', 'localStorage', script)(page.doc, localStorage);
    return page.snapshot();
  }

  it('is an inline script in <head>, ahead of the app bundle', () => {
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain(THEME_PREFERENCE_KEY);
    expect(html.indexOf('id="splitit-appearance"')).toBeLessThan(html.indexOf('<body>'));
  });

  it.each(['light', 'dark', 'system', null, 'garbage'] as const)('stored %p: the page matches what the app applies', (stored) => {
    const expected = fakePage();
    applyWebAppearance(stored === 'light' || stored === 'dark' ? stored : 'system', expected.doc);
    expect(runScript(stored)).toEqual(expected.snapshot());
  });

  it('never throws when storage is blocked; the page stays on Auto', () => {
    expect(runScript(new Error('SecurityError'))).toEqual({
      appearance: null,
      colorScheme: '',
      metas: ['light dark', colors.light.background, colors.dark.background],
    });
  });

  it.each(['light', 'dark'] as const)('a forced %s paints its background over prefers-color-scheme', (scheme) => {
    const rule = new RegExp(`html\\[data-appearance="${scheme}"\\][^{]*\\{[^}]*background-color:\\s*${colors[scheme].background}`, 'i');
    expect(css).toMatch(rule);
    const bodyRule = new RegExp(`html\\[data-appearance="${scheme}"\\] body`);
    expect(css).toMatch(bodyRule);
  });
});
