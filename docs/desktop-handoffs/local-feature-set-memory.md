# Local Feature Set Memory — multi-op, RS-BA1 audio, JTCAT/SSTV polish

Status: shipped locally through `v1.8.5.5`
Created: 2026-06-05
Repo: `/Users/csparrow/Documents/POTACAT`
Purpose: durable patch memory for re-applying the local feature set to future upstream POTACAT releases without repeating the RS-BA1 / JTCAT trial-and-error loop.

## Executive Summary

This local build series turned POTACAT `v1.8.3` into a much more capable personal build:

- Multi-operator profiles are actually segregated on disk rather than UI-only.
- Operators can be switched from the top nav or Settings Summary, with restart.
- Icom Network / RS-BA1 now supports CAT, RX audio, and TX audio over UDP.
- JTCAT can receive and transmit FT8/FT4 over RS-BA1 IP audio and has completed real QSOs.
- SSTV received images are saved and displayed, and SSTV can use RS-BA1 audio paths.
- JTCAT popout UX was improved: CQ-only filter, macOS titlebar spacing, IP audio source handling.
- Local build numbers append `.N` to the base version and deploy cleanly to `/Applications` on macOS.

The most important learned lesson: the final working RS-BA1 TX path is **not** a protocol rewrite. It is a precise combination of wfview-like packetization, 48 kHz LPCM16 mono, 150 ms TX latency, 20 ms audio frames, 1364-byte UDP chunks, 16-bit sequence wrapping, bounded retransmit handling, idle keepalive pause during TX, and calibrated network TX gain.

## Golden Working Defaults

These values produced real-world FT8 contacts on an IC-7610 over RS-BA1/LAN:

| Setting | Value | Notes |
|---|---:|---|
| RS-BA1 TX sample rate | `48000` | Do not revert to 16 kHz just because SDR Control prefs showed 16 kHz. POTACAT's 16 kHz attempt produced blank TX. |
| RS-BA1 TX buffer | `150 ms` | wfview default latency. Earlier 750 ms experiments added delay and did not fix TX. |
| Audio frame period | `20 ms` | Matches wfview `AUDIO_SEND_PERIOD`. |
| UDP audio chunk size | `1364 bytes` | wfview splits outbound audio at this size. |
| TX gain default | `72%` / `0.72` | Now user-facing as `Network TX gain` in the RS-BA1 rig pane. |
| Tune peak | `0.45` at 72% equivalent | Scaled by Network TX gain. |
| TX retransmit de-dupe | `35 ms` | Suppresses duplicate resend bursts without ignoring real retransmit requests. |
| TX sequence range | `0..65535`, wrap to `0` | Missing this caused `RangeError ERR_OUT_OF_RANGE` after a long successful JTCAT session. |
| DATA1 MOD | LAN | Code can verify/prepare and restore where supported, but do not blame every issue on DATA mode. User confirmed radio was already in DATA mode during final TX debugging. |

## Feature Inventory

### 1. Multi-Operator/Profile Segregation

Problem: Settings UI claimed each operator had separate callsign, grid, watchlist, logbook, macros, and Cloud account, but the code still used a single shared settings/logbook/credential set.

Implemented behavior:

- `activeProfile` is a global pointer.
- Machine-scoped settings are kept in the global settings file via `GLOBAL_KEYS`.
- Operator-scoped settings are written under `profiles/<CALLSIGN>/settings.json`.
- New profiles get a separate default logbook path under their profile directory.
- Switching profiles persists current state, updates `activeProfile`, then restarts POTACAT so cached settings/controllers reload correctly.
- Archiving moves profile folders under `profiles/_archived/` and refuses to archive the active profile.

Key files:

- `main.js`
  - `PROFILES_DIR`, `profileDir()`, `profileSettingsPath()`
  - `GLOBAL_KEYS`
  - `loadSettings()` merge logic
  - `saveSettings()` split logic
  - `addProfile()`, `switchProfile()`, `archiveProfile()`, `listProfiles()`
  - IPC handlers: `profiles-list`, `profiles-add`, `profiles-switch`, `profiles-archive`
