"""Create labeled screenshot comparisons; never calculate whole-page similarity.

Usage: python3 scripts/paper_platform/compare_linear_reference.py
Requires the supplied ZIP extracted to .omx/artifacts/linear-refresh/attached-reference/reference.
Run the reference-controls browser spec before this script. Output is documentation PNGs.
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / '.omx/artifacts/linear-refresh/attached-reference'
OUTPUT = ROOT / 'docs/paper-platform/design-refresh/attached-reference'
OUTPUT.mkdir(parents=True, exist_ok=True)

for screen in ('workspace', 'rebuttal'):
    images = [Image.open(OUTPUT / f'{screen}-{phase}.png').convert('RGB') for phase in ('before', 'after')]
    # Same 1600px browser width; presentation copies alone are scaled to 800px.
    sizes = [(800, round(im.height * 800 / im.width)) for im in images]
    board = Image.new('RGB', (1616, max(h for _, h in sizes) + 40), '#f5f5f5')
    draw = ImageDraw.Draw(board)
    for i, (im, size, label) in enumerate(zip(images, sizes, ('Before this attachment audit', 'After this attachment audit'))):
        draw.text((i * 816 + 8, 12), label, fill='#27272a')
        board.paste(im.resize(size, Image.Resampling.LANCZOS), (i * 816, 40))
    board.save(OUTPUT / f'{screen}-comparison.png')

reference = Image.open(ARTIFACTS / 'reference/screenshots/02-top-tabs.png').convert('RGB')
box = (812, 1128, 1536, 1296)
reference = reference.crop(box)
reference.save(OUTPUT / 'reference-tab-original.png')
actual = Image.open(ARTIFACTS / 'selected-tab-dark.png').convert('RGB')
normalized = reference.resize((round(reference.width * actual.height / reference.height), actual.height), Image.Resampling.LANCZOS)
board = Image.new('RGB', (640, 130), '#080808')
draw = ImageDraw.Draw(board)
draw.text((12, 8), 'Linear 02: normalized raster height (original DPR unknown)', fill='#ccc')
board.paste(normalized, (12, 30))
draw.text((12, 70), 'Paper: native browser crop, DPR 1 / 100% zoom', fill='#ccc')
board.paste(actual, (12, 92))
board.save(OUTPUT / 'selected-tab-comparison.png')
# A color diagnostic only: flat interiors, excluding text, edges and shadows.
reference_rgb = Image.open(ARTIFACTS / 'reference/screenshots/02-top-tabs.png').convert('RGB').getpixel((900, 1160))
actual_rgb = actual.getpixel((actual.width - 10, 8))
(OUTPUT / 'tab-color-diagnostic.json').write_text(json.dumps({
    'reference_coordinate_original_px': [900, 1160],
    'reference_rgb': reference_rgb, 'paper_rgb': actual_rgb,
    'absolute_channel_difference': [abs(a-b) for a, b in zip(reference_rgb, actual_rgb)],
    'limitation': 'Flat background color only. Not a visual similarity score. Font, text width and original DPR differ.'
}, indent=2))
