// Review R10 / visual pass V17: the web page template paints the theme background in light and
// dark before the app loads, and keeps Expo's template placeholders and root element.
import { colors } from '@/lib/theme';

// The project's pattern for reading files in tests (the app tsconfig has no Node types).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const html = fs.readFileSync(`${process.cwd()}/public/index.html`, 'utf8');
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
