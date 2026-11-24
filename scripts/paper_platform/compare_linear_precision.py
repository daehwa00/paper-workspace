"""Compare source RGB samples to rendered DOM styles, not whole-page similarity."""
from collections import Counter
import json
from pathlib import Path
import re
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / '.omx/artifacts/linear-refresh/precision'
REF = ROOT / '.omx/artifacts/linear-refresh/attached-reference/reference/screenshots'
OUT = ROOT / 'docs/paper-platform/design-refresh/precision'
OUT.mkdir(parents=True, exist_ok=True)
actual = json.loads((ART / 'rendered-metrics.json').read_text())
# Source image pixels, not claimed Linear CSS tokens. Text masks exclude background/AA.
samples = [
 ('nav-background','01-sidebar.png',(1560,600,2330,680),0),
 ('work-surface','02-top-tabs.png',(150,1400,1900,1600),0),
 ('nav-selected','01-sidebar.png',(1560,710,2340,805),0),
 ('nav-selected-text','01-sidebar.png',(1670,710,2130,810),170),
 ('nav-muted','01-sidebar.png',(1670,832,2170,945),70),
 ('tab-selected','02-top-tabs.png',(850,1150,1450,1250),0),
 ('tab-selected-text','02-top-tabs.png',(995,1155,1410,1250),170),
 ('tab-idle','02-top-tabs.png',(160,1150,300,1250),0),
 ('primary-fill','05-create-issue.png',(1040,430,1041,431),0),
 ('primary-border','05-create-issue.png',(1040,419,1041,420),0),
 ('overlay-fill','07-view-options.png',(550,130,1050,900),0),
 ('overlay-border','07-view-options.png',(547,200,548,201),0),
 ('dialog-title','05-create-issue.png',(83,125,650,155),170),
 ('select-fill','07-view-options.png',(825,263,1027,304),0),
 ('select-border','07-view-options.png',(821,280,822,281),0),
 ('select-text','07-view-options.png',(832,270,934,296),170),
 ('secondary-text','05-create-issue.png',(930,70,1050,95),170),
 ('switch-on','07-view-options.png',(995,478,996,479),0),
 ('switch-thumb','07-view-options.png',(1007,470,1025,489),200),
 ('switch-caption','07-view-options.png',(578,465,960,495),70),
 ('switch-off','07-view-options.png',(1018,395,1019,396),0),
]
rows = []
for key, filename, box, minimum in samples:
    image = Image.open(REF / filename).convert('RGB').crop(box)
    raw = image.tobytes()
    colors = [tuple(raw[i:i+3]) for i in range(0, len(raw), 3)]
    if minimum:
        colors = [c for c in colors if min(c) > minimum and max(c)-min(c) < 18]
    reference, frequency = Counter(colors).most_common(1)[0]
    observed = tuple(map(int, re.findall(r'[\d.]+', actual['values'][key]['value'])[:3]))
    rows.append(dict(role=key,source=filename,box=box,reference_rgb=reference,frequency=frequency,rendered_rgb=observed,absolute_rgb_difference=[abs(a-b) for a,b in zip(reference,observed)]))
report = {'method':'Source raster sample vs real DOM computed style. Not a design similarity score.',
          'viewport':actual['viewport'],'samples':rows,
          'exact_rgb_matches':sum(not any(r['absolute_rgb_difference']) for r in rows),
          'sample_count':len(rows),
          'limits':['05 and 07 have no production date; component-only supplementary evidence.',
                    'Raster DPR/zoom unknown. Color agreement does not prove geometry, type or interaction identity.']}
(OUT / 'color-measurements.json').write_text(json.dumps(report,indent=2))
board = Image.new('RGB',(900,44+len(rows)*34),'#101113')
draw = ImageDraw.Draw(board)
draw.text((12,12),'Measured source RGB / Rendered DOM RGB (color samples only)',fill='#eee')
for i,row in enumerate(rows):
    y=44+i*34
    draw.text((12,y+8),row['role'],fill='#ddd')
    for x,color in [(240,row['reference_rgb']),(380,row['rendered_rgb'])]:
        draw.rectangle((x,y+3,x+40,y+26),fill=tuple(color),outline='#666')
        draw.text((x+48,y+8),'#'+''.join(f'{c:02x}' for c in color),fill='#bbb')
    draw.text((570,y+8),'channel delta: '+str(row['absolute_rgb_difference']),fill='#aaa')