- `renderer/index.html`
  - Summary Operator card
  - top nav operator switcher
  - Manage Operators dialog
- `renderer/app.js`
  - rendering/profile-switch wiring for Summary and top nav
- `preload.js`
  - profile IPC exposure

Re-apply note: preserve the `GLOBAL_KEYS` whitelist carefully. If a future upstream adds a setting that should be machine-global, add it there. Everything not whitelisted becomes operator-scoped by design.

### 2. Top Nav Operator Switcher

Problem: switching operators required opening Settings.

Implemented behavior:

- Top nav has an operator dropdown.
- Changing the operator uses the same `profiles-switch` flow as Settings Summary.
- Switching restarts POTACAT to avoid stale settings/logbook/cloud state.

Key files:

- `renderer/index.html` — `top-op-select`
- `renderer/app.js` — populate and wire top operator switcher
- `main.js` / `preload.js` — same profile IPC as above

### 3. Icom Network / RS-BA1 CAT + RX + TX Audio

This is the largest and most fragile local enhancement.

#### 3.1 Protocol Overview

Implemented a real RS-BA1 UDP transport with separate streams:

- Control stream: authentication, token, capabilities, stream negotiation.
- CI-V stream: CAT frames over UDP.
- Audio stream: RX LPCM16 frames and TX LPCM16 frames.

Key file:

- `lib/rsba1-transport.js`

Important classes/functions:

- `RsBa1Transport`
- `ControlStream`
- `CivStream`
- `AudioStream`
- `buildConnInfo()`
- `parseCapabilities()`
- `buildAudioData()`
- `resampleMonoFloat32()` / `resampleMonoFloat32Sinc()`
- `sendTxAudio()`

Protocol details to preserve:

- Handshake: `AreYouThere -> IAmHere -> AreYouReady -> IAmReady`.
- Login and token confirm must handle both direct and tracked auth modes.
- Auth retry must resend the exact same packet, not rebuild a subtly different one.
- Capabilities parsing selects radio/CIV address and RX/TX sample masks.
- `ConnInfo` must request the local CI-V/audio ports before radio returns assigned stream ports.
- Status response supplies assigned CI-V/audio UDP ports.
- CI-V fallback can retry `controlPort + 1` if advertised CI-V port does not answer.
- Local routed IPv4 is used for wfview-style stream IDs; prefer LAN route over tunnel/Tailscale route.

#### 3.2 Audio Packet Header

Outbound audio packets mirror wfview:

| Offset | Field | Endian |
|---:|---|---|
| `0x00` | total packet length | little |
| `0x04` | type `0` | little |
| `0x06` | tracked packet sequence | little, 16-bit |
| `0x08` | sent id | little |
| `0x0c` | received id | little |
| `0x10` | ident | little |
| `0x12` | audio send sequence | big, 16-bit |
| `0x16` | payload byte length | big |
| `0x18` | LPCM16 payload | little-endian samples |

Ident rule:

- payload length `0xa0` -> `0x9781`
- otherwise -> `0x0080`

The 16-bit send sequence must wrap. The long-session crash showed what happens when it reaches `65536` without wrapping.

#### 3.3 RX Audio

Working behavior:

- Negotiate RS-BA1 RX audio at 48 kHz LPCM16 mono.
- Decode payload to `Float32Array`.
- Feed JTCAT/SSTV through synthetic IP audio source path.
- Track packet gaps, duplicates, late recoveries, and peaks.
- Request missing RX packets where useful.
- Keep RX low-latency; large/deep buffers hurt FT8 band changes and decode timing.
- Log diagnostics to `~/Library/Application Support/POTACAT/rsba1-rx-diagnostics.log`.

Key files:

