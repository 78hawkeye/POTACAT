# Tap-to-pair + tsHost propagation — desktop ready

Status: desktop shipped, awaiting mobile integration
Filed: 2026-06-04
For: POTACAT iOS (ECHOCAT)
Desktop side: shipped in v1.8.5 (currently in `master`; release
gated on Casey's manual verification — wait for the GitHub release
before mobile commits, the API surface won't change but the binary
isn't published yet)
Original ask: `D:\Projects\potacat-app\docs\desktop-handoffs\tap-to-pair-and-tailscale-host.md`

## What's live on the desktop

The desktop now serves the entire contract from the original handoff,
with the deviations Casey green-lit during review baked in. Mobile can
implement against any v1.8.5+ desktop.

### Part A — Tap-to-pair (`POST /api/pair-request`)

New endpoint on the existing HTTPS listener (port 7300 by default).
Pin against the mDNS-advertised cert fingerprint, same path as
`/api/pair`.

**Request:**

```json
POST https://<host>:7300/api/pair-request
Content-Type: application/json

{
  "deviceName":     "Casey's iPhone",   // ≤ 60 chars
  "devicePlatform": "ios",              // ≤ 20 chars
  "requestId":      "<random 16-byte hex>"
}
```

Phone holds the response open for up to 60 s while the desktop pops an
Approve / Deny modal in front of the operator. **Fetch timeout must be
≥ 65 s** — set it explicitly; the default 30 s on most HTTP clients
will cut the long-poll off before the operator has a chance to click.

**On Approve (200):** the response body is the **final `PairResponse`**
— `deviceToken` is the long-lived per-device token. No follow-up POST
to `/api/pair` is needed; store the record exactly as you would after
the QR-redeem flow.

```json
{
  "deviceToken":      "...",
  "deviceId":         "...",
  "fingerprint":      "<self-signed cert SHA-256, hex with colons>",
  "protocolVersion":  <n>,
  "serverVersion":    "1.8.5",
  "tsHost":           "shack-mac.billfish-noodlefish.ts.net:7300",
  "cloudHost":        "k3sbp.potacat.com"
}
```

`tsHost` / `cloudHost` are empty strings when not configured.

**On Deny / timeout / disabled / busy / tunnel-blocked**, the body is
`{ error, message, reason? }`. Full table:

| HTTP | `error` string | When | Suggested mobile copy |
|------|----------------|------|------------------------|
| 200  | —              | Approve | (`PairResponse`) |
| 400  | `invalid_json` | Body wasn't JSON | "Pairing request failed (malformed)." |
| 403  | `pair_denied` with `reason: 'denied' \| 'timeout'` | Owner clicked Deny, or didn't respond in 60 s | denied → "The desktop owner denied the pair request." timeout → "The desktop didn't respond. Open POTACAT on the desktop, then try again." |
| 403  | `pair_requests_disabled` | Owner turned off "Allow pair requests from the LAN" | "This desktop has tap-to-pair turned off. Scan the pairing QR instead." |
| 403  | `pair_request_tunnel_blocked` | Desktop is exposed over POTACAT Cloud Tunnel — tap-to-pair is locked in that mode (modal-spam DoS prevention) | "Tap-to-pair only works on the LAN. Scan the pairing QR or use POTACAT Cloud." |
| 503  | `pair_request_busy` | Another pair request is mid-approval | "Another device is already asking to pair. Try again in a minute." |

`requestId` round-trips for the phone's correlation — useful for
back-press / cancel handling (the desktop also drops the pending
request when it sees `req.on('close')`, so a quick cancel-and-retry
won't get bounced with `pair_request_busy`).

### Part B — `tsHost` / `cloudHost` propagation

Desktop pushes its Tailscale MagicDNS host (when present) and cloud
host (when subscription is active + tunnel is up) over every channel
mobile cares about, so phones get a fallback dial-chain automatically.

**Where the values arrive — all TOP-LEVEL, never inside `settings`:**

1. **`auth-ok`** — every connect / reconnect:
   ```json
   {
     "type": "auth-ok",
     "settings": { /* … unchanged … */ },
     "tsHost":  "shack-mac.<tailnet>.ts.net:7300",
     "cloudHost": "k3sbp.potacat.com",
     /* … other auth-ok fields … */
   }
   ```

2. **Typed push** mid-session when either value changes (e.g. user
   enables Cloud Tunnel after phone is already connected):
   ```json
   { "type": "alt-hosts", "tsHost": "...", "cloudHost": "..." }
   ```
   Either field empty = "not configured" — don't fall back to an empty
   host. Idempotent: the desktop only emits when at least one value
   actually changed, so it's safe to overwrite the stored
   `PairedDevice` record on every receive.

3. **QR payload** (`potacat://pair?…`) — first-time LAN pair gets
   both values baked into the URI:
   ```
   potacat://pair?token=...&host=wss://...&fp=...&cloudHost=...&tsHost=...
   ```

4. **`/api/pair` response** — QR-redeem flow.

5. **`/api/pair-request` response** — tap-to-pair flow (table above).

**Cert pin reuse**: the existing `device.fingerprint` covers all three
hostnames (`host`, `tsHost`, `cloudHost`) — same self-signed cert
terminates at the same process regardless of which front door the
request came in on. No new cert work on the phone, no new pinning
configuration; the pinned-WS native module already supports pinning
any hostname against a known fingerprint.

### Bonjour discovery fix (related — also v1.8.5)

The desktop now publishes its mDNS `_potacat._tcp` service on **every
real LAN interface**, not just the one Windows happened to pick by
routing metric. Previously, on boxes with Hyper-V / WSL / Docker /
Tailscale / multiple Ethernet ports installed, the multicast packets
were landing on a virtual adapter and the iOS "FOUND ON YOUR NETWORK"
card stayed empty.

Mobile side: no change. `useDiscoveredDesktops` already browses
`_potacat._tcp.local.` correctly. Just expect the card to start
appearing on Casey's machine + on user boxes that previously showed
nothing despite the desktop being on the same WiFi.

## Suggested mobile work order

Ship in this order so already-paired phones get `tsHost` retroactively
before any tap-to-pair UX changes land:

1. **`PairedDevice` schema** — add `tsHost?: string` and `cloudHost?:
   string` optional fields (mirror existing `host` / `cloudHost`
   types).
2. **`applyAuthOk`** — read `tsHost` + `cloudHost` from the message
   root and overwrite the active `PairedDevice` record. Idempotent.
3. **Typed `alt-hosts` handler** — same overwrite path. Just a new
   case in the connection-manager's message switch.
4. **`ConnectionManager.connectToDevice` fallback chain** — extend
   the existing host → cloudUrl chain to `host → tsHost → cloudHost`.
   Each leg fails fast on DNS NXDOMAIN / connection refused. Reuse
   the same pinned-WS cert validation against `device.fingerprint`
   for all three.
5. **`parsePairingUri`** — read `tsHost` from the QR (if present).
6. **`exchangePairingToken`** — read `tsHost` + `cloudHost` from the
   `/api/pair` response.

That's enough to land Part B end-to-end. Then for Part A:

7. **`exchangePairToken` parallel**: new `requestPairFromDesktop`
   service call that POSTs to `/api/pair-request` with a 65 s+
   timeout. Maps the typed errors above to user-facing copy. Stores
   the result as a regular `PairedDevice`.
8. **`PairingScreen` discovered card `onPress`** — switch from
   "open QR scanner" to:
   - Show "Ask for approval on `<desktopName>`..." spinner
   - Call `requestPairFromDesktop`
   - On 200 → store + connect + dismiss
   - On 403 `pair_denied` → inline deny copy
   - On 403 `pair_requests_disabled` / `pair_request_tunnel_blocked`
     → fall back to the QR scanner with a one-time toast explaining
     why
   - On 503 `pair_request_busy` → retry-after-a-minute copy
   - On timeout / abort → cancel cleanly (desktop drops the pending
     request when the HTTP socket closes; no leftover state)
9. **Settings → "Pair another desktop"** — same treatment as the
   welcome card; the call site is already unified post the
   2026-06-03 redesign.

## Open questions (none blocking)

- **Multi-device approve UI on desktop**: filed as "v2" in the
  original handoff; not shipped. Each pair request currently shows a
  one-shot popout with no remembered allow-list.
- **Interface hot-plug for tsHost**: the desktop polls Tailscale
  every 10 minutes; up to a 10-minute lag if a user enables Tailscale
  after launching POTACAT. Acceptable for v1; could become
  event-driven later.
- **Cert SAN coverage**: the desktop's self-signed cert already
  includes every IP returned by `getLocalIPs()` (which uses the same
  virtual-adapter filter as the new Bonjour publish), so a phone
  connecting via any of the published interfaces will validate.
  Flagged here in case mobile sees a `SecureConnectionFailed` on a
  specific interface — would mean SAN drift, file back.

## Reference

- Desktop pair-request endpoint:
  `D:\Projects\potacat-dev\lib\remote-server.js` (search for
  `'/api/pair-request'`).
- Desktop approve/deny path: same file, `approvePairRequest` /
  `denyPairRequest` / `_resolvePairRequest`.
- `tsHost` / `cloudHost` source-of-truth:
  `main.js` `_refreshAltHosts()`.
- `alt-hosts` push emit:
  `lib/remote-server.js` `setAltHosts()`.
- QR payload generator:
  `main.js`, the `echocat-create-pairing-qr` IPC handler.
- Bonjour multi-interface publish:
  `lib/remote-server.js` `_startMdns()`.
- Original ask:
  `D:\Projects\potacat-app\docs\desktop-handoffs\tap-to-pair-and-tailscale-host.md`
  (updated 2026-06-04 with the mobile contract section that mirrors
  the table above).
