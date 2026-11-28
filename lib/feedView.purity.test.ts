// lib/feedView.ts should be pure (no I/O): loading it should never reach lib/supabase or lib/storage.
// Both are mocked to throw on load, so any runtime import path to them fails to load.
//
// Known path outside the feed files (not ours to change): feedView → groupHomeView (groupHomeStatus,
// which the spec requires for the group-settled milestone) → groupView → groups (runtime import of
// `balanceInputOf`, lib/groupView.ts:11) → supabase. The `failing` test below records it; when
// `balanceInputOf` moves to a pure module it starts failing, and should become a plain `it`.
jest.mock('./supabase', () => {
  throw new Error('feedView reached lib/supabase');
});
jest.mock('./storage', () => {
  throw new Error('feedView reached lib/storage');
});

describe('feedView purity', () => {
  it('the feed files themselves reach neither (groupHomeView, the known outside path, stubbed)', () => {
    jest.isolateModules(() => {
      jest.doMock('./groupHomeView', () => ({ groupHomeStatus: () => ({ kind: 'settled' }) }));
      const mod = jest.requireActual<typeof import('./feedView')>('./feedView');
      expect(typeof mod.feedView).toBe('function');
    });
    jest.dontMock('./groupHomeView');
  });

  it.failing('feedView loads with nothing stubbed (fails today through groupView → groups; see the header)', () => {
    jest.isolateModules(() => {
      jest.requireActual('./feedView');
    });
  });

  it('positive control: a module that does reach lib/supabase fails to load under the same mocks', () => {
    jest.isolateModules(() => {
      expect(() => jest.requireActual('./activityFeed')).toThrow(/reached lib\/(supabase|storage)/);
    });
  });
});
