# GaggiMate Dial-in (phase 1)

Adds the Dial-in assistant to GaggiMate v1.9.0. It runs entirely on the machine:
the display firmware serves the app from the SD card, stores its data there and
checks every profile the assistant saves against hard safety limits. It never
starts a shot.

## What is in this version

- **Dial-in** item in GaggiMate's menu, opening `http://gaggimate.local/dialin/`.
- **Last shot**: time, yield, ratio, peak pressure, a pressure / flow / weight
  chart, and the shot's tasting notes. Refreshes when a new shot is saved.
- **Profiles**: every brew profile on the machine, checked against the limits.
- **Settings**: safety limits (tighten only; the machine caps them at 10 bar,
  96 °C, 4 g/s, 60 s, 60 g), SD card space, plugin version.

## Install

1. **Flash the firmware** (`display-firmware.bin`) to the display. Only the app
   partition changes; profiles and shots on the SD card are untouched.
2. **Copy the app**: unzip `dialin-sdcard.zip` and copy its `dialin` folder to
   the root of the SD card, so the card has `/dialin/www/index.html`.
3. Open GaggiMate's web UI and choose **Dial-in** in the menu.

Do not install GaggiMate updates from its web UI while you run this edition:
an official update replaces the firmware and removes the Dial-in plugin (your
data on the SD card stays).

To update the app later, replace `/dialin/www/` on the card; no flashing needed.

## Machine API added by the plugin

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dialin/status` | Plugin version, SD card, limits |
| GET / POST | `/api/dialin/limits` | Read / tighten safety limits |
| POST | `/api/dialin/profile/check` | `{profile}` → `{ok, errors[]}` |
| POST | `/api/dialin/profile/save` | `{profile, select}` → saves only if it passes |
| GET | `/api/dialin/data/<collection>` | List record ids |
| GET / POST / DELETE | `/api/dialin/data/<collection>/<id>` | Read / write / delete a JSON record |

## Source

- `src/display/plugins/DialInPlugin.*`: the plugin.
- `src/display/plugins/dialin/SafetyValidator.h`: the limits, tested in
  `test/test_dialin_safety` (`pio test -e native -f test_dialin_safety`).
- `web/src/components/Navigation.jsx`: the Dial-in menu item.
- `dialin-app/dialin/www/`: the app (plain HTML/JS, no build step).

Licensed like GaggiMate: CC BY-NC-SA 4.0.
