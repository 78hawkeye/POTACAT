# Double-CGNAT desktop↔desktop audio — verification runbook

**What this proves:** rig audio flowing from a shack POTACAT to a remote laptop
POTACAT when **both** machines are behind carrier-grade NAT (e.g. both on
T-Mobile 5G), with **no Tailscale** — i.e. the audio relays through the
Cloudflare TURN edge. Control (tune, spots, freq) already works over Cloud; this
is specifically the **audio leg** (remote-desktop Phase 2).

This is the one thing the automated tests can't cover — they mock WebRTC/TURN.
Everything below is a real two-machine check. The code now logs enough that the
`[CAT]` log on each machine tells you exactly what happened.

---

## 0. Prerequisites (the relay only arms when ALL are true)

TURN minting is gated by `_turnCloudActive()` — it is a deliberate **no-op on
LAN/Tailscale** (no CGNAT there, no need to pay for relay). For the double-CGNAT
case you need, on the **shack**:

1. Signed into POTACAT Cloud (`settings.cloudAccessToken` present).
2. Cloud Tunnel **enabled** (the shack is reachable at `wss://<call>.potacat.com`).
3. `settings.remoteTurn` not set to false (default on).

On the **laptop**: signed into the same Cloud account and paired to the shack
(Remote Radios → the shack shows paired). The laptop reaches the shack via the
**cloud** leg (you'll see `[RemoteClient] dialing cloud wss://<call>.potacat.com`).

> Model A: the **shack mints** the TURN creds once per audio session and hands
> the same creds to whatever client connects (phone or laptop) via `stun-config`.
> The laptop does not mint. CF TURN creds authorize *use of the relay*, not a
> specific peer, so this is correct and also keeps Guest-Pass phones working.

## 1. Happy path

1. Shack: POTACAT running, rig connected, Cloud Tunnel on, audio source set
   (DAX / SmartSDR-Direct / USB) — the same setup that already streams to your
   phone.
2. Laptop: open POTACAT → More → Remote Radios → activate the shack. Status chip
   goes connected. **Audio auto-starts** on connect (no button to press; the
   red PTT button appears once connected for TX).
3. Click a spot on the laptop → rig retunes (you already confirmed this) **and
   you should now hear rig audio** within a few seconds.

## 2. What the logs must show (this is the proof)

### On the SHACK (`[CAT]` log)
```
[TURN] relay creds minted — N ICE servers, ~60 min left ...     ← creds fetched
[Echo CAT Audio] ICE connected via relay/relay — RELAY (CGNAT path working)
```
- `relay creds minted` with N≥1 → the shack got Cloudflare TURN servers.
- `RELAY (CGNAT path working)` → the offerer's selected ICE pair is a relay
  candidate. This is success.

### On the LAPTOP (`[CAT]` log)
```
[remote-client-audio] answerer started
[remote-client-audio] adopted N ICE servers (M relay/TURN)
[remote-client-audio] ICE connected via relay/relay — RELAY (double-CGNAT path working)
```
- `adopted N ICE servers (M relay)` with **M≥1** → the laptop received and
  adopted the shack's TURN creds. **If M == 0 you'll see
  `— STUN-only, double-CGNAT will NOT connect`** — fix that first (section 3).
- `ICE connected via relay/relay — RELAY` → audio is flowing over the relay.

If both ends print the `RELAY ... working` line, double-CGNAT audio is verified.

## 3. Failure triage

| Symptom in the log | Cause | Fix |
|---|---|---|
| Shack: no `[TURN] relay creds minted` line at all | `_turnCloudActive()` false — not signed into Cloud, or Cloud Tunnel off, or `remoteTurn=false` | Sign in on the shack, enable Cloud Tunnel, confirm you're connecting via the cloud leg (not LAN/Tailscale) |
| Shack: `[TURN] mint returned no iceServers` / `relay unavailable ... STUN-only` | Cloud endpoint returned nothing — `turn_not_configured` (server env missing CF keys) or network/timeout (4s) | Server-side: confirm `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` set in potacat-cloudlog prod. Retry (transient) |
| Shack: `daily relay limit reached — STUN-only` | Per-account 1000 MB/day TURN budget (`429 turn_daily_limit`) exhausted | Wait for UTC-day reset, or raise `TURN_DAILY_BUDGET_MB` |
| Laptop: `adopted N ICE servers (0 relay) — STUN-only` | Shack minted but the laptop got a stun-config without iceServers (stale/expired, or arrived before mint) | Disconnect/reconnect the laptop; the shack re-sends stun-config with creds on the next start-audio. Check the shack actually minted |
| Either end: `ICE FAILED — no working path` | Relay creds present but no relay pair formed — CF TURN UDP+TCP blocked by the carrier, or creds expired mid-gather | Confirm both `turn:` (UDP/3478) and `turns:` (TCP/5349) reachable from each network; re-mint TTL is 1h with a 5-min-early refresh |
| Laptop: control works, freq+beep, but **no** `answerer started` line | Audio leg never triggered | Confirm the laptop is on a build that includes remote-desktop Phase 2 (this branch); auto-start fires on `remote-client-status: connected` |
| Audio starts then goes silent after ~1h | TURN TTL expired and the re-mint didn't take | The shack re-mints 5 min before expiry while audio is live; if it failed, toggle audio off/on on the laptop to force a fresh mint |

## 4. Forcing relay to prove it independently (optional)

To prove the relay works even when a direct path *exists* (e.g. you want to test
relay on a LAN bench before going to two cellular machines), the answerer honors
`relayOnly` from `stun-config` → it sets `iceTransportPolicy: 'relay'`, so ICE
will ONLY use relay candidates. There's no production UI for this (it's a test
hook); set it via a temporary `stun-config` `relayOnly: true` or the
`renderer/remote-audio-answerer.js` default while bench-testing. Expect
`ICE connected via relay/relay` and nothing else. Remember TURN is Cloud-gated,
so even the bench test needs Cloud sign-in + tunnel.

## 5. Notes / honest boundaries

- The phone already does this in prod (confirmed by a user: audio over Cloud, no
  Tailscale, dual CGNAT). The laptop answerer reuses the **same shack offerer
  path** and the **same TURN creds** — so the shack side is proven; this runbook
  is really validating the new laptop **answerer** + signaling relay.
- The peer connection on the laptop is now built **after** the TURN creds arrive
  (born relay-capable), not retrofitted — see `setIceConfig()` in
  `renderer/remote-audio-answerer.js`. This removes the main double-CGNAT
  fragility found in review.
- Automated coverage: `test/remote-audio-answerer-test.js` (incl. the
  born-with-TURN and selected-pair assertions), `test/remote-ptt-test.js`,
  `test/remote-desktop-e2e-test.js`, `test/echocat-protocol-test.js` — all in
  `npm test`. None of these exercise a real relay; this runbook is the real one.
