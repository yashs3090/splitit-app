// The platform's TextRecognizer, in one module the scan screen imports, so router tests can
// `jest.mock('@/lib/recognizer')` with `test-utils/fakeRecognizer.ts`.
// `./textRecognition` resolves to the `.native` or `.web` file (the web one never loads expo-mlkit-ocr).
export { textRecognizer as recognizer } from './textRecognition';
