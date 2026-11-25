// Review R9 (visual pass V2): a route that paints no background of its own still sits on the
// theme background in dark mode, because the stacks set contentStyle. Also R6: the sign-in
// wordmark is a header.
import { renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet, Text } from 'react-native';

import * as SystemUI from 'expo-system-ui';

import RootLayout from '@/app/_layout';
import { colors } from '@/lib/theme';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(async () => {}) }));

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'dark');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

type Node = { props: { style?: unknown }; parent: Node | null };
/** The nearest ancestor that paints a background. */
function paintedBackground(node: Node): unknown {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    const bg = (StyleSheet.flatten(n.props.style as never) as { backgroundColor?: unknown } | undefined)?.backgroundColor;
    if (bg !== undefined) return bg;
  }
  return undefined;
}

it.each(['light', 'dark'] as const)('a bare route sits on the theme background (%s)', async (scheme) => {
  mockScheme.mockReturnValue(scheme);
  renderRouter({ _layout: RootLayout, probe: () => <Text>Bare route</Text> }, { initialUrl: '/probe' });
  const text = await screen.findByText('Bare route');
  expect(paintedBackground(text as unknown as Node)).toBe(colors[scheme].background);
});

it('the sign-in wordmark is a header (R6)', async () => {
  renderRouter('./app', { initialUrl: '/sign-in' });
  expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
});

it.each(['light', 'dark'] as const)('the native root view gets the theme background (%s, V17)', async (scheme) => {
  mockScheme.mockReturnValue(scheme);
  renderRouter({ _layout: RootLayout, probe: () => <Text>Bare route</Text> }, { initialUrl: '/probe' });
  await screen.findByText('Bare route');
  expect(SystemUI.setBackgroundColorAsync).toHaveBeenLastCalledWith(colors[scheme].background);
});
