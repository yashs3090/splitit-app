import { ariaProps } from './ariaProps';

describe('ariaProps (QA F1: react-native-web 0.21 drops accessibilityState)', () => {
  it('maps each state to its aria prop, with the same value', () => {
    expect(ariaProps({ busy: true, checked: false, disabled: true, expanded: false, selected: true })).toEqual({
      'aria-busy': true,
      'aria-checked': false,
      'aria-disabled': true,
      'aria-expanded': false,
      'aria-selected': true,
    });
  });

  it('keeps "mixed" for checked', () => {
    expect(ariaProps({ checked: 'mixed' })).toEqual({ 'aria-checked': 'mixed' });
  });

  it('only the states that are set: no key for an absent or undefined state', () => {
    const got = ariaProps({ expanded: true, busy: undefined });
    expect(got).toEqual({ 'aria-expanded': true });
    expect(Object.keys(got)).toEqual(['aria-expanded']);
  });

  it('nothing for no state', () => {
    expect(ariaProps(undefined)).toEqual({});
    expect(ariaProps({})).toEqual({});
  });
});
