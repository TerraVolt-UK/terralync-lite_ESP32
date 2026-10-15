# TerraLync Lite — Web Flasher

Browser-based ESP32-S3 flasher using [esptool-js](https://github.com/espressif/esptool-js)
over the Web Serial API. Auto-detects the board (same probe/gate/tier logic as
`terralync_lite_flasher.py`), verifies SHA-256 of each image, and writes
firmware `@0x0` + LittleFS at the tier's VFS offset in one pass.

Works in Chrome/Edge/Brave/Opera on Windows, macOS, Linux and ChromeOS.
**Not** Safari, Firefox, or any mobile browser (no Web Serial).

## Files

| Path | Purpose |
|---|---|
| `index.html` | Flasher page (TerraLync site styling) |
| `flasher.js` | Detection/gate/flash logic — ESM, imports the vendored bundle |
| `vendor/esptool-js-0.7.0.js` | Official esptool-js bundle (unpkg `esptool-js@0.7.0/bundle.js`) |
| `styles.css` | Copy of `terralync-website/css/styles.css` — keep in sync |
| `images/` | Logo + favicons copied from the website |
| `firmware/` | Release binaries staged at publish time |
| `assets.json` | Generated — tier → {fw file, fs file, offset, sha256} |
| `make_assets.py` | Regenerates `assets.json` from `firmware/` |

## Detection (mirrors the desktop flasher)

| Port VID:PID | Probe result | Tier |
|---|---|---|
| `303A:1001` (native USB) | ≥16 MB flash, **2 MB** PSRAM | `geek-16mb` |
| `1A86:7523` (CH340) | ≥16 MB flash, **≥8 MB** PSRAM | `guition-16mb` |
| `0483:5740` | — | GEEK runtime → instructed to replug holding BOOT |
| anything | ≥16 MB / 8 MB flash | `16mb` / `8mb` |

Gate: chip `ESP32-S3`, ≥8 MB flash (JEDEC `flash_id` capacity byte),
≥2 MB PSRAM (efuse `getPsramCap`). Users can override the tier under Advanced.

## Local test

```bat
cd terralync-website\webflash
python -m http.server 8123
:: open http://localhost:8123 in Chrome/Edge  (localhost is a secure context)
```

## Deploy — GitHub Pages on `TerraVolt-UK/terralync-lite_ESP32`

Live at `https://terravolt-uk.github.io/terralync-lite_ESP32/` — served from
the `gh-pages` branch (Pages → legacy branch deploy, `.nojekyll`).

**Firmware/app binaries are release-linked:** `.github/workflows/publish-webflash.yml`
(on `main`) fires on every `release: published` event (and via
Actions → Run workflow). It:

1. Resolves the newest **non-prerelease** `firmware-v*` and `app-v*` tags
   (paginated — hundreds of `-test.` prereleases sit above stable).
2. `gh release download`s the `terralync-*.bin` / `terralync-lite-fs-*.bin`
   assets into `firmware/`.
3. Runs `make_assets.py` to regenerate `assets.json` with fresh SHA-256s.
4. Commits + pushes to `gh-pages`.

So shipping a stable firmware/app release automatically updates the web
flasher — no manual step.

**Page/JS/styling changes** are the manual part: this directory is the
source of truth. After editing, copy the tree onto the `gh-pages` branch
and push:

```bat
git clone https://github.com/TerraVolt-UK/terralync-lite_ESP32 lite-pages
cd lite-pages && git checkout gh-pages
xcopy /E /Y ..\terralync-website\webflash\* .
git add -A && git commit -m "webflasher UI update" && git push
```

The flasher page and binaries are same-origin → no CORS.

## Known limits / TODO

- Port picker is mandatory (browser rule) — filters narrow it to ESP-class devices.
- GEEK runtime-USB requires the hold-BOOT replug dance (same as the .exe).
- `assets.json` currently carries one stable version set — channel picking
  (stable/dev) would need per-channel tier maps.
- Post-flash verify relies on the ROM's own write path; the page verifies
  SHA-256 of the *downloaded* images before writing (same guarantee as the .exe).
