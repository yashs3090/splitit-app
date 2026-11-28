import { backToTabs } from './tabsNav';

function fakeRouter(canDismiss: boolean) {
  return { canDismiss: jest.fn(() => canDismiss), dismissAll: jest.fn(), replace: jest.fn() };
}

describe('backToTabs', () => {
  it('pops to the tabs when they are below (keeps the tab that was in front)', () => {
    const r = fakeRouter(true);
    backToTabs(r);
    expect(r.dismissAll).toHaveBeenCalledTimes(1);
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('opens the tabs when nothing is below', () => {
    const r = fakeRouter(false);
    backToTabs(r);
    expect(r.replace).toHaveBeenCalledWith('/');
    expect(r.dismissAll).not.toHaveBeenCalled();
  });
});
