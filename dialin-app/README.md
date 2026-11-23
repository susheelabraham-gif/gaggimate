# GaggiMate Dial-in

Adds the Dial-in assistant to GaggiMate v1.9.0. It runs entirely on the machine:
the display firmware serves the app from the SD card, stores its data there and
checks every profile the assistant saves against hard safety limits. It never
starts a shot.

## What is in this version (0.2.0)

- **Dial-in** item in GaggiMate's menu, opening `http://gaggimate.local/dialin/`.
- **Coffees**: add a coffee from a photo of the bag and/or its name. Claude
  looks it up (roaster page first, then reviews and forums) and fills in origin,
  process, roast level, tasting notes and any recipe; you check and correct it.
  Adding a coffee you've had before records a **new bag** instead.
- **Salami diagnostic** for a new coffee: one shot split into 3–5 cups, planned
  from the roast level and any recipe found. Each cup is a phase named "Cup N"
  that ends on water pumped; the machine's screen shows the cup to use and the
  phone beeps. Afterwards you weigh each cup (one tap reads the Bookoo) and tap
  what you taste. The app turns that into a starting recipe (yield, ratio,
  temperature, pre-infusion, grind hint) and saves it as the active profile.
- **Last shot**: time, yield, ratio, peak pressure, a pressure / flow / weight
  chart, and the shot's tasting notes.
- **Profiles**: every brew profile on the machine, checked against the limits.
- **Settings**: grinder (model, smallest step, usual grind), usual dose, your
  Anthropic API key (kept in the browser only), safety limits, SD card space.

The machine checks every profile the app saves: at most 10 bar, 96 °C, 4 g/s,
60 s, 60 g, one change per shot. Salami profiles may stop on water pumped
instead of weight, at most 30 ml per cup and 100 ml per shot.

### AI look-ups

You need an Anthropic API key with web search enabled for its organization in
the Claude Console. The browser calls the API directly, so the key is visible
to anyone using that browser; use a key with a spending limit.

## Install

You need Chrome or Edge on a computer, a USB-C cable to the display, and the
build files from your fork's **Releases** page ("Dial-in build N").

1. **No card copying needed.** The app is built into the firmware; on start-up
   the display copies it to `/dialin/www/` on the SD card whenever the card has
   a different version. (`dialin-sdcard.zip` is still provided if you prefer to
   copy it yourself.)
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

Flashing a newer build also updates the app on the card. After editing the app, run
`python3 scripts/embed_dialin_app.py` to refresh the copy built into the firmware.

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
  `lib/dialin.js` holds the salami planning and recipe logic, `lib/ai.js` the
  look-ups; tests in `dialin-app/test` (`cd dialin-app && npm test`).

Licensed like GaggiMate: CC BY-NC-SA 4.0.
