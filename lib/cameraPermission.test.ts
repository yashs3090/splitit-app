import { permissionState } from './cameraPermission';

describe('permissionState (criterion 21)', () => {
  it('granted wins whatever canAskAgain says', () => {
    expect(permissionState({ granted: true, canAskAgain: true })).toBe('granted');
    expect(permissionState({ granted: true, canAskAgain: false })).toBe('granted');
  });

  it('denied but can ask again is "ask"', () => {
    expect(permissionState({ granted: false, canAskAgain: true })).toBe('ask');
  });

  it('denied and cannot ask again is "blocked"', () => {
    expect(permissionState({ granted: false, canAskAgain: false })).toBe('blocked');
  });
});