- `lib/rsba1-transport.js`
- `main.js`
- `renderer/jtcat-vita49-source-worklet.js`
- `renderer/jtcat-popout.js`
- `renderer/app.js`

Useful diagnostics:

- `RX-SUMMARY`
- `RX-GAP`
- `RX-SEQ`
- `RX-LOSSFILL`
- `RX-SKIP-LATE`
- `RX-PACER`
- `RX-STALL`
- `RX-RECOVERY`
- `EVENTLOOP-LAG`

#### 3.4 TX Audio

Final working behavior:

- JTCAT generates 12 kHz FT8/FT4 audio.
- Main process conditions it with the JTCAT `TX Pwr` slider and RS-BA1 `Network TX gain`.
- Audio is upsampled to 48 kHz using windowed-sinc resampling.
- Audio is encoded as LPCM16 mono.
- Audio is sent in 20 ms frames, each frame split into 1364-byte UDP chunks.
- Idle keepalive is paused during active TX audio so it does not interleave with audio packets.
- Radio retransmit requests are honored, but duplicate bursts within 35 ms are de-duped.
- TX audio sequence wraps at 16 bits.
- PTT is hard-released on TX completion/failure/failsafe.

Key files:

- `main.js`
  - JTCAT TX direct path
  - `conditionDirectTxAudio()`
  - `getIcomNetworkTxGain()`
  - `getIcomNetworkTunePeak()`
  - `armJtcatIcomHardRelease()` / failsafe paths
  - Tune direct path
- `lib/rsba1-transport.js`
  - `sendTxAudio()`
  - `_sendTxAudioFrame()`
  - `_pumpTxAudio()`
  - `_resumeIdleAfterTx()`
  - retransmit de-dupe
  - sequence wrap

Working log signs:

```text
[rsba1/control] stream request accepted; TX audio enabled
[Icom-Network-Audio] audio stream ready (RX/TX)
[Icom-Network-Audio] DATA1 MOD is already LAN (0x05) for network TX audio.
[rsba1/audio] TX audio start: ... @12000 Hz -> ... @48000 Hz ... buffer=150ms ... txPeak=...
[rsba1/audio] pausing idle keepalive during TX audio
[rsba1/audio] TX audio queued ... frame(s), ... packet(s) ... maxPumpGap=...
[rsba1/audio] resumed idle keepalive after TX audio
```

Bad signs and learned fixes:

- Blank TX with non-zero payload: likely radio not applying TX stream or gain too low; final path fixed with idle pause + gain calibration.
- Splatter/cutouts: packet churn/interleaving/timing; do not keep changing sample rates blindly.
- `RangeError ERR_OUT_OF_RANGE Received 65536`: sequence counter did not wrap.
- `Port should be > 0 ... Received 0`: do not send audio before learning assigned audio endpoint.
- Huge RX delay after jitter changes: too much buffering breaks real-time FT8.

### 4. RS-BA1 Network TX Gain Control

Problem: hidden hardcoded gain required rebuilding to tune output; radio LAN MOD gain also affected drive.

Implemented behavior:

- `Network TX gain` slider in the Icom Network / RS-BA1 rig settings pane.
- Range: `0-150%`.
- Default: `72%`, matching the successful-contact hidden gain.
- Stored per rig as `catTarget.networkTxGain`.
- JTCAT FT8/FT4, Tune, and SSTV direct RS-BA1 TX use the value.

Key files:

- `renderer/index.html` — `set-icom-network-tx-gain`
- `renderer/app.js` — load/save/label clamp helpers
- `main.js` — `DEFAULT_ICOM_NETWORK_TX_GAIN`, `getIcomNetworkTxGain()`

Tuning model:

- JTCAT `TX Pwr` = runtime/operator control.
- RS-BA1 `Network TX gain` = per-rig IP-audio calibration.
- Radio `LAN MOD gain` = radio-side input trim.

### 5. Icom DATA MOD LAN Preparation/Restore

