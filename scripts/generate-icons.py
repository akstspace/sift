#!/usr/bin/env python3
"""Freeze the pinned Tabler catalog and sanitized offline SVG sprite. No network."""
import argparse
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web/node_modules/@tabler/icons"
VERSION = "3.50.0"


def generate():
    assert json.loads((SOURCE / "package.json").read_text())["version"] == VERSION
    metadata = json.loads((SOURCE / "icons.json").read_text())
    catalog = []
    symbols = []
    symbol_ids = set()
    allowed_tags = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g"}
    allowed_attrs = {"d", "cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "opacity", "transform"}
    for style in ("outline", "filled"):
        nodes = json.loads((SOURCE / f"tabler-nodes-{style}.json").read_text())
        for source in sorted((SOURCE / "icons" / style).glob("*.svg")):
            name = source.stem
            key = name + ("-filled" if style == "filled" else "")
            icon = metadata[name]
            catalog.append(dict(id=key, name=name.replace("-", " ").title() + (" Filled" if style == "filled" else ""), category=icon["category"], aliases=icon["tags"] + [style], symbol="ti-" + key))
            # Consume the package's primitive JSON nodes, not an XML parser or
            # raw SVG markup. Only fixed tags/attributes and escaped data ship.
            shapes = []
            for tag, attrs in nodes[name]:
                assert tag in allowed_tags, (source, tag)
                assert set(attrs) <= allowed_attrs, (source, attrs)
                assert all(isinstance(v, str) and "url(" not in v.lower() for v in attrs.values()), source
                attributes = " ".join(f'{k}="{escape(v, quote=True)}"' for k, v in attrs.items())
                shapes.append(f"<{tag} {attributes}/>")
            fill, stroke = ("currentColor", "none") if style == "filled" else ("none", "currentColor")
            assert "ti-" + key not in symbol_ids
            symbol_ids.add("ti-" + key)
            symbols.append(f'<symbol id="ti-{key}" viewBox="0 0 24 24" fill="{fill}" stroke="{stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + "".join(shapes) + "</symbol>")
    ids = [i["id"] for i in catalog]
    assert len(ids) == len(set(ids)) and len(symbol_ids) == len(symbols)
    assert all(i["symbol"] in symbol_ids for i in catalog)
    return {
        ROOT / "internal/sift/icon-catalog.json": json.dumps(catalog, separators=(",", ":"), ensure_ascii=True) + "\n",
        ROOT / "web/public/tabler-icons.svg": '<svg xmlns="http://www.w3.org/2000/svg"><!-- Tabler Icons ' + VERSION + '; MIT; Copyright (c) 2020-2026 Paweł Kuna. See licenses/npm/@tabler__icons/LICENSE. -->' + "".join(symbols) + "</svg>\n",
    }, len(symbols), len(catalog)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files, symbols, count = generate()
    for path, content in files.items():
        if args.check:
            if not path.is_file() or path.read_text() != content:
                raise SystemExit(f"Stale icon asset: {path.relative_to(ROOT)}")
        else:
            path.write_text(content)
    print(f"Verified Tabler {VERSION}: {symbols} offline icons, {count} native catalog IDs.")
