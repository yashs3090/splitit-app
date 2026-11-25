// Web capture, imported by path (criterion 56, A3 / Task 9).
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from 'expo-image-picker';

import { CAPTURE_LABEL, capturePhoto, MANUAL_ENTRY_LABEL } from './capturePhoto.web';

const library = launchImageLibraryAsync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('capturePhoto (web)', () => {
  it('opens the image picker with images only and no permission step', async () => {
    library.mockResolvedValue({ canceled: false, assets: [{ uri: 'blob:http://localhost/abc', width: 10, height: 10 }] });
    await expect(capturePhoto()).resolves.toEqual({ kind: 'photo', uri: 'blob:http://localhost/abc' });
    expect(library).toHaveBeenCalledTimes(1);
    expect(library.mock.calls[0]?.[0]).toMatchObject({ mediaTypes: ['images'] });
    expect(requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(launchCameraAsync).not.toHaveBeenCalled();
  });

  it('cancel gives { kind: "cancelled" }', async () => {
    library.mockResolvedValue({ canceled: true, assets: null });
    await expect(capturePhoto()).resolves.toEqual({ kind: 'cancelled' });
    library.mockResolvedValue({ canceled: false, assets: [] });
    await expect(capturePhoto()).resolves.toEqual({ kind: 'cancelled' });
  });

  it('labels the buttons for web', () => {
    expect(CAPTURE_LABEL).toBe('Take or upload photo');
    expect(MANUAL_ENTRY_LABEL).toBe('Enter items');
  });
});