Problem: IP audio transmit can key the radio but produce no RF if the radio's DATA MOD input is not LAN.

Implemented behavior:

- On Icom Network TX session, code can verify/prepare DATA1 MOD for LAN and remember previous value.
- Restore previous value when the Icom Network session ends when possible.
- Log preparation/restore diagnostics.

Key file:

- `main.js`

Important caution:

The user later confirmed the radio was in DATA mode during debugging. Do not over-focus on DATA mode as the cause of every RS-BA1 TX issue. It is one prerequisite, not the whole fix.

### 6. JTCAT Over IP Audio

Implemented behavior:

- JTCAT can use `Icom Network audio (RS-BA1)` as audio source.
- RX waterfall/decoder receives RS-BA1 audio frames without a local USB audio device.
- TX bypasses WebAudio output devices and sends direct RS-BA1 audio when `settings.audioSource === 'icom-network'` and transport is `txReady`.
- If Icom Network audio is selected but TX stream is not ready, do not silently fall back to local audio; force PTT off and log the failure.

Key files:

- `main.js`
- `renderer/index.html`
- `renderer/app.js`
- `renderer/jtcat-popout.js`
- `renderer/jtcat-vita49-source-worklet.js`
- `preload-jtcat-popout.js`

### 7. JTCAT UI Enhancements

Implemented behavior:

- Canned filter button changed from `CQ/73` to `CQ`.
- Filter now shows CQ calls and messages directed to the operator, but not general `73` / `RR73` chatter.
- macOS JTCAT popout titlebar gets proper native traffic-light spacing.

Key files:

- `renderer/jtcat-popout.html`
- `renderer/jtcat-popout.js`

### 8. SSTV Receive Gallery / Received Images Pane

Problem: SSTV decoded/received images were not visibly saved or shown in the Received Images pane.

Implemented behavior:

- Received SSTV images are saved to a gallery directory.
- Gallery records are discovered and loaded.
- Received Images pane renders saved images.
- Open Folder works.
- Legacy gallery migration is handled.
- SSTV can use RS-BA1 RX audio for decode and RS-BA1 TX audio for transmit when ready.

Key files:

- `main.js`
  - gallery directory helpers
  - gallery record helpers
  - SSTV encode/decode hooks
  - Icom Network SSTV TX path
- `renderer/sstv-popout.html`
- `renderer/sstv-popout.js`
- `renderer/app.js`
- `test/sstv-test.js`

### 9. Local Build Numbering + Deploy Workflow

Implemented behavior:

- Local builds append `.N` to the base version, e.g. `1.8.3.39`.
- `local-build.json` stores `{ baseVersion, build }`.
- `scripts/bump-local-build.js` increments the local build number.
- `package.json` includes `local-build.json` in packaged app resources and runs the bump for `dist:mac`.

Key files:

- `scripts/bump-local-build.js`
- `local-build.json`
- `package.json`
- `main.js` display/version read logic

Mac deploy recipe:

```sh
npm run dist:mac
osascript -e 'tell application "POTACAT" to quit' || true
sleep 2
ditto /Users/csparrow/Documents/POTACAT/dist/mac-arm64/POTACAT.app /Applications/POTACAT.app
open -a /Applications/POTACAT.app
```

Verification recipe:

```sh
node - <<'NODE'
const asar=require('@electron/asar');
const app='/Applications/POTACAT.app/Contents/Resources/app.asar';
console.log(asar.extractFile(app,'local-build.json').toString().trim());
NODE
```

## Test Suite Added/Expanded

Important test commands:

```sh
node --check main.js
node --check renderer/app.js
node --check renderer/jtcat-popout.js
node --check lib/rsba1-transport.js
node test/rsba1-transport.test.js
node test/jtcat-test.js
node test/sstv-test.js
```

Added/important test file:

- `test/rsba1-transport.test.js`

RS-BA1 tests cover:

