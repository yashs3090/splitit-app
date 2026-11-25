import { Text } from 'react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

// Smoke test: proves Jest + jest-expo + Expo Router's test renderer are wired up.
describe('test harness', () => {
  it('renders a route with the Expo Router test renderer', () => {
    const router = renderRouter({ index: () => <Text>SplitIt smoke</Text> }, { initialUrl: '/' });
    expect(screen.getByText('SplitIt smoke')).toBeTruthy();
    expect(router.getPathname()).toBe('/');
  });
});
