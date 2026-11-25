# 0009: Pin Expo SDK 57 because this machine runs Node 20

**Status:** Accepted (2026-11-19). Revisit when Node is upgraded.

## Context
The newest Expo SDK (58) declares that it needs Node `^22.13 || ^24.3`. The development machine has Node 20.19.5. SDK 57 (React Native 0.86) declares `^20.19.4`.

## Decision
Pin `expo ~57.0.33`, set `engines.node >= 20.19.4` in `package.json`, and always add Expo packages with `npx expo install`, which picks versions compatible with the installed SDK.

## Consequences
- We're one SDK behind. Expo supports several recent SDKs, so this is fine for development, but upgrading is easier one SDK at a time than several at once.
- **Upgrade path:** install Node 22 LTS (e.g. via `nvm` or `fnm`), then run `npx expo install expo@^58 --fix` and `npx expo-doctor`, then run the tests.
- `npm audit` reports 6 issues in transitive dependencies of the template. `npm audit fix --force` would break the pins. Re-check after the SDK upgrade rather than forcing fixes.

## Concept: why the Node version matters
The `engines` field in `package.json` says which Node versions a package supports. Tools like Metro (the React Native bundler) use newer JavaScript and Node APIs, so a package can crash on an older Node, or refuse to install. Pinning keeps the whole team (and CI) on a known-good combination.