- local routed address selection
- assigned CI-V port use
- token removal on disconnect
- invalid credentials
- exact Login retry
- CI-V fallback
- RX audio decode
- TX audio negotiation and packets
- 20 ms frame grouping
- 16 kHz compatibility path
- stereo duplication path
- band-limited 12 kHz -> 48 kHz resampling
- learned audio remote port
- capability rejection for TX audio
- CI-V open retry
- no-IAmHere diagnostics

## Research Anchors

The working implementation was informed by:

- wfview source:
  - upstream: `https://gitlab.com/eliggett/wfview.git`
  - local reference path: `.codex-ref/wfview`
  - studied commit: `cd18ea55fe479eb4526d1732b443cbfc3969c540`
  - important files / behaviors:
  - `src/radio/icomudpaudio.cpp`
  - `src/radio/icomserver.cpp`
  - 20 ms audio period
  - 150 ms default RX/TX latency
  - 1364-byte audio chunking
  - `ident` and big-endian `sendseq` / `datalen`
- RS-BA1 UDP behavior observed from the IC-7610.
- SDR Control behavior as a real-world benchmark, but not decompiled.
- WSJT-X / FT8 best practices:
  - upstream: `https://git.code.sf.net/p/wsjt/wsjtx`
  - local reference path: `.codex-ref/wsjtx`
  - studied commit: `b4f9a431bcf6449df8f37b56de79d48b665b044c`
  - important files / behaviors:
  - 12 kHz FT8 baseband from JTCAT
  - slot start convention around +500 ms for FT8
  - clean low-ALC digital audio, not clipped samples

Do not vendor or commit `.codex-ref/` into the POTACAT fork. These repositories are
research references only; use the pinned upstream URLs and commits above to recreate
the same context later.

## Future Re-Apply Strategy

Best path for future upstream updates:

1. Keep this local feature set on a long-lived branch, ideally named something like `codex/local-feature-set`.
2. When upstream POTACAT changes, rebase/merge upstream into that branch.
3. Re-apply in feature clusters, not as one blob:
   - multi-op profiles
   - RS-BA1 transport core
   - JTCAT/SSTV IP audio routing
   - Network TX gain UI
   - SSTV gallery
   - JTCAT UI polish
   - local build numbering
4. Run tests after each cluster.
5. Use real-radio validation only after the unit tests pass.

Recommended patch export after stabilizing:

```sh
git diff -- main.js lib/rsba1-transport.js renderer/index.html renderer/app.js renderer/jtcat-popout.html renderer/jtcat-popout.js renderer/sstv-popout.html renderer/sstv-popout.js preload.js preload-jtcat-popout.js test/rsba1-transport.test.js test/sstv-test.js package.json scripts/bump-local-build.js > docs/desktop-handoffs/local-feature-set.patch
```

If preparing an upstream PR, split into smaller PRs:

1. Multi-op profile segregation and operator switcher.
2. RS-BA1 CAT-only protocol/tests.
3. RS-BA1 RX audio for JTCAT/SSTV.
4. RS-BA1 TX audio with Network TX gain and tests.
5. SSTV gallery / Received Images persistence.
6. JTCAT UX polish.

## Open Risks / Things Not Fully Solved

- RS-BA1 RX/TX over Wi-Fi can still have occasional cutouts/splats. SDR Control also shows network sensitivity, and Ethernet is materially better.
- RS-BA1 TX is confirmed decodable and has completed contacts, but per-radio gain calibration still matters.
- `Network TX gain`, `JTCAT TX Pwr`, and radio `LAN MOD gain` interact. Avoid clipping in POTACAT; prefer clean samples plus radio-side trim.
- The local repo has many touched files. Before upstream contribution, split/clean patches and remove purely diagnostic noise where appropriate.
- `.codex-ref/` is local research material and should not be committed unless intentionally vendoring references.

## Quick “Do Not Regress” Checklist

Before calling a future merge successful:

