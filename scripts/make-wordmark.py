#!/usr/bin/env python3
"""Draws the Office Lite wordmark as an Android VectorDrawable.

Why this exists
---------------
The wordmark uses a geometric sans:

    .wordmark { font-family: var(--geo); font-weight: 700; letter-spacing: -0.035em; }
    --geo: Futura, "Century Gothic", "Avenir Next", Avenir, "Trebuchet MS", sans-serif;

Not one of those five ships on Android. The stack falls through to `sans-serif`, which is
Roboto, so every phone visitor to the site has been reading the wordmark in Roboto and the
app inherited the same silent fallback. It has only ever looked like Futura on a Mac.

Fixing that in the app means either shipping a font or shipping the letters. Eleven glyphs used
in exactly one place do not need a font: the drawable is about 4 kB of path data on disk and
compresses to under 2 kB in the APK, against 3.7 MB for the whole thing. It renders
identically on every device, and it cannot fall back to something else without anyone
noticing, which is the failure being fixed.

The trade is that a drawable is a picture. It carries a contentDescription rather than being
read as text, and it does not grow when someone raises their system font size. That was a
deliberate call; a subset font in res/font/ is the alternative if it ever needs to scale.

Why Jost and not Futura
-----------------------
Futura is on this Mac, and it is licensed by Apple and Paratype. Its outlines cannot be
extracted into a mark that ships inside an APK. Jost is Owen Earl's Futura revival, released
under the SIL Open Font Licence, and it is what the mockups were drawn in.

The SIL OFL FAQ treats outlines extracted into a logo as artwork rather than font software,
which is why no entry is added to assets/licences.md for it. Worth reading the FAQ yourself
before a release rather than taking that on trust.

Usage
-----
    curl -L -o Jost.ttf \\
      'https://github.com/google/fonts/raw/main/ofl/jost/Jost%5Bwght%5D.ttf'
    python3 scripts/make-wordmark.py Jost.ttf

Writes app/src/main/res/drawable/ic_wordmark.xml. The font itself is not committed: it is
only ever needed to regenerate the drawable.
"""
import os
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WORD = "Office Lite"

# docs/index.html:264-266. The site sets the wordmark at weight 700 and tracks it in, and
# both have to come across or it is a different mark.
WEIGHT = 700
TRACKING_EM = -0.035

# Cap height in dp for the drawable. A MaterialToolbar title is 22sp of Roboto, whose caps
# measure about 0.72 of that, so 16dp sits the wordmark at the height the text title had.
CAP_HEIGHT_DP = 16.0

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "app", "src", "main", "res", "drawable", "ic_wordmark.xml")


def kern_pairs(font, glyphs):
    """GPOS kerning for consecutive pairs of [glyphs], in font units.

    Only what this wordmark needs: the horizontal advance adjustment from the `kern`
    feature's PairPos lookups, formats 1 and 2. Anything it cannot read comes back as zero,
    which is the right failure: the tracking above is an order of magnitude larger than any
    kern in a geometric sans, so a missed pair is a fraction of a device pixel rather than a
    broken mark.
    """
    adjust = {}
    if "GPOS" not in font:
        return adjust
    gpos = font["GPOS"].table
    wanted = {i for i, rec in enumerate(gpos.FeatureList.FeatureRecord)
              if rec.FeatureTag == "kern"}
    lookups = set()
    for i in wanted:
        lookups.update(gpos.FeatureList.FeatureRecord[i].Feature.LookupListIndex)

    pairs = list(zip(glyphs, glyphs[1:]))
    for li in sorted(lookups):
        lookup = gpos.LookupList.Lookup[li]
        if lookup.LookupType != 2:
            continue
        for sub in lookup.SubTable:
            for left, right in pairs:
                if (left, right) in adjust:
                    continue
                value = _pair_value(sub, left, right)
                if value:
                    adjust[(left, right)] = value
    return adjust


