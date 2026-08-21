# Security Policy

## Security stance

This plugin takes the same position as the shipped HTTP fetch provider: it implements **no SSRF / private-network protection**. Anything the browser can reach, the provider can fetch — a rendered page, an internal service, or a link-local address. The CDP endpoint and the local browser path are configured from the settings page with no loopback restriction. Deploy it in a trusted environment and do not expose the settings page to untrusted networks.

Fetched pages are rendered locally; besides the target page itself, no data leaves the machine. No credentials are accepted or stored by this plugin.

## Reporting a vulnerability

If you believe you have found a security issue in this plugin, please open a private advisory on GitHub:

https://github.com/chendefine/dsh-web-fetch-playwright/security/advisories/new

Please include:

- the affected version;
- a minimal reproduction (URL, configuration, expected vs actual behavior);
- whether you consider it a security boundary violation or a misconfiguration footgun.

Repair policy: confirmed issues get a fix, a version bump, a `CHANGELOG.md` entry, and a GitHub Security Advisory; fixes are published to npm and tagged.

## Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Internal network | Page fetch reaches private/link-local hosts | None by design (provider stance); restrict who may call `web_fetch`, run in a network-scoped environment |
| Settings page | CDP endpoint reconfiguration to an attacker-controlled browser | Trusted-environment deployment only; loopback checks deliberately not enforced |
| Fetched page | Malicious JS runs in the headless browser | Browser is headless, session/context are fresh per fetch, resource subrequests (image/font/media) are aborted, page output passes Readability + DOMPurify before conversion |
| Workspace data | Rendered page content stored in sessions | Same as any `web_fetch` output — treat fetched content as untrusted data |

## Supported versions

The latest published npm release is the only supported version. Users on older releases should upgrade to the newest `dsh-web-fetch-playwright` on npm.