board.save(OUT / 'color-comparison.png')
# Component crops are normalized by height; text/width differences are product content.
comparisons=[('App tab','02-top-tabs.png',(812,1128,1532,1296),'tab-native.png'),
             ('Primary','05-create-issue.png',(1010,419,1161,461),'primary-native.png'),
             ('Select','07-view-options.png',(821,262,1028,304),'select-native.png'),
             ('Switch on','07-view-options.png',(989,467,1027,491),'switch-on-native.png'),
             ('Switch off','07-view-options.png',(989,383,1027,407),'switch-off-native.png')]
board=Image.new('RGB',(900,368),'#080808');draw=ImageDraw.Draw(board)
draw.text((12,10),'Linear raster (height normalized)                 Paper native DOM / DPR 1',fill='#ccc')
for i,(label,filename,box,native) in enumerate(comparisons):
    ref=Image.open(REF/filename).convert('RGB').crop(box)
    rendered=Image.open(ART/native).convert('RGB')
    ref=ref.resize((round(ref.width*rendered.height/ref.height),rendered.height),Image.Resampling.LANCZOS)
    y=42+i*64;draw.text((12,y+8),label,fill='#ccc');board.paste(ref,(100,y));board.paste(rendered,(450,y))
board.save(OUT/'component-comparison.png')
print(f"Exact RGB sample matches: {report['exact_rgb_matches']}/{len(rows)} (not visual similarity)")

# The light references are undated component crops, not the 2026 whole-app frame.
light = json.loads((ART / 'light-rendered-metrics.json').read_text())
light_sources = [
 ('menu-surface','10-autocomplete.png',(1100,600)),
 ('menu-border','10-autocomplete.png',(1100,249)),
 ('menu-text','10-autocomplete.png',(479,492)),
 ('menu-selected','10-autocomplete.png',(1100,480)),
 ('toolbar-surface','11-editor-toolbar.png',(450,220)),
 ('toolbar-border','11-editor-toolbar.png',(450,211)),
 ('toolbar-icon','11-editor-toolbar.png',(338,249)),
]
light_rows=[]
for role, filename, point in light_sources:
    expected=Image.open(REF/filename).convert('RGB').getpixel(point)
    observed=tuple(map(int,re.findall(r'[\d.]+',light['values'][role])[:3]))
    light_rows.append(dict(role=role,source=filename,point=point,reference_rgb=expected,rendered_rgb=observed,absolute_rgb_difference=[abs(a-b)for a,b in zip(expected,observed)]))
light_report={'method':report['method'],'viewport':light['viewport'],'samples':light_rows,'exact_rgb_matches':sum(not any(r['absolute_rgb_difference'])for r in light_rows),'sample_count':len(light_rows),'limits':['Undated source 10/11 component-only evidence; not the 2026 light app frame.']}
(OUT/'light-color-measurements.json').write_text(json.dumps(light_report,indent=2))
combined={'dark_matches':report['exact_rgb_matches'],'dark_samples':len(rows),'light_matches':light_report['exact_rgb_matches'],'light_samples':len(light_rows),'interpretation':'Matching these RGB role/state samples is not a whole-app visual similarity percentage.'}
(OUT/'color-summary.json').write_text(json.dumps(combined,indent=2))
board=Image.new('RGB',(900,44+len(light_rows)*34),'#f5f5f5');draw=ImageDraw.Draw(board)
draw.text((12,12),'Light: measured source RGB / rendered DOM RGB (component samples only)',fill='#27272a')
for i,row in enumerate(light_rows):
    y=44+i*34;draw.text((12,y+8),row['role'],fill='#27272a')
    for x,color in [(240,row['reference_rgb']),(380,row['rendered_rgb'])]:
        draw.rectangle((x,y+3,x+40,y+26),fill=tuple(color),outline='#aaa');draw.text((x+48,y+8),'#'+''.join(f'{c:02x}'for c in color),fill='#626269')
    draw.text((570,y+8),'channel delta: '+str(row['absolute_rgb_difference']),fill='#626269')
board.save(OUT/'light-color-comparison.png')
print(f"Light exact RGB sample matches: {light_report['exact_rgb_matches']}/{len(light_rows)} (not visual similarity)")