def _pair_value(sub, left, right):
    coverage = getattr(sub, "Coverage", None)
    if coverage is None or left not in coverage.glyphs:
        return 0
    index = coverage.glyphs.index(left)

    if sub.Format == 1:
        for record in sub.PairSet[index].PairValueRecord:
            if record.SecondGlyph == right:
                return getattr(record.Value1, "XAdvance", 0) or 0
        return 0

    if sub.Format == 2:
        c1 = sub.ClassDef1.classDefs.get(left, 0)
        c2 = sub.ClassDef2.classDefs.get(right, 0)
        try:
            record = sub.Class1Record[c1].Class2Record[c2]
        except (IndexError, AttributeError):
            return 0
        return getattr(record.Value1, "XAdvance", 0) or 0

    return 0


def main(font_path):
    font = TTFont(font_path)

    # Jost ships as a variable font on a single weight axis. Pin it before reading outlines,
    # or every glyph comes out at the 400 default.
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": WEIGHT})

    upem = font["head"].unitsPerEm
    cap = font["OS/2"].sCapHeight
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    names = [cmap[ord(ch)] for ch in WORD]

    tracking = TRACKING_EM * upem
    kerns = kern_pairs(font, names)

    # Where each glyph starts, once its predecessor's advance, the pair kern and the site's
    # tracking have all been applied.
    origins = []
    pen_x = 0.0
    for i, name in enumerate(names):
        origins.append(pen_x)
        pen_x += glyph_set[name].width
        if i + 1 < len(names):
            pen_x += kerns.get((name, names[i + 1]), 0) + tracking

    # Pass one: the ink bounds of the whole word, so the viewport is the mark and not the
    # em box it happens to sit in.
    bounds = BoundsPen(glyph_set)
    for name, x in zip(names, origins):
        glyph_set[name].draw(TransformPen(bounds, Transform(1, 0, 0, 1, x, 0)))
    min_x, min_y, max_x, max_y = bounds.bounds

    width = max_x - min_x
    height = max_y - min_y

    # Pass two, with the viewport known. Font units are Y up from the baseline and a
    # VectorDrawable viewport is Y down from the top corner, so the same transform that
    # moves the ink to the origin also flips it: (x, y) -> (x - min_x, max_y - y).
    pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    for name, x in zip(names, origins):
        glyph_set[name].draw(TransformPen(pen, Transform(1, 0, 0, -1, x - min_x, max_y)))
    path = pen.getCommands()

    # Sized on the cap height rather than the em, so it matches the text title it replaces
    # rather than a box nobody can see. 'd' rises above the caps, so the drawable is taller.
    height_dp = CAP_HEIGHT_DP * height / cap
    width_dp = height_dp * width / height

    xml = f'''<?xml version="1.0" encoding="utf-8"?>
<!-- The Office Lite wordmark. Generated by scripts/make-wordmark.py from Jost Bold; edit that
     rather than this. "{WORD}" at weight {WEIGHT} and {TRACKING_EM}em of tracking, which is what
     docs/index.html has always asked for and Android has never had a face to answer with.

     Filled white and tinted at the view, because a ?attr colour resolved inside vector XML
     depends on which inflation path got there first. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{width_dp:.1f}dp"
    android:height="{height_dp:.1f}dp"
    android:viewportWidth="{width:.1f}"
    android:viewportHeight="{height:.1f}">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="{path}" />
</vector>
'''

    with open(OUT, "w") as handle:
        handle.write(xml)

    print(f"upem {upem}, cap height {cap}, tracking {tracking:.1f} units")
    print(f"kerned pairs: {kerns or 'none'}")
    print(f"ink {width:.0f} x {height:.0f} units -> {width_dp:.1f} x {height_dp:.1f} dp")
    print(f"wrote {os.path.relpath(OUT, REPO)} ({len(xml)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: make-wordmark.py <path to Jost variable TTF>")
    main(sys.argv[1])
