# G502 X Control Center — status & plan

## IMPORTANT lesson from last time — commit and push every session

A previous session built this entire app (this same architecture: Flask +
ratbagctl + mock fallback + HTML/CSS/JS frontend + Electron shell) but never
committed/pushed it. That session's container was reclaimed and the work was
gone — the repo had nothing but a 2-line README when this session started.
**Remote sessions run in ephemeral containers. If it isn't committed and
pushed, it does not exist next session.** Commit early and often, not just at
the very end.

## What exists right now

- `app/backend/` — Flask app (`app.py`) wrapping `ratbagctl` (`ratbag_client.py`),
  with a `MockRatbagClient` fallback for dev/testing without hardware.
- `app/frontend/` — plain HTML/CSS/JS, dark UI, mouse diagram with clickable
  button markers, DPI/rate/profile controls.
- `app/electron/` — desktop shell, spawns the backend and loads the frontend.
- `app/README.md` — exact setup/run commands, including real-hardware steps.
- `app/frontend/assets/mouse-illustration.png` — G502 X top-view line art,
  extracted from the Claude Design mockup (see below).

Verified in this sandbox with `RATBAG_MODE=mock` only (curl'd every endpoint,
screenshotted every UI section with Playwright, exercised the button editor
end-to-end). **Never run against a real mouse** — this sandbox has no dbus,
no ratbagd, no USB access. That verification is the next session's job (or
yours, right now, on your actual machine — see `app/README.md` §2).

## Where the design came from

There was a Claude Design mockup (`G502X Control Center.dc.html` mentioned in
the original brief) but it didn't exist anywhere in this repo or session —
the user re-exported it as a "Standalone" bundled HTML from Claude Design and
pasted the path in. That bundle format wraps the real component template as
an escaped JSON string inside a `<script type="__bundler/template">` tag,
plus a `<script type="__bundler/manifest">` blob with embedded base64
resources (fonts + one PNG). If this happens again: extract the manifest and
template scripts by JSON-decoding their contents (they're JSON string
literals, not raw HTML) rather than trying to read the bundle file directly —
it's one file with ~300KB single-line strings that neither Read nor grep
handle usefully as-is.

The extracted mockup was a **pure client-side prototype** (fake state, no
backend) with an 11-button model (`left, right, middle, wheelLeft,
wheelRight, button6, button7, button8, forward, backward, thumb`) and marker
coordinates that turned out **not** to be well aligned to its own reference
image (verified by overlaying the coordinates on the image — see below). Its
own code comment claimed the coordinates were "hand-aligned to the real
button locations," but they weren't when actually plotted.

## The button model — corrected to match real hardware

The G502 X / G502 X LIGHTSPEED has **8 programmable buttons**, not 11 —
Logitech dropped 3 buttons (and RGB) from the original G502 to save weight/
power. This was confirmed two ways:
1. The reference PNG itself has "G7"/"G8" labels on the two thumb buttons
   and "G9" on the button behind the wheel — these are Logitech's own official
   button numbers, drawn right on the art.
2. Logitech's G502 X spec sheet lists "8 programmable buttons."

Final model: `left, right, middle, wheelLeft, wheelRight, back (G7), forward
(G8), g9 (DPI shift / sniper, behind the wheel)`.

Marker pixel coordinates in `app/frontend/app.js` (`BUTTON_DEFS`) were
re-measured by cropping the reference PNG with a pixel grid overlaid and
reading off where each real button/label actually sits, then verified by
plotting the candidate coordinates back onto the image and eyeballing the
result (see the overlay screenshots process in this session's history if you
need to redo it — group of `grid_*.png` / `overlay*.png` scratch files).
Trust these coordinates more than anything from memory.

## The actual open question: index ↔ physical button

**This still cannot be verified without your real mouse**, and no static
table exists anywhere (libratbag has no per-device button list for the G502 X
— `data/devices/logitech-g502-x-wireless.device` just says
`Driver=hidpp20`; buttons are enumerated at runtime from the live device's
HID++ control-ID table, whose order isn't documented anywhere offline).

Instead of guessing, the backend (`app.py::detect_roles`) infers each
button's identity from its **current action**, using conventions that hold
regardless of index order:
- a button whose action is "button N" where N ∈ {1..5} is a main/back/forward
  click, by standard USB HID numbering (1=left, 2=right, 3=middle, 4=back,
  5=forward)
- a `wheel-left` / `wheel-right` special is a wheel tilt button
- a `resolution-*` / `second-mode` special is G9 (DPI shift / sniper)

Anything that doesn't match (including any button you've already remapped
away from its factory default) shows up as **unidentified** in the UI — red
marker, no assumed label — rather than a guessed one. The Settings page has
a manual override (stored in browser `localStorage`) plus a documented
wiggle-test procedure (map to an unused key, watch `xev`, press the physical
button) so you can confirm/correct it against your actual hardware.

**When you run this for real**: check Settings → the override list for each
button index, confirm the auto-detected role actually matches by pressing
each physical button once (or trust it if it already matches your factory
config), and fix any that are wrong. Report back anything that's wrong so the
detection heuristic can be improved rather than just overridden client-side.

## Explicitly not implemented

- RGB lighting — the G502 X has none.
- Battery level — `ratbagctl`'s CLI has no command for it (the underlying
  `ratbagd` D-Bus API might expose it via `RatbagdDevice.battery_level`, but
  `ratbagctl` doesn't surface it, and this app only shells out to
  `ratbagctl`, not raw D-Bus).
- A macro builder UI — button editor takes ratbagctl's raw macro syntax
  (`KEY_A t50 -KEY_A`) as free text instead of faking a visual macro editor
  the backend can't really back.

## Next steps

1. Run `app/backend` in `RATBAG_MODE=real` on your machine per
   `app/README.md`, confirm `ratbagctl list` sees the mouse first.
2. Go through every button in the UI and confirm/correct its detected role.
3. Confirm DPI stages, polling rate, and profile switching actually change
   the mouse (LEDs/onboard memory, `ratbagctl <device> ... get` from another
   terminal, etc.).
4. If something in `ratbag_client.py`'s command/parsing assumptions is wrong
   against your real `ratbagctl` version, fix the regexes/format strings
   there — they were sourced from libratbag's `tools/ratbagctl.body.py.in` on
   GitHub, not from a local install, so a version skew is possible.
