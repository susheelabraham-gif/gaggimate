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

You need Chrome or Edge on a computer, a USB-C cable to the display, and the
build files from GitHub: your fork → **Actions** → the latest green
**build-dialin** run → **Artifacts** → `gaggimate-dialin-firmware`.

1. **Copy the app to the SD card.** Unzip `dialin-sdcard.zip` and copy its
   `dialin` folder to the root of the card, so the card has
   `/dialin/www/index.html`.
2. **Connect the display** to the computer by USB.
3. Open https://espressif.github.io/esptool-js/ in Chrome, set the baud rate to
   921600 and click **Connect**, then pick the display's port. If it won't
   connect, hold the BOOT button (SW1) while plugging the cable in.
4. Add two files, and nothing else:
   - `0xe000` → `boot_app0.bin`
   - `0x10000` → `display-firmware.bin`
5. Click **Program**. Do not click **Erase Flash**: that would wipe Wi-Fi and
   settings.
6. Unplug and replug the display, open GaggiMate's web UI and choose
   **Dial-in** in the menu.

`boot_app0.bin` makes the display start from the slot you just wrote. Without
it, a display that last updated over the air keeps starting the old firmware.
Settings, Wi-Fi, profiles and shots are not touched.

To go back to official GaggiMate, use the normal flasher on
https://docs.gaggimate.eu/docs/flashing.

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
