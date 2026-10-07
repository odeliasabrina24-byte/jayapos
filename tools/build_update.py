"""Builds update.json (the file JayaPOS downloads when you tap "Update sekarang") from the files in src/.
Run from the repository root:  python3 tools/build_update.py "short notes in Indonesian"
"""
import json, os, re, sys

SRC = 'src'
files = []
for name in sorted(os.listdir(SRC)):
    text = open(os.path.join(SRC, name), encoding='utf-8').read()
    if name == 'appsscript.json':
        files.append({'name': 'appsscript', 'type': 'JSON', 'source': text})
    elif name.endswith('.gs'):
        files.append({'name': name[:-3], 'type': 'SERVER_JS', 'source': text})
    elif name.endswith('.html'):
        files.append({'name': name[:-5], 'type': 'HTML', 'source': text})
config = open(os.path.join(SRC, 'Config.gs'), encoding='utf-8').read()
version = re.search(r"APP_VERSION = '([0-9.]+)'", config).group(1)
notes = sys.argv[1] if len(sys.argv) > 1 else ''
bundle = {'app': 'JayaPOS', 'version': version, 'notes': notes, 'mode': 'full', 'files': files}
with open('update.json', 'w', encoding='utf-8') as f:
    json.dump(bundle, f, ensure_ascii=False)
print('update.json:', version, len(files), 'files')
