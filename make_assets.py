#!/usr/bin/env python3
"""Regenerate assets.json for the web flasher from a firmware/ directory.

Run after staging release binaries into ./firmware (e.g. via
`gh release download` in CI). Produces the tier map the page flashes:

    tier        firmware image                  fs image
    8mb         terralync-s3-8mb.bin            fs-{app}-8mb
    16mb        terralync-s3-16mb.bin           fs-{app}-16mb
    geek-16mb   terralync-geek-16mb.bin         fs-{app}-16mb   (shares generic fs)
    guition-16mb terralync-guition-16mb.bin     fs-{app}-guition-16mb

Usage:
    python make_assets.py --firmware-version 2.6.3 --app-version 2.6.5
"""
import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FW_DIR = os.path.join(HERE, "firmware")

TIERS = {
    "8mb":          ("terralync-s3-8mb.bin",      "terralync-lite-fs-{app}-8mb.bin",          "0x420000", "Generic ESP32-S3 — 8 MB"),
    "16mb":         ("terralync-s3-16mb.bin",     "terralync-lite-fs-{app}-16mb.bin",         "0x620000", "Generic ESP32-S3 — 16 MB"),
    "geek-16mb":    ("terralync-geek-16mb.bin",   "terralync-lite-fs-{app}-16mb.bin",         "0x620000", "Waveshare ESP32-S3-GEEK — 16 MB"),
    "guition-16mb": ("terralync-guition-16mb.bin","terralync-lite-fs-{app}-guition-16mb.bin", "0x620000", "Guition ESP32-4848S040 — 16 MB"),
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--firmware-version", required=True, help="e.g. 2.6.3 (from firmware-vX.Y.Z)")
    ap.add_argument("--app-version", required=True, help="e.g. 2.6.5 (from app-vX.Y.Z)")
    ap.add_argument("--channel", default="stable")
    args = ap.parse_args()

    out = {"firmware_version": args.firmware_version,
           "app_version": args.app_version,
           "channel": args.channel,
           "tiers": {}}
    missing = []
    for tier, (fw_name, fs_tpl, fs_off, label) in TIERS.items():
        fs_name = fs_tpl.format(app=args.app_version)
        fw_path, fs_path = os.path.join(FW_DIR, fw_name), os.path.join(FW_DIR, fs_name)
        for p in (fw_path, fs_path):
            if not os.path.exists(p):
                missing.append(os.path.basename(p))
        if missing:
            continue
        out["tiers"][tier] = {
            "label": label,
            "firmware": {"file": "firmware/" + fw_name, "sha256": sha256(fw_path),
                         "size": os.path.getsize(fw_path), "offset": "0x0"},
            "fs":       {"file": "firmware/" + fs_name, "sha256": sha256(fs_path),
                         "size": os.path.getsize(fs_path), "offset": fs_off},
        }
    if missing:
        print("MISSING (tier skipped): " + ", ".join(sorted(set(missing))), file=sys.stderr)
    if not out["tiers"]:
        print("ERROR: no complete tiers found in", FW_DIR, file=sys.stderr)
        sys.exit(1)

    dest = os.path.join(HERE, "assets.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print("wrote", dest, "for", ", ".join(out["tiers"]))


if __name__ == "__main__":
    main()