- App displays local build suffix.
- Operator switcher appears in top nav and Summary.
- Switching operator restarts and changes profile-scoped logbook/settings.
- RS-BA1 Test Connection succeeds with frequency and CI-V address.
- Audio Source = `Icom Network audio (RS-BA1)` produces JTCAT decodes.
- `Network TX gain` appears in the RS-BA1 settings pane and defaults to 72%.
- Tune over RS-BA1 keys radio and produces clean narrow tone.
- JTCAT FT8 over RS-BA1 produces clean decodable signal and completes a QSO.
- Long JTCAT session does not crash when TX audio sequence passes 65535.
- SSTV received images save and show in Received Images pane.
- JTCAT popout filter button says `CQ`, not `CQ/73`.
- JTCAT popout title does not overlap macOS traffic-light buttons.

## Post-Upstream Merge Notes - v1.8.5 Local Builds

After merging upstream POTACAT `v1.8.5` into the local feature branch, the local build series continued from `v1.8.5.1` through `v1.8.5.5` on branch `codex/merge-upstream-v1.8.4`.

Important commits from this merge cycle:

- `ea603dc` - merged upstream POTACAT `1.8.5` into the local feature set branch.
- `daef4e7` - handled mDNS bind errors without crashing.
- `c0cb654` - hid the top operator switcher when only one profile exists.
- `a39ed1f` - recovered the JTCAT IP waterfall after profile switch / stale UI sink.
- `6ef024a` - cleanly released RS-BA1 on operator switch.

### Operator Switch + RS-BA1 Release

Problem seen after adding Andrea/WD4DRA profile: switching operators could throw off the IP radio connection, CAT, and RS-BA1 audio. The underlying issue was not profile storage; the profile data was correct. The problem was restart timing. `profiles-switch` updated `activeProfile` and immediately called `app.relaunch(); app.exit(0);`, which could kill the old process before RS-BA1 release packets and DATA MOD restore had time to leave the machine. The IC-7610 sometimes held the prior RS-BA1 session briefly, causing the next startup to receive a status rejection such as `error=0xfdffffff` or to connect only after a retry / radio power cycle.

Working fix:

- `switchProfile()` now returns the previous callsign as `previousCallsign`.
- The profile-switch IPC handler still returns quickly to the renderer, but the actual relaunch waits for `prepareProfileSwitchRelaunch()`.
- `prepareProfileSwitchRelaunch()`:
  - clears pending Icom network reconnect timers,
  - releases remote/PTT state,
  - cancels active RS-BA1 TX audio if present,
  - attempts DATA1 MOD restore,
  - stops RS-BA1 RX watchdog/pacer,
  - disconnects CAT/RS-BA1 and nulls local transport refs,
  - sends a disconnected CAT status,
  - waits `ICOM_NETWORK_PROFILE_SWITCH_RELEASE_DELAY_MS` (`1200 ms`) before relaunch.
- The relaunched instance still uses the startup RS-BA1 delay (`3.5 s`), so the radio now gets both an explicit old-session release window and the normal new-session startup wait.

Key files/functions:

- `main.js`
  - `switchProfile()`
  - `prepareProfileSwitchRelaunch()`
  - `ICOM_NETWORK_PROFILE_SWITCH_RELEASE_DELAY_MS`
  - `profiles-switch` IPC handler
  - `isRetriableIcomNetworkConnectError()`
- `lib/rsba1-transport.js`
  - `ControlStream._onStatus()` now emits `RSBA1_STATUS_REJECTED` when the radio returns a nonzero status and no CI-V port.

Diagnostic signs:

```text
[multi-op] preparing clean profile switch W4LAB -> WD4DRA
[multi-op] clean profile switch release complete after 1200ms
[Icom Network] Waiting 3.5s before startup connect so the radio can release any previous RS-BA1 session.
[rsba1/control] <- Status (error=0x0 civPort=50002 audioPort=50003)
[Icom-Network-Audio] audio stream ready (RX/TX)
```

