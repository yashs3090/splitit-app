# 0001: One Expo/React Native codebase for iOS, Android and web

**Status:** Accepted (2026-11-19)

## Context
The person paying needs a good camera experience (mobile). Friends receive a link and should be able to open it anywhere, including a laptop browser. We're a very small team.

## Options
| Option | Pros | Cons |
|---|---|---|
| Web app / PWA only | No install, fastest to ship | Weaker camera and push notifications on iOS; no app store presence |
| Native Swift + Kotlin | Best platform feel | Two codebases plus a web app: three times the work |
| **Expo (React Native) + Expo Router** | One TypeScript codebase targets iOS, Android **and** web; file-based routing; OTA updates; EAS builds in the cloud | Some native modules don't work on web; slightly larger app |

## Decision
Expo with Expo Router, TypeScript.

## Consequences
- Platform differences (camera on web vs native, deep links) need `Platform.OS` checks or `.web.tsx` / `.native.tsx` file variants.
- Expo Router's file-based routes double as deep-link URLs: `app/b/[code].tsx` ↔ `splitit.app/b/abc123`. See [auth-and-deep-links](../concepts/auth-and-deep-links.md).
- Building for the App Store needs an Apple Developer account ($99/yr).

## Learn more
- https://docs.expo.dev/router/introduction/
