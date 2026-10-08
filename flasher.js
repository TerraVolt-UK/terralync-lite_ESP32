/* TerraLync Lite Web Flasher — auto-detecting ESP32-S3 flasher over Web Serial.
 * Mirrors tools/terralync_lite_flasher.py: probe chip/flash/PSRAM, gate on
 * minimums, pick a board tier, write firmware@0x0 + LittleFS image at the
 * tier's VFS offset in one writeFlash pass.
 */
import { ESPLoader, Transport } from './vendor/esptool-js-0.7.0.js';

/* Compact MD5 (Uint8Array → hex) — feeds writeFlash's calculateMD5Hash so the
 * ROM's own flash_md5sum can verify each written image on-device. */
function md5Hex(u8) {
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
               5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
               6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const bitLo = (u8.length * 8) >>> 0;
    const bitHi = Math.floor(u8.length / 536870912) >>> 0;   // (len*8) / 2^32
    const rem = u8.length % 64;
    const padLen = (rem < 56 ? 56 - rem : 120 - rem) + 8;
    const buf = new Uint8Array(u8.length + padLen);
    buf.set(u8);
    buf[u8.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, bitLo, true);
    dv.setUint32(buf.length - 4, bitHi, true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    for (let off = 0; off < buf.length; off += 64) {
        for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16)      { f = (B & C) | (~B & D);   g = i; }
            else if (i < 32) { f = (D & B) | (~D & C);   g = (5 * i + 1) & 15; }
            else if (i < 48) { f = B ^ C ^ D;            g = (3 * i + 5) & 15; }
            else             { f = C ^ (B | ~D);         g = (7 * i) & 15; }
            const tmp = D; D = C; C = B;
            B = (B + rol((A + f + K[i] + M[g]) >>> 0, S[i])) >>> 0;
            A = tmp;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const hexLE = (w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}

// ---- VID/PID table (same IDs as the desktop flasher) -----------------------
const ESPRESSIF_VID = 0x303A;
const ESP32S3_USB_SERIAL_JTAG_PID = 0x1001;
const GEEK_RUNTIME_VID = 0x0483;
const GEEK_RUNTIME_PID = 0x5740;
const CH340_VID = 0x1A86;
const CH340_PID = 0x7523;

const PORT_FILTERS = [
    { usbVendorId: ESPRESSIF_VID },
    { usbVendorId: GEEK_RUNTIME_VID, usbProductId: GEEK_RUNTIME_PID },
    { usbVendorId: CH340_VID, usbProductId: CH340_PID },
    { usbVendorId: 0x10C4, usbProductId: 0xEA60 },   // CP210x (generic boards)
    { usbVendorId: 0x0403 },                          // FTDI (generic boards)
];

const MIN_FLASH_MB = 8;
const MIN_PSRAM_MB = 2;
const PSRAM_CAP_MB = { 0: 0, 1: 8, 2: 2 };            // esp32s3.getPsramCap codes
const BOARD_LABELS = {
    '8mb': 'Generic ESP32-S3 (8 MB)',
    '16mb': 'Generic ESP32-S3 (16 MB)',
    'geek-16mb': 'Waveshare ESP32-S3-GEEK',
    'guition-16mb': 'Guition ESP32-4848S040',
};
const BOARD_IMG = {
    '8mb': 'images/boards/generic.jpg',
    '16mb': 'images/boards/generic.jpg',
    'geek-16mb': 'images/boards/geek.jpg',
    'guition-16mb': 'images/boards/guition.jpg',
};

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
    unsupported: $('unsupported'), btnConnect: $('btn-connect'), connectStatus: $('connect-status'),
    cardDetect: $('card-detect'), pChip: $('p-chip'), pFlash: $('p-flash'), pPsram: $('p-psram'),
    pUsb: $('p-usb'), pMac: $('p-mac'), gateOk: $('gate-ok'), gateBad: $('gate-bad'),
    gateBadMsg: $('gate-bad-msg'), detectedBoard: $('detected-board'),
    cardInstall: $('card-install'), btnFlash: $('btn-flash'), flashStatus: $('flash-status'),
    selTier: $('sel-tier'), selBaud: $('sel-baud'), chkAppOnly: $('chk-app-only'),
    fwVer: $('fw-ver'), appVer: $('app-ver'),
    progLabel: $('prog-label'), progPct: $('prog-pct'), progFill: $('prog-fill'),
    cardDone: $('card-done'), donePower: $('done-power'), boardImg: $('board-img'), log: $('log'),
    steps: [$('step-1'), $('step-2'), $('step-3')],
};

// ---- State ----------------------------------------------------------------
let port = null, transport = null, loader = null;
let probeResult = null, detectedTier = null, assets = null, busy = false;

// ---- Logging --------------------------------------------------------------
function log(msg, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
}
const logOk = (m) => log(m, 'lg-ok'), logErr = (m) => log(m, 'lg-err'),
      logWarn = (m) => log(m, 'lg-warn'), logDim = (m) => log(m, 'lg-dim');

// esptool-js writes banner output through this terminal object
const terminal = {
    clean() {},
    write(s) { if (s.trim()) logDim(s); },
    writeLine(s) { if (s.trim()) logDim('  ' + s); },
};

// ---- UI helpers -----------------------------------------------------------
function setStep(n) { // 1..3 active; earlier ones done
    ui.steps.forEach((el, i) => {
        el.classList.toggle('done', i < n - 1);
        el.classList.toggle('active', i === n - 1);
    });
}
function setProgress(label, pct) {
    ui.progLabel.textContent = label;
    ui.progPct.textContent = pct == null ? '' : Math.floor(pct) + '%';
    ui.progFill.style.width = (pct || 0) + '%';
}
function show(el) { el.classList.remove('hidden'); el.classList.add('show'); }
function hide(el) { el.classList.add('hidden'); el.classList.remove('show'); }

function setBoardArt(tier) {
    const src = BOARD_IMG[tier];
    if (!src) return;
    ui.boardImg.src = src;
    ui.boardImg.alt = BOARD_LABELS[tier] || 'ESP32-S3 board';
    ui.boardImg.classList.remove('hidden');
}

function transportName(vid, pid) {
    if (vid === ESPRESSIF_VID && pid === ESP32S3_USB_SERIAL_JTAG_PID) return 'Native ESP32-S3 USB';
    if (vid === GEEK_RUNTIME_VID && pid === GEEK_RUNTIME_PID) return 'GEEK runtime USB';
    if (vid === CH340_VID && pid === CH340_PID) return 'CH340 USB-serial';
    if (vid === ESPRESSIF_VID) return 'Espressif USB';
    return 'Serial port';
}

// ---- Assets ---------------------------------------------------------------
async function loadAssets() {
    if (assets) return assets;
    const r = await fetch('assets.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('assets.json missing (HTTP ' + r.status + ')');
    assets = await r.json();
    ui.fwVer.textContent = 'v' + assets.firmware_version;
    ui.appVer.textContent = 'v' + assets.app_version;
    return assets;
}

async function fetchVerified(relPath, expectSha) {
    logDim('Downloading ' + relPath + ' …');
    const r = await fetch(relPath);
    if (!r.ok) throw new Error('Download failed: ' + relPath + ' (HTTP ' + r.status + ')');
    const buf = new Uint8Array(await r.arrayBuffer());
    if (expectSha) {
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        if (hex !== expectSha) throw new Error('SHA-256 mismatch for ' + relPath + ' — refusing to flash.');
        logOk('  SHA-256 verified (' + (buf.length / 1048576).toFixed(1) + ' MB)');
    }
    return buf;
}

// ---- Probe + gate (mirrors _probe_hardware/_evaluate in the .py) -------------
async function probeAndGate(thePort) {
    port = thePort;
    const info = port.getInfo() || {};
    const vid = info.usbVendorId, pid = info.usbProductId;
    log('Selected: ' + transportName(vid, pid) +
        (vid != null ? ' [' + hex4(vid) + ':' + hex4(pid) + ']' : ''));

    // GEEK in runtime mode can't be flashed — user must replug holding BOOT.
    if (vid === GEEK_RUNTIME_VID && pid === GEEK_RUNTIME_PID) {
        logWarn('GEEK is in runtime mode. Unplug it, hold BOOT, reconnect, release BOOT, then click Connect again.');
        ui.connectStatus.textContent = 'Reconnect while holding BOOT, then click Connect again.';
        return;
    }

    ui.connectStatus.textContent = 'Probing hardware…';
    log('Connecting (baud ' + ui.selBaud.value + ')…');
    let chipDesc;
    try {
        await openLoader(parseInt(ui.selBaud.value, 10));   // detect + sync + stub + baud + flash_id
        chipDesc = loader.chip ? await loader.chip.getChipDescription(loader) : 'unknown';
    } catch (e) {
        logErr('Could not reach the bootloader: ' + friendlyError(e));
        logDim('Tip: unplug, hold BOOT, reconnect, release BOOT, then try again.');
        ui.connectStatus.textContent = 'Bootloader not found — try the BOOT-button method.';
        await teardownLoader();
        return;
    }

    const res = { chip: '', flashMB: 0, psramMB: 0, vid, pid, mac: '', features: [] };
    try {
        res.chip = loader.chip ? loader.chip.CHIP_NAME : 'unknown';
        const flashId = await loader.readFlashId();
        const capByte = (flashId >> 16) & 0xff;                 // JEDEC capacity = 2^N bytes
        if (capByte > 0 && capByte < 0x40) res.flashMB = Math.pow(2, capByte) / 1048576;
        if (loader.chip && typeof loader.chip.getPsramCap === 'function')
            res.psramMB = PSRAM_CAP_MB[await loader.chip.getPsramCap(loader)] ?? 0;
        if (loader.chip && typeof loader.chip.getChipFeatures === 'function')
            res.features = await loader.chip.getChipFeatures(loader);
        if (loader.chip && typeof loader.chip.readMac === 'function')
            res.mac = await loader.chip.readMac(loader);
        logDim('Chip: ' + chipDesc + ' · features: ' + res.features.join(', '));
    } catch (e) {
        logWarn('Partial probe: ' + friendlyError(e));
    }
    probeResult = res;

    ui.pChip.textContent = res.chip;
    ui.pFlash.textContent = res.flashMB ? res.flashMB + ' MB' : 'unknown';
    ui.pPsram.textContent = res.psramMB ? res.psramMB + ' MB' : 'none detected';
    ui.pUsb.textContent = transportName(vid, pid);
    ui.pMac.textContent = res.mac || '—';
    ui.cardDetect.classList.add('show');

    const compatible = res.chip === 'ESP32-S3' && res.flashMB >= MIN_FLASH_MB && res.psramMB >= MIN_PSRAM_MB;
    if (!compatible) {
        hide(ui.gateOk); show(ui.gateBad);
        ui.gateBadMsg.innerHTML = '<strong>Incompatible hardware.</strong> TerraLync Lite needs an ' +
            'ESP32-S3 with ≥8 MB flash and ≥2 MB PSRAM (detected: ' + res.chip + ', ' +
            res.flashMB + ' MB flash, ' + res.psramMB + ' MB PSRAM).';
        ui.connectStatus.textContent = 'Incompatible device.';
        return;
    }

    const geek = vid === ESPRESSIF_VID && pid === ESP32S3_USB_SERIAL_JTAG_PID && res.flashMB >= 16 && res.psramMB === 2;
    const guition = vid === CH340_VID && pid === CH340_PID && res.flashMB >= 16 && res.psramMB >= 8;
    detectedTier = geek ? 'geek-16mb' : guition ? 'guition-16mb' : (res.flashMB >= 16 ? '16mb' : '8mb');

    show(ui.gateOk); hide(ui.gateBad);
    ui.detectedBoard.textContent = BOARD_LABELS[detectedTier] +
        ' (' + res.flashMB + ' MB flash · ' + res.psramMB + ' MB PSRAM)';
    setBoardArt(detectedTier);
    ui.selTier.value = 'auto';
    logOk('Compatible: ' + BOARD_LABELS[detectedTier]);

    try { await loadAssets(); } catch (e) { logErr('Could not load firmware manifest: ' + e.message); }
    ui.cardInstall.classList.add('show');
    setStep(2);
    ui.connectStatus.textContent = 'Connected — ready to flash.';
    ui.btnFlash.disabled = false;
}

async function onConnectClick() {
    if (busy) return;
    flashedDone = false;                    // explicit Connect = intent to flash again
    ui.btnConnect.disabled = true;
    ui.connectStatus.textContent = 'Choose your device in the picker…';
    let picked;
    try {
        picked = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    } catch (e) {
        ui.connectStatus.textContent = 'No device selected.';
        ui.btnConnect.disabled = false;
        return;
    }
    busy = true;
    try { await probeAndGate(picked); }
    finally { busy = false; ui.btnConnect.disabled = false; }
}

// ---- Flash ------------------------------------------------------------------
// Connected baud the live loader was opened at (probe + any retry).
let connectedBaud = 0;
// Set after a successful flash — suppresses the auto-reprobe on 'connect',
// so a board resetting into the app (or a replug) isn't mistaken for a new
// bootloader device.
let flashedDone = false;
// Progress-bar phases: 0-10 downloads/erase, 10-92 writes, 92-100 verify+reset.
const WRITE_PCT_START = 10, WRITE_PCT_END = 92;

async function ensureLoader() {
    if (loader) return true;
    if (!port) return false;
    await probeAndGate(port);               // silent re-probe on the granted port
    return !!loader;
}

async function openLoader(baud) {
    await teardownLoader();
    transport = new Transport(port, false);
    loader = new ESPLoader({
        transport, baudrate: baud, romBaudrate: 115200, terminal, enableTracing: false,
    });
    await loader.main();
    connectedBaud = baud;
}

// One writeFlash call, with the .exe's 460800→115200 auto-retry.
async function writeWithFallback(fileArray) {
    const opts = {
        fileArray,
        flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
        eraseAll: false, compress: true,
        calculateMD5Hash: (img) => md5Hex(img),   // real on-device verify
        reportProgress: (i, written, total) => {
            // reportProgress counts COMPRESSED bytes per file, which bear no
            // fixed relation to uncompressed sizes — so give each file a fixed
            // span of the write phase rather than byte-proportional math.
            const span = (WRITE_PCT_END - WRITE_PCT_START) / fileArray.length;
            const pct = WRITE_PCT_START + i * span + (written / total) * span;
            setProgress('Writing ' + fileArray[i].label + ' @ ' + hex(fileArray[i].address), pct);
        },
    };
    try {
        await loader.writeFlash(opts);
    } catch (e) {
        if (connectedBaud <= 115200) throw e;
        logWarn('Write failed at ' + connectedBaud + ' baud — retrying at 115200 (slower, more reliable)…');
        await openLoader(115200);           // reconnect at safe baud; chip already erased
        await loader.writeFlash(opts);
    }
    logOk('Every image verified against the ROM flash_md5sum.');
}

async function doFlash() {
    if (busy) return;
    if (!(await ensureLoader())) return;
    const tier = ui.selTier.value === 'auto' ? detectedTier : ui.selTier.value;
    const t = (await loadAssets()).tiers[tier];
    if (!t) { logErr('No images published for tier ' + tier); return; }
    const appOnly = ui.chkAppOnly.checked;

    busy = true;
    ui.btnFlash.disabled = true; ui.btnConnect.disabled = true;
    setProgress('Downloading & verifying images…', 2);
    ui.progFill.classList.add('indeterminate');
    try {
        log('Tier: ' + tier + ' — ' + t.label + (appOnly ? ' (app filesystem only)' : ''));
        const fw = appOnly ? null : await fetchVerified(t.firmware.file, t.firmware.sha256);
        const fs = await fetchVerified(t.fs.file, t.fs.sha256);
        ui.progFill.classList.remove('indeterminate');

        const files = appOnly
            ? [{ data: fs, address: parseInt(t.fs.offset, 16), label: 'filesystem' }]
            : [{ data: fw, address: parseInt(t.firmware.offset, 16), label: 'firmware' },
               { data: fs, address: parseInt(t.fs.offset, 16), label: 'filesystem' }];

        if (!appOnly) {
            // Full install = full-chip erase first, same as the .exe — wipes
            // stale NVS/WiFi/OTA state outside the two written regions.
            setProgress('Erasing flash (can take ~30 s)…', 8);
            ui.progFill.classList.add('indeterminate');
            ui.flashStatus.textContent = 'Erasing device…';
            log('Erasing entire flash…');
            await loader.eraseFlash();
            ui.progFill.classList.remove('indeterminate');
            setProgress('Erase complete', 10);
        }

        ui.flashStatus.textContent = 'Writing ' + (BOARD_LABELS[tier] || tier) + '…';
        await writeWithFallback(files);
        // md5 readback already ran per-image inside writeFlash — label past tense
        setProgress('All images written & verified', 96);
        logOk(appOnly ? 'Filesystem written.' : 'Flash complete. Firmware + filesystem written.');

        // --after hard_reset: pulse EN (RTS) low with IO0 high so the board
        // boots the app — this is what esptool's hard_reset does. esptool-js's
        // own HardReset class only *deasserts* RTS (never asserts it first),
        // which is a no-op and left the chip sitting in the stub.
        if (tier !== 'geek-16mb') {
            try {
                await transport.setSignals(false, true);      // RTS asserted → EN low, IO0 high
                await new Promise((r) => setTimeout(r, 200));
                await transport.setSignals(false, false);     // EN released → boots into app
                logDim('Reset pulse sent — board should reboot into TerraLync Lite.');
            } catch (e) {
                logWarn('Auto-reset failed — unplug and replug the board.');
            }
        }
        await teardownLoader();
        setProgress('Done', 100);

        flashedDone = true;
        ui.donePower.textContent = tier === 'geek-16mb'
            ? 'Unplug the USB cable and plug it back in — the ESP32-S3-GEEK has no reset button, a power cycle is required.'
            : 'The board was reset automatically — give it ~10 seconds to boot. (If nothing appears after ~20 s, unplug it and plug it back in.)';
        ui.cardDone.classList.add('show');
        setStep(3);
        ui.flashStatus.textContent = tier === 'geek-16mb'
            ? 'Done — power-cycle the board.'
            : 'Done — board is rebooting.';
        logOk('Reboot ' + (BOARD_LABELS[tier] || tier) + ' into TerraLync Lite.');
    } catch (e) {
        logErr('Flash failed: ' + friendlyError(e));
        setProgress('Failed', 0);
        ui.flashStatus.textContent = 'Flash failed — see log.';
        await teardownLoader();
    } finally {
        busy = false;
        ui.btnFlash.disabled = false; ui.btnConnect.disabled = false;
    }
}

// ---- Helpers ------------------------------------------------------------------
async function teardownLoader() {
    try { if (transport) await transport.disconnect(); } catch (e) {}
    transport = null; loader = null;
}
function friendlyError(e) {
    const s = (e && (e.message || e.toString())) || 'unknown error';
    if (/failed to connect|timeout/i.test(s)) return 'timed out waiting for the bootloader';
    if (/networkerror|device.*(lost|disconnect)/i.test(s)) return 'device disconnected';
    return s;
}
const hex = (n) => '0x' + n.toString(16);
const hex4 = (n) => n == null ? '—' : n.toString(16).toUpperCase().padStart(4, '0');

// ---- Wire-up -------------------------------------------------------------------
(function init() {
    if (!('serial' in navigator)) {
        show(ui.unsupported);
        ui.btnConnect.disabled = true;
        ui.connectStatus.textContent = 'Web Serial unavailable in this browser.';
        logWarn('Web Serial API not available — use Chrome, Edge, Brave or Opera.');
        return;
    }
    setStep(1);
    ui.btnConnect.addEventListener('click', onConnectClick);
    ui.btnFlash.addEventListener('click', doFlash);
    ui.selTier.addEventListener('change', () => {
        const tier = ui.selTier.value === 'auto' ? detectedTier : ui.selTier.value;
        if (tier) setBoardArt(tier);
        if (ui.selTier.value !== 'auto' && detectedTier)
            log('Tier override → ' + (BOARD_LABELS[tier] || tier), 'lg-warn');
    });

    // A previously-granted device plugging in (e.g. a GEEK replugged in boot
    // mode after we asked for it once) gets probed automatically.
    navigator.serial.addEventListener('connect', async (e) => {
        if (busy || loader || flashedDone) return;
        const info = (e.target.getInfo && e.target.getInfo()) || {};
        if (info.usbVendorId === GEEK_RUNTIME_VID) return;
        logDim('Device plugged in — probing…');
        busy = true; ui.btnConnect.disabled = true;
        try { await probeAndGate(e.target); }
        finally { busy = false; ui.btnConnect.disabled = false; }
    });
    navigator.serial.addEventListener('disconnect', (e) => {
        if (port && e.target === port && !flashedDone) {
            logWarn('Device disconnected.');
            if (!busy) ui.flashStatus.textContent = 'Device disconnected.';
        }
    });
    loadAssets().catch(() => {});
})();
