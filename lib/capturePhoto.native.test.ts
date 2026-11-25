// Native capture: the Task 7 permission flow plus the system camera (A3 / Task 9 moved it here).
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from 'expo-image-picker';

import { CAPTURE_LABEL, capturePhoto, MANUAL_ENTRY_LABEL } from './capturePhoto.native';

const request = requestCameraPermissionsAsync as jest.Mock;
const camera = launchCameraAsync as jest.Mock;

function grant(granted: boolean, canAskAgain = true) {
  request.mockResolvedValue({ granted, canAskAgain, status: granted ? 'granted' : 'denied', expires: 'never' });
}

beforeEach(() => jest.clearAllMocks());

describe('capturePhoto (native)', () => {
  it('granted: opens the camera (images, no EXIF) and returns the photo', async () => {
    grant(true);
    camera.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/p.jpg', width: 1, height: 1 }] });
    await expect(capturePhoto()).resolves.toEqual({ kind: 'photo', uri: 'file:///cache/p.jpg' });
    expect(camera).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 1, exif: false });
    expect(launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('denied but can ask again: { permission: ask }, camera not launched', async () => {
    grant(false, true);
    await expect(capturePhoto()).resolves.toEqual({ kind: 'permission', state: 'ask' });
    expect(camera).not.toHaveBeenCalled();
  });

  it('denied for good: { permission: blocked }, camera not launched', async () => {
    grant(false, false);
    await expect(capturePhoto()).resolves.toEqual({ kind: 'permission', state: 'blocked' });
    expect(camera).not.toHaveBeenCalled();
  });

  it('camera cancelled: { kind: cancelled }', async () => {
    grant(true);
    camera.mockResolvedValue({ canceled: true, assets: null });
    await expect(capturePhoto()).resolves.toEqual({ kind: 'cancelled' });
  });

  it('a permission API failure rejects (the screen shows fixed copy)', async () => {
    request.mockRejectedValue(new Error('E_MISSING_PERMISSION'));
    await expect(capturePhoto()).rejects.toThrow();
    expect(camera).not.toHaveBeenCalled();
  });

  it('labels the buttons for native', () => {
    expect(CAPTURE_LABEL).toBe('Take photo');
    expect(MANUAL_ENTRY_LABEL).toBe('Enter items');
  });
});
