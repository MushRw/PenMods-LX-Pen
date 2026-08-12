#!/usr/bin/env python3
"""打包插件目录为 zip（根目录 lx-pen/）。Usage: python3 scripts/package.py"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "plugin")
OUT = os.path.join(ROOT, "lx-pen.zip")

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _dirs, files in os.walk(PLUGIN):
        for f in files:
            full = os.path.join(base, f)
            rel = os.path.relpath(full, PLUGIN)
            z.write(full, os.path.join("lx-pen", rel))

print("packed:", OUT)
