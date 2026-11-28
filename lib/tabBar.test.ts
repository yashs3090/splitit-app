import { NO_TAB_BADGES, TAB_BAR_COMPACT_BELOW, tabA11yLabel, tabBarLayout, tabSlots } from './tabBar';

const ROUTES = ['index', 'groups', 'activity', 'profile'];

describe('tabSlots', () => {
  it('is Tabs · Groups · (+) · Activity · Profile, with the spec labels', () => {
    expect(tabSlots(ROUTES, NO_TAB_BADGES)).toEqual([
      { kind: 'tab', route: 'index', label: 'Tabs', a11yLabel: 'Tabs' },
      { kind: 'tab', route: 'groups', label: 'Groups', a11yLabel: 'Groups' },
      { kind: 'add', a11yLabel: 'Add receipt, opens a photo or typing the items' },
      { kind: 'tab', route: 'activity', label: 'Activity', a11yLabel: 'Activity' },
      { kind: 'tab', route: 'profile', label: 'Profile', a11yLabel: 'Profile' },
    ]);
  });

  it("follows the navigator's order and leaves out routes that aren't tabs", () => {
    const slots = tabSlots(['index', '_sitemap', 'groups', 'activity', 'profile', '+not-found'], NO_TAB_BADGES);
    expect(slots.map((s) => (s.kind === 'add' ? '+' : s.route))).toEqual(['index', 'groups', '+', 'activity', 'profile']);
  });

  it('puts (+) in the middle when Groups is missing', () => {
    const slots = tabSlots(['index', 'activity'], NO_TAB_BADGES);
    expect(slots.map((s) => (s.kind === 'add' ? '+' : s.route))).toEqual(['index', '+', 'activity']);
  });
});

describe('tabA11yLabel (the Task 7 badge hook)', () => {
  it('says the badge in the label', () => {
    const badges = { tabs: 4, groups: true, activity: 12 };
    expect(tabA11yLabel('index', badges)).toBe('Tabs, 4 open bills');
    expect(tabA11yLabel('groups', badges)).toBe('Groups, new activity');
    expect(tabA11yLabel('activity', badges)).toBe('Activity, more than 9 new');
    expect(tabA11yLabel('activity', { ...badges, activity: 3 })).toBe('Activity, 3 new');
    expect(tabA11yLabel('profile', badges)).toBe('Profile');
  });

  it('is the plain name with no badge', () => {
    for (const route of ['index', 'groups', 'activity', 'profile'] as const) {
      expect(tabA11yLabel(route, NO_TAB_BADGES)).toBe(tabSlots(ROUTES, NO_TAB_BADGES).find((s) => s.kind === 'tab' && s.route === route)?.a11yLabel);
    }
  });
});

// QA criterion 52 note: at 188 CSS px (a 375 px window at 200% zoom) the labels cut off ("Gr…") and
// the 56-pt (+) overlapped its neighbours. Below the threshold the bar goes compact: no visible
// labels (the screen-reader labels are unchanged), counts drawn as dots, and a 44-pt (+) in a slot of
// its own width, so nothing overlaps at any width >= 160.
describe('tabBarLayout (narrow widths)', () => {
  const ICON = 24; // the tab icon (Icon size lg)
  const DOT_OVERHANG = 2; // the dot sits 2 past the icon's right edge

  it('is the full bar at phone widths and above', () => {
    for (const w of [TAB_BAR_COMPACT_BELOW, 320, 375, 430, 560, 1200]) {
      expect(tabBarLayout(w)).toEqual({ compact: false, addSize: 56 });
    }
  });

  it('goes compact just below the threshold, and at the QA width', () => {
    expect(tabBarLayout(TAB_BAR_COMPACT_BELOW - 1)).toEqual({ compact: true, addSize: 44 });
    expect(tabBarLayout(188)).toEqual({ compact: true, addSize: 44 });
  });

  it('the full bar fits: at the threshold each fifth holds the (+) and a label', () => {
    const slot = TAB_BAR_COMPACT_BELOW / 5;
    expect(slot).toBeGreaterThanOrEqual(tabBarLayout(TAB_BAR_COMPACT_BELOW).addSize);
    // "Activity" at the 13-pt caption is about 45 px wide; a tab pads 4 each side.
    expect(slot - 8).toBeGreaterThanOrEqual(45);
  });

  it.each([160, 170, 188, 200, 240, TAB_BAR_COMPACT_BELOW - 1])('nothing overlaps at %i px', (w) => {
    const { compact, addSize } = tabBarLayout(w);
    expect(compact).toBe(true);
    // The (+) keeps the touch-target size; the four tabs share what's left.
    expect(addSize).toBe(44);
    const tab = (w - addSize) / 4;
    expect(tab).toBeGreaterThanOrEqual(ICON + 2 * DOT_OVERHANG);
  });

  it('treats a missing or bad width as the full bar (the first frame on some platforms)', () => {
    expect(tabBarLayout(0)).toEqual({ compact: false, addSize: 56 });
    expect(tabBarLayout(Number.NaN)).toEqual({ compact: false, addSize: 56 });
  });
});
