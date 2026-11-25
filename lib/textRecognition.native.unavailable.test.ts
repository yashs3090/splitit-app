// The native implementation in a build without the expo-mlkit-ocr native code (e.g. Expo Go),
// where importing the library throws. Separate file so the throwing mock applies from the start.
import { textRecognizer } from './textRecognition.native';

jest.mock('expo-mlkit-ocr', () => {
  throw new Error("Cannot find native module 'ExpoMlkitOcr'");
});

describe('textRecognizer (native) when the native module is missing', () => {
  it('importing the recognizer does not throw, and it is unavailable', () => {
    expect(textRecognizer.isAvailable()).toBe(false);
  });

  it('recognize rejects with unavailable', async () => {
    await expect(textRecognizer.recognize('file:///x.jpg')).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'unavailable',
    });
  });
});
