# G502 X Control Center — status & plan

## IMPORTANT — commit and push every session

A previous session built this entire app but never committed/pushed it, and
lost a full day of work when its container was reclaimed. **If it isn't
committed and pushed, it does not exist next session.** Commit early and
often, not just at the end. (This session made the same near-miss: a large
amount of work sat uncommitted until explicitly asked for at wrap-up —
don't wait to be asked.)

## What this is

A Flask + vanilla JS/HTML/CSS app for configuring a Logitech G502 X
LIGHTSPEED on Linux via `ratbagctl`/`ratbagd`, tailored to one specific
physical mouse (not a general product) — several things below are hardcoded
because they were empirically confirmed against *this* mouse, not assumed.

- `app/backend/app.py` — Flask routes, role auto-detection, factory-defaults
  recovery.
- `app/backend/ratbag_client.py` — `RealRatbagClient` (shells out to
  `ratbagctl`) and `MockRatbagClient` (in-memory, for dev without hardware).
- `app/frontend/` — plain HTML/CSS/JS. No build step; edit and reload.
- `app/electron/` — desktop shell, untouched this session; still just spawns
  the backend and loads the frontend in a window. Not verified against the
  current backend/frontend by this session — someone should smoke-test it
  before relying on it.

## The button model — confirmed by physical wiggle-testing, not assumed

This mouse has **11 raw `ratbagctl` button indices (0–10)**, of which:
- **10 correspond to real physical buttons.**
- **Index 10** (factory action `resolution-down`) has no physical button at
  all — hidden from the UI entirely (`EXCLUDED_BUTTON_INDICES` in `app.js`).

Confirmed roles (index is the raw 0-based `ratbagctl` index; the UI displays
`index + 1`, i.e. 1-based, because the user found starting at 0 confusing):

| index | role | factory action | notes |
|---|---|---|---|
| 0 | left | `button 1` | |
| 1 | right | `button 2` | |
| 2 | middle | `button 3` | |
| 3 | backward | `button 4` factory, **now `button 5`** | see swap below |
| 4 | dpiShift ("Thumb Button") | `second-mode` factory, **now a macro** | see below |
| 5 | forward | `button 5` factory, **now `button 4`** | see swap below |
| 6 | wheelLeft | `wheel-left` | |
| 7 | wheelRight | `wheel-right` | |
| 8 | button7 ("Index Finger 1") | `profile-cycle-up` | not yet reconfigured, see Open items |
| 9 | button8 ("Index Finger 2") | `resolution-up` | not yet reconfigured, see Open items |
| 10 | *(hidden)* | `resolution-down` | no physical button |

**Forward/Backward are deliberately swapped from the standard HID
convention.** Standard USB HID numbering says button 4 = back, button 5 =
forward, and `app.py`'s `detect_roles()` originally assumed this. On this
user's actual system, back/forward navigation only worked correctly with it
reversed — confirmed by the user directly, not a guess. Both
`_BUTTON_NUMBER_TO_ROLE` in `app.py` (auto-detection) and
`FACTORY_BUTTON_DEFAULTS` (restore-defaults baseline) have been updated to
match. **If you ever "fix" this back to 4=back/5=forward because it looks
wrong, you'll be reintroducing a bug the user explicitly corrected.**

**"Thumb Button" and "DPI Shift" are the same physical button** (index 4),
confirmed by wiggle-test (bound to a distinct test key, watched `showkey`
while pressing). GHUB's name for it is "DPI-Shift", but the user uses it as
a plain macro button (currently a single-key macro sending `KEY_SEMICOLON`)
— it is NOT restricted to DPI-shift functionality, that's just Logitech's
default framing in their own software. Index Finger 1/2 (indices 8/9) are
*separate* physical buttons from the thumb one — confirmed as a distinct
fact from the user, not inferred.

**Button labels/order are user-customized** (`BUTTON_DEFS` array in
`app.js`): Left, Right, Middle, Forward, Backward, Thumb Button, Wheel Tilt
Left, Wheel Tilt Right, Index Finger 1, Index Finger 2. This exact order was
requested repeatedly and specifically — don't reorder it without being
asked. Marker `x`/`y` positions were calibrated by the user dragging markers
onto the real mouse image (Buttons page → Calibrate marker positions →
Copy calibration JSON) — trust these coordinates.

## Index ↔ physical button: still index-dependent, not name-dependent

Auto-detection infers identity from a button's *current action*
(`detect_roles` in `app.py`), not from a fixed index table — libratbag has
no per-device button list for this mouse, and the enumeration order isn't
documented anywhere. This means: **the moment a button is remapped away
from the action `detect_roles` recognizes, it goes "unidentified" until a
manual override is set** (Settings → Manual label overrides, stored in the
browser's `localStorage`). This bit the user hard this session — e.g.
rebinding the Thumb Button's factory `second-mode` action away made it
vanish from auto-detection, and a subsequent UI click landed on the wrong
row/marker as a result. If you add more custom bindings, expect this and
set overrides proactively rather than waiting for confusion.

## Known hardware/driver quirks (all confirmed this session, not theoretical)

1. **This mouse has 5 onboard profiles**, and `ratbagctl` button/resolution
   commands operate on "the active profile" unless one is given explicitly.
   **`ratbagd`'s reported active profile has repeatedly drifted from what
   the hardware is actually running** — the cause of several confusing bugs
   this session (Forward/Backward silently swapping back, Thumb Button
   reverting, stray leftover test bindings surfacing later). The fix:
   `FACTORY_BUTTON_DEFAULTS`/`restore-defaults` and any one-off hardware
   fixes should target **all 5 profiles explicitly** (`ratbagctl <dev>
   profile N button M action set ...`), never rely on "whatever's active."
   `set_button_*` methods in `ratbag_client.py` all take an optional
   `profile:` kwarg for this.
2. **The `ratbagctl` CLI address (`crooning-chinchilla`, `raging-hutia`,
   etc.) is a random nickname per wireless *connection*, not a stable
   device identifier** — it can change on reconnect. `app.py` handles this:
   `_refresh_device_id()` re-resolves by the device's stable *name* via
   `ratbagctl list`, and the `@with_device_reconnect` decorator on every
   route retries once automatically. `/api/status` does a live check every
   call (not cached) so the UI's connection dot reflects reality.
3. **This `ratbagctl` version's output format doesn't match libratbag's
   documented/upstream format in several places** (all fixed in
   `ratbag_client.py`, and worth knowing if a version upgrade changes them
   again):
   - `dpi get` returns `"800dpi"` (unit suffix), not a bare number.
   - Disabled buttons print `Button: N is mapped to none` (bare, unquoted),
     not `'disabled'`.
   - `key`/`macro` actions print the type keyword *outside* the quotes
     (`is mapped to key 'KEY_A'`), not inside them.
   - `dpi get-all` returns every *legal* DPI value (~90 entries), not the
     device's actual configured resolution stages — those must be read via
     `resolution N get` per slot (5 slots on this mouse).
   - Setting the active resolution is `resolution active set N`, not
     `resolution N active set` (argument order, not a formatting quirk).
4. **Empty macros are silently corrupted, not rejected, by `ratbagctl`** —
   sending zero tokens produces a garbage `macro 'None'` binding rather than
   an error. `app.py`'s `/api/button/<index>` now rejects empty macro token
   lists with a 400 before they reach `ratbagctl`.

## Performance

`/api/device` (full snapshot) makes ~28 separate `ratbagctl` subprocess
calls (one per button, one per resolution slot, one per profile, etc.),
each ~80-100ms — roughly 2.3 seconds. It's used **once, at page load only**.
Every action afterward uses a narrower endpoint that only refetches what
that action could have changed:
- `/api/buttons` (~12 calls, ~1s) after a button rebind or restore-defaults.
- `/api/sensitivity` (~9 calls, ~0.7s) after a DPI/rate/resolution change.

If you add a new kind of state to track, follow this pattern — don't route
its refresh through the full `/api/device`/`loadDevice()` path.

## Removed this session

- **Profiles page** — user only uses one profile; onboard-profile switching
  UI was removed. (`/api/profile`, `/api/profile/<n>/name` backend routes
  still exist and work, just aren't exposed in the UI.)
- **Macros page** — was a from-scratch reimplementation of the original
  Claude Design mockup's macro builder (named macros, step list, reorder,
  key-capture), removed as redundant once the per-button editor could do
  the same thing. The shared key-capture modal (`openKeyCaptureModal` /
  `KEYCODE_MAP` in `app.js`) stayed — it's also used by the button editor's
  "Press key…" button, so don't delete it if asked to remove macro-related
  code again.
- **Raw "Macro" option in the button editor** — also removed as redundant.
  A button already holding a macro shows a note pointing at... nothing now
  (Macros page is gone too) — it just says to pick a different action type
  to replace it. Macros can currently only be set by directly hitting
  `POST /api/button/<index>` with `{type: "macro", value: "<tokens>"}`
  (e.g. via `restore-defaults`'s `FACTORY_BUTTON_DEFAULTS`, or curl). There
  is currently **no UI path to create a new macro** — if the user wants
  that back, it needs a new affordance, not a revert.

## Open items

1. **Index Finger 1/2 (indices 8/9) are not yet configured** — still
   holding their factory actions (`profile-cycle-up`/`resolution-up`). User
   plans to unbind them in GHUB (their DPI-changing behavior is apparently
   coming from GHUB, not `ratbagd`/this app — GHUB and this app are
   presumably configuring the same onboard memory, so check for conflicts
   if behavior seems to fight itself) and will ask for these to be
   configured later.
2. **Electron shell (`app/electron/`) hasn't been touched or re-verified**
   this session against the current backend/frontend (button model,
   removed Macros page, new endpoints). Don't assume it works — check
   `app/electron/main.js` (or equivalent) still points at valid routes/DOM
   IDs before telling the user to rely on it.
3. **README.md** setup instructions are still accurate for the basic
   run/setup flow, but its "Verifying the button-marker mapping" section
   pre-dates the swapped Forward/Backward convention and the Thumb Button
   naming above — worth a pass if it causes confusion.
