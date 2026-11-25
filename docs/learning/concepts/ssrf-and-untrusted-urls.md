# Fetching untrusted URLs (SSRF)

> **Status: deferred (2026-11-20).** Receipt-link import is not planned right now. It needs server code to fetch third-party pages, and SplitIt has no custom backend ([ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md)). Keep this note for when that changes; the defenses below would apply to any server that fetches a URL a user gave it.

## The idea
When the host pastes a receipt link, *our server* fetches it. **Server-Side Request Forgery (SSRF)** happens when an attacker makes your server request something they couldn't reach themselves:
- internal services (`http://localhost:5432`, `http://10.0.0.5/admin`)
- cloud metadata endpoints that hand out credentials (`http://169.254.169.254/…`)
- huge or never-ending responses that tie up the function (a denial of service)

## Defenses we would use (not built)
1. **Scheme allow-list:** `https:` only.
2. **Resolve, then check the IP:** reject private, loopback, link-local and multicast ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, …). Check *after* DNS resolution, because `evil.com` can resolve to `127.0.0.1`.
3. **Redirects:** follow them manually (at most 3), re-checking every hop. A safe URL can redirect to an internal one.
4. **Limits:** 5s timeout, 2MB maximum body, allowed content types only (HTML, PDF, images).
5. **Don't send the response back raw.** It only goes to the parser, never echoed to the client.
6. **Prompt-injection hygiene:** page text is data. The model's only output is our receipt schema.

## Pitfalls
- Checking the hostname string instead of the resolved IP.
- DNS rebinding: the name resolves to a safe IP when you check and an internal one when you fetch. Mitigate by connecting to the IP you checked, where the runtime allows it.
- Logging full URLs that contain personal tokens (receipt links often include one).

## Check yourself
1. Why isn't `if (url.hostname !== 'localhost')` enough?
2. Why re-check on every redirect?

## Learn more
- https://owasp.org/www-community/attacks/Server_Side_Request_Forgery
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
