// The global stand-in for lib/useUsernameStatus (docs/specs/2026-11-28-usernames.md A3.8): every
// router suite runs as a user whose username is already picked (locked), so the "Choose your
// username" gate never shows and no my_username_status read joins the call logs those suites assert
// on. test-utils/jestSetup.ts installs it; the gate's own tests call jest.unmock('@/lib/useUsernameStatus').

/** The username the stand-in reports for any signed-in user. */
export const LOCKED_TEST_USERNAME = 'test_user';

export function lockedUsernameStatus(): typeof import('@/lib/useUsernameStatus') {
  const actual = jest.requireActual<typeof import('@/lib/useUsernameStatus')>('@/lib/useUsernameStatus');
  const noop = () => {};
  return {
    ...actual,
    useUsernameStatus: (userId: string | null) =>
      userId === null
        ? { status: 'idle', retry: noop, markLocked: noop }
        : { status: 'ready', username: LOCKED_TEST_USERNAME, locked: true, retry: noop, markLocked: noop },
  };
}
