"""Render the actual gate template for isolated visual tests; no credentials or users."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / 'apps/paper_workspace/password_gate'
os.environ['PAPER_FAVICON_PATH'] = str(ROOT / 'apps/paper_workspace/static/assets/favicon-64.png')
sys.path.insert(0, str(GATE))

def render(phase='after'):
    source = GATE / 'server.py' if phase == 'after' else ROOT / '.omx/artifacts/linear-refresh/remaining-login/before/server.py'
    spec = importlib.util.spec_from_file_location('auth_visual_gate_' + phase, source)
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    if phase == 'before':
        theme = (ROOT / 'apps/paper_workspace/static/theme.css').read_text()
        css = (source.parent / 'login.css').read_text()
        gate.login_styles = lambda: re.sub(r'@font-face\s*\{[^}]*\}', '', theme) + '\n' + css
    pages = {}
    for mode in ['shared', 'accounts']:
        gate.accounts.REGISTRY = 'isolated-visual-fixture' if mode == 'accounts' else ''
        for language in ['en', 'ko']:
            for error in ['', 'invalid_password', 'rate_limited']:
                pages[f'{mode}-{language}-{error}'] = gate.render_login_page(language, '/p/visual-paper?lang=' + language, error).decode()
    return pages

if __name__ == '__main__':
    print(json.dumps(render(sys.argv[1] if len(sys.argv) > 1 else 'after')))
