"""Compare corresponding frame crops at native CSS-pixel scale, not page similarity."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[2]
artifacts = root / 'docs/paper-platform/design-refresh/live-frame'
before = json.loads((artifacts / 'before/measurements.json').read_text())
after = json.loads((artifacts / 'after/measurements.json').read_text())
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
poster = Image.new('RGB', (1340, 510), '#dedee1')
draw = ImageDraw.Draw(poster)
columns = ['Public Linear demo', 'Paper before this refinement', 'Paper after this refinement']
for index, label in enumerate(columns):
    draw.text((16 + index*444, 12), label, fill='#18181b', font=font)
comparisons = []
for section, theme in enumerate(['light', 'dark']):
    y = 48 + section*224
    draw.text((16,y), theme + ' / native 1 CSS px; content labels differ', fill='#18181b',font=font)
    reference = json.loads((artifacts / f'reference/linear-demo-{theme}-1600.json').read_text())
    main = next(r for r in reference['regions'] if r['tag'] == 'MAIN')
    source_nav = reference['ancestors'][0]
    sources = [(artifacts / f'reference/linear-demo-{theme}-1600.png', main['x'], source_nav)]
    states = []
    for phase, rows in [('before', before), ('after', after)]:
        row = next(r for r in rows if (r['theme'],r['width'],r['locale'],r['surface']) == (theme,1600,'en','writing'))
        sources.append((artifacts / f'{phase}/{theme}-1600-en-writing.png', row['elements']['main']['x'],row['elements']['nav']))
        states.append(row)
    for index, (path, frame_x, nav) in enumerate(sources):
        screenshot = Image.open(path).convert('RGB')
        x = 16+index*444
        poster.paste(screenshot.crop((int(frame_x)-8,0,int(frame_x)+420,112)), (x,y+26))
        poster.paste(screenshot.crop((int(nav['x'])-4,int(nav['y'])-4,int(nav['x'])+224,int(nav['y'])+36)), (x,y+150))
    comparisons.append({
        'theme':theme,
        'viewport':reference['viewport'],
        'public_reference':{'navHeight':source_nav['height'],'navRadius':source_nav['radius'],'frameRadius':main['radius'],'headingCenterY':reference['headingAncestors'][0]['y']+reference['headingAncestors'][0]['height']/2},
        'paper':[{ 'phase':phase, 'navHeight':row['elements']['nav']['height'], 'navRadius':row['elements']['nav']['radius'], 'frameRadius':row['headerSurface']['radius'], 'titleCenterY':row['elements']['title']['y']+row['elements']['title']['height']/2 } for phase,row in zip(['before','after'],states)],
    })
draw.text((16,494),'No scaling, recoloring or whole-page similarity score. Palette follows the supplied attachment.',fill='#18181b',font=font)
poster.save(artifacts / 'frame-comparison.png')
report = {
    'comparison':'Native crops of 1600x1000 captures at DPR 1 and scale 1; font loading completed and motion reduced.',
    'comparisons':comparisons,
    'captureMatrix':{'states':len(after),'overflowCount':sum(row['overflow']>0 for row in after),'languageMismatchCount':sum(row.get('language')!=row['locale'] for row in after)},
    'remainingDifferences':[
        'Public demo build is not proven identical to the March attachment. Attachment colors take priority over its differing theme.',
        'Paper retains a resizable 224px sidebar default; public demo sidebar is 244px. Saved sidebar widths are preserved.',
        'Paper title center y=30 differs by 0.5px from demo heading center y=30.5 due to the demo bordered header and Paper editable title geometry.',
        'Paper keeps product-specific manuscript/review modes, source/PDF/tool panels, titles, content and mobile 44px targets.',
        'Reference setup/empty content is not evidence for issue-list behavior or unobserved overlays and interactive states.',
    ],
}
(artifacts / 'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report['captureMatrix']))
