// The Appearance preference (Auto / Light / Dark): a device-local store, no database.
import { Appearance, Platform } from 'react-native';

import { storage as realStorage } from './storage';
import type { MemoryStorage } from '@/test-utils/fakes';
import {
  applyWebAppearance,
  getThemePreference,
  loadThemePreference,
  parseThemePreference,
  resetThemePreferenceForTests,
  resolveScheme,
  setThemePreference,
  subscribeThemePreference,
  THEME_PREFERENCE_KEY,
  THEME_PREFERENCE_OPTIONS,
} from './themePreference';

jest.mock('./storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const storage = realStorage as unknown as MemoryStorage;
const originalOS = Platform.OS;

beforeEach(() => {
  storage.data.clear();
  Platform.OS = originalOS;
  resetThemePreferenceForTests();
});
afterAll(() => {
  Platform.OS = originalOS;
});

describe('parseThemePreference', () => {
  it.each(['system', 'light', 'dark'] as const)('keeps %s', (v) => {
    expect(parseThemePreference(v)).toBe(v);
  });
  it.each([null, undefined, '', 'Dark', 'auto', 'blue', 42, {}])('treats %p as Auto (system)', (v) => {
    expect(parseThemePreference(v)).toBe('system');
  });
});

describe('resolveScheme', () => {
  it('Auto follows the device, and anything but dark is light', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('system', 'unspecified')).toBe('light');
  });
  it('Light and Dark win over the device in both directions', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('dark', null)).toBe('dark');
  });
});

it('offers Auto / Light / Dark, in that order', () => {
  expect(THEME_PREFERENCE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
    ['system', 'Auto'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ]);
});

describe('store', () => {
  it('defaults to Auto with nothing stored', async () => {
    await loadThemePreference();
    expect(getThemePreference()).toBe('system');
  });

  it('set applies at once, tells subscribers and saves to device storage', async () => {
    const seen: string[] = [];
    const off = subscribeThemePreference(() => seen.push(getThemePreference()));
    const saving = setThemePreference('dark');
    expect(getThemePreference()).toBe('dark'); // before the write finishes
    await saving;
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('dark');
    expect(seen).toEqual(['dark']);
    off();
    await setThemePreference('light');
    expect(seen).toEqual(['dark']); // unsubscribed
  });

  it('setting the same value again neither notifies nor writes', async () => {
    await setThemePreference('dark');
    storage.data.delete(THEME_PREFERENCE_KEY);
    const listener = jest.fn();
    subscribeThemePreference(listener);
    await setThemePreference('dark');
    expect(listener).not.toHaveBeenCalled();
    expect(storage.data.has(THEME_PREFERENCE_KEY)).toBe(false);
  });

  it('loads the stored choice (a remount or relaunch keeps it)', async () => {
    storage.data.set(THEME_PREFERENCE_KEY, 'light');
    const listener = jest.fn();
    subscribeThemePreference(listener);
    await loadThemePreference();
    expect(getThemePreference()).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a malformed stored value reads as Auto', async () => {
    storage.data.set(THEME_PREFERENCE_KEY, '{"oops":1}');
    await loadThemePreference();
    expect(getThemePreference()).toBe('system');
  });

  it('a choice made while the stored value is still loading wins', async () => {
    storage.data.set(THEME_PREFERENCE_KEY, 'light');
    const loading = loadThemePreference();
    await setThemePreference('dark');
    await loading;
    expect(getThemePreference()).toBe('dark');
  });

  it('a failed read or write never throws; the choice still applies for this session', async () => {
    const getItem = jest.spyOn(storage, 'getItem').mockRejectedValueOnce(new Error('locked'));
    await expect(loadThemePreference()).resolves.toBeUndefined();
    expect(getThemePreference()).toBe('system');
    getItem.mockRestore();
    const setItem = jest.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('full'));
    await expect(setThemePreference('dark')).resolves.toBeUndefined();
    expect(getThemePreference()).toBe('dark');
    setItem.mockRestore();
  });

  it('on web, the stored choice is read synchronously, so the first render already has it', () => {
    Platform.OS = 'web';
    // Jest's environment has no localStorage; stand one in for the browser's.
    const w = window as unknown as { localStorage?: Pick<Storage, 'getItem'> };
    w.localStorage = { getItem: (k) => (k === THEME_PREFERENCE_KEY ? 'dark' : null) };
    try {
      resetThemePreferenceForTests();
      expect(getThemePreference()).toBe('dark');
    } finally {
      delete w.localStorage;
    }
  });

  it('on web without localStorage (private mode quirks), it falls back to Auto', () => {
    Platform.OS = 'web';
    const w = window as unknown as { localStorage?: Pick<Storage, 'getItem'> };
    w.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    try {
      resetThemePreferenceForTests();
      expect(getThemePreference()).toBe('system');
    } finally {
      delete w.localStorage;
    }
  });
});

describe('native Appearance override', () => {
  it('forces the native scheme for a fixed choice and releases it for Auto', async () => {
    Platform.OS = 'ios';
    const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
    await setThemePreference('dark');
    expect(spy).toHaveBeenLastCalledWith('dark');
    await setThemePreference('system');
    expect(spy).toHaveBeenLastCalledWith('unspecified');
    spy.mockRestore();
  });

  it('is not used on web (react-native-web has no override; the page is themed instead)', async () => {
    Platform.OS = 'web';
    const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
    await setThemePreference('dark');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/** A small stand-in for the page head: <html>, the color-scheme meta and the two theme-color metas. */
function fakeDocument() {
  const attrs = new Map<string, string>();
  const meta = (name: string, media: string | null, content: string) => {
    const a = new Map<string, string>([['name', name], ['content', content]]);
    if (media) a.set('media', media);
    return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => void a.set(k, v) };
  };
  const metas = [
    meta('color-scheme', null, 'light dark'),
    meta('theme-color', '(prefers-color-scheme: light)', '#F3F4F6'),
    meta('theme-color', '(prefers-color-scheme: dark)', '#0B0F14'),
  ];
  const documentElement = {
    style: { colorScheme: '' },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
  return {
    documentElement,
    querySelectorAll: (sel: string) => metas.filter((m) => sel.includes(`"${m.getAttribute('name')}"`)),
    metas,
  };
}

describe('applyWebAppearance', () => {
  it('forces the page background, browser tint and form controls for Light and Dark, and restores them for Auto', () => {
    const doc = fakeDocument();
    const [scheme, lightTint, darkTint] = doc.metas;
    applyWebAppearance('dark', doc);
    expect(doc.documentElement.getAttribute('data-appearance')).toBe('dark');
    expect(doc.documentElement.style.colorScheme).toBe('dark');
    expect(scheme?.getAttribute('content')).toBe('dark');
    expect(lightTint?.getAttribute('content')).toBe('#0B0F14');
    expect(darkTint?.getAttribute('content')).toBe('#0B0F14');

    applyWebAppearance('light', doc);
    expect(doc.documentElement.getAttribute('data-appearance')).toBe('light');
    expect(lightTint?.getAttribute('content')).toBe('#F3F4F6');
    expect(darkTint?.getAttribute('content')).toBe('#F3F4F6');

    applyWebAppearance('system', doc);
    expect(doc.documentElement.getAttribute('data-appearance')).toBeNull();
    expect(doc.documentElement.style.colorScheme).toBe('');
    expect(scheme?.getAttribute('content')).toBe('light dark');
    expect(lightTint?.getAttribute('content')).toBe('#F3F4F6');
    expect(darkTint?.getAttribute('content')).toBe('#0B0F14');
  });
});