If future builds regress, check whether profile switch again bypasses graceful RS-BA1 teardown or whether app quit/relaunch paths are skipping `cat.disconnect()` before `app.exit(0)`.

### JTCAT IP Waterfall Readiness After Profile Switch

Problem seen with WD4DRA: JTCAT decoded over RS-BA1, but the waterfall looked wrong/blank. Logs showed RS-BA1 audio flowing and decoder audio being fed, but main repeatedly logged `JTCAT-IP-AUDIO-NO-READY`. This meant the FT8 engine path was alive while the renderer/popout synthetic IP-audio sink had not announced readiness after profile switch/relaunch.

Working fix:

- `sendIcomNetworkJtcatUiAudio()` now detects this state:
  - RS-BA1 audio frames are flowing,
  - JTCAT is running,
  - neither main nor popout window has sent `jtcat-ip-audio-ready=true`.
- It sends a throttled restart nudge to the active JTCAT UI:
  - `restart-popout-audio` for the JTCAT popout,
  - `restart-jtcat-audio` for the main window.
- The nudge is throttled by `_icomNetworkJtcatReadyNudgeMs` so it cannot spin.

Good log sequence:

```text
JTCAT-IP-AUDIO-NO-READY main=1 popout=0
JTCAT-IP-AUDIO-READY wc=2 ready=0
JTCAT-IP-AUDIO-NUDGE event=restart-popout-audio wc=2
JTCAT-IP-AUDIO-READY wc=2 ready=1
```

This fix deliberately does not change CAT, RS-BA1 packet handling, or decoder audio. It only self-heals the UI waterfall/audio-monitor consumer.

### Top Operator Switcher Visibility

After upstream merge, the top-nav quick operator switcher was adjusted to only display when more than one profile exists. This avoids wasting top-nav space for single-operator installs while preserving quick switching for multi-op setups.

Key behavior:

- Summary Settings operator dropdown remains available.
- Top nav operator dropdown is hidden when `profiles.length <= 1`.
- Top nav operator dropdown is shown when two or more profiles exist.

Key files:

- `renderer/index.html` - `top-op-switch`, `top-op-select`
- `renderer/app.js` - `_renderOperatorSelects()` toggles `hidden` on the top switcher.

### RX Pacer Tuning Carried With v1.8.5.5

The `v1.8.5.5` build also carried RS-BA1 RX pacer changes intended to reduce perceived dropouts without reintroducing the large real-time delay we saw in earlier attempts.

Current relevant values:

- `ICOM_NETWORK_RX_PACER_START_MS = 1000`
- `ICOM_NETWORK_RX_PACER_RESUME_MS = 500`
- `ICOM_NETWORK_RX_RESTART_STALL_MS = 8000`
- `_tick()` can emit bounded catch-up frames when the event loop fires late.

Reasoning:

- Very deep buffers improved dropout masking but delayed FT8 waterfall/frequency reality too much.
- Too little buffering made Wi-Fi/network stalls visible as audio dropouts.
- The compromise keeps the buffer modest, allows limited catch-up after short event-loop stalls, and restarts audio only after a longer real stall.

Caution: future changes to this area should be tested with JTCAT decodes, waterfall delay after band changes, and RS-BA1 RX diagnostics. Do not judge by “less dropout” alone if the waterfall becomes delayed or decode timing gets stale.

### RS-BA1 RX Stall Escalation Under Video / Network Load

`v1.8.5.7` adds an escalation path for hard RS-BA1 audio stalls observed when the Mac was playing YouTube while POTACAT was serving ECHOCAT/JTCAT audio.

Observed log pattern:

- RX gaps grew from hundreds of milliseconds to multi-second stalls.
- Missing packet requests often received no useful response.
- Renderer audio backpressure appeared on `smartsdr-audio-frame` and/or `jtcat-vita49-audio`.
- The audio-only RS-BA1 stream restart reported `audio stream ready`, but usable audio did not resume.
- Manual reconnect recovered the radio session.

