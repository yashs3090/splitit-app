// Harness-only stand-in for `expo-modules-core` (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md,
// Task 4). The two expo-image-manipulator web files the harness bundles (`src/web/utils.web.ts` and
// `src/web/actions/ResizeAction.web.ts`) import only `CodedError` from it. The real package pulls in
// React Native's module registry, which a plain browser page can't load. esbuild aliases
// `expo-modules-core` to this file; nothing else may import from it.

/** Same shape as expo-modules-core's `CodedError`: an Error with a string `code`. */
export class CodedError extends Error {
  code: string;
  info?: unknown;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}