Fix:

- Keep audio-only recovery for normal transient stalls.
- After `ICOM_NETWORK_RX_FULL_RECONNECT_AFTER_AUDIO_RESTARTS = 3` stalled audio-restart attempts, request a full CAT/RS-BA1 reconnect via `connectCat()`.
- This mirrors the manual recovery path and avoids looping audio-only stream restarts forever.

Key file:

- `main.js` - `startIcomNetworkRxWatchdog()`

### mDNS Bind Crash After Upstream Merge

After the upstream merge, local launch could crash on mDNS bind conflicts, especially around `bonjour-service` / `multicast-dns` on UDP 5353. The local fix catches/logs mDNS bind errors instead of letting them become fatal startup exceptions.

Key file:

- `lib/remote-server.js`

Commit:

- `daef4e7 Handle mDNS bind errors without crashing`

### ECHOCAT Cloud Tunnel Operator Isolation

`v1.8.5.6` changes the POTACAT Cloud Tunnel from a shared machine-level file to a profile-scoped file:

- Old/shared path: `~/Library/Application Support/POTACAT/cloud-tunnel.json`
- New/operator path: `~/Library/Application Support/POTACAT/profiles/<CALL>/cloud-tunnel.json`

Why this matters:

- The Summary/ECHOCAT card used to show a green Cloud Tunnel for every operator if the station computer had one live tunnel.
- That meant WD4DRA could appear to have `w4lab.potacat.com` configured even though the tunnel belonged to W4LAB's cloud account.
- This conflicted with the multi-operator design promise that each operator has their own Cloud account/tunnel identity.

Implementation notes:

- `lib/cloud-tunnel.js` now accepts an explicit `configPath`.
- `main.js` passes `profileCloudTunnelPath(settings.activeProfile || settings.myCallsign)` when constructing `CloudTunnelManager`.
- Startup runs `migrateLegacyCloudTunnelConfig(settings)` once. It infers the owner from the first label of `cloudHost`, so `w4lab.potacat.com` migrates to `profiles/W4LAB/cloud-tunnel.json` even if another profile is currently active.
- The old shared file is archived as `cloud-tunnel.json.legacy` after a successful migration.
- `pairedDevices` and legacy `cloudTunnelToken` were removed from `GLOBAL_KEYS`, so future ECHOCAT pairings/token-like settings save operator-scoped instead of globally.

Validation on K3SBP Mac:

- Active profile was `WD4DRA`.
- Existing shared tunnel was `w4lab.potacat.com`.
- After first `v1.8.5.6` launch:
  - `profiles/W4LAB/cloud-tunnel.json` exists and is enabled.
  - `profiles/WD4DRA/cloud-tunnel.json` does not exist.
  - shared `cloud-tunnel.json` no longer exists.
  - shared `cloud-tunnel.json.legacy` exists as a safety archive.

Regression guard:

- `test/cloud-tunnel.test.js` verifies `CloudTunnelManager` persists to an explicit profile-scoped `configPath` instead of the shared app folder.

### Local Build / Deploy Practice

Current local deployed build after this cycle:

- `v1.8.5.7`
- Branch: `codex/merge-upstream-v1.8.4`
- GitHub fork: `78hawkeye/POTACAT`
- Latest relevant commit before this note: `6ef024a Cleanly release RS-BA1 on operator switch`

Deployment pattern remains:

```bash
npm test
npm run dist:mac
osascript -e 'tell application "POTACAT" to quit' >/dev/null 2>&1 || true
sleep 2
rm -rf /Applications/POTACAT.app
ditto dist/mac-arm64/POTACAT.app /Applications/POTACAT.app
xattr -dr com.apple.quarantine /Applications/POTACAT.app 2>/dev/null || true
open -a /Applications/POTACAT.app
```
