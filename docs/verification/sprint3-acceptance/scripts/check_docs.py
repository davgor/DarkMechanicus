"""c7: every repo path, relative link/anchor and module name in the four source-control docs exists at the sprint tip."""
import glob, os, re, subprocess, sys

ROOT = '/Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/source-control-sprint-3'
DOCS = ['docs/decisions/0004-source-control-in-main.md', 'docs/architecture.md', 'docs/runbooks/github-sign-in.md', 'README.md']
TRACKED = subprocess.run(['git', '-C', ROOT, 'ls-files'], capture_output=True, text=True).stdout.splitlines()


def slug(heading):
    s = re.sub(r'[^\w\- ]', '', heading.strip().lower())
    return s.replace(' ', '-')


def anchors(path):
    text = open(path, encoding='utf8').read()
    return {slug(m.group(1)) for m in re.finditer(r'^#+ (.+)$', text, re.M)}


PATHLIKE = re.compile(r'^(src|docs|skills|scripts|resources|build|\.github|\.claude|\.cursor)/[\w./\-*\[\]]*$|^[\w.\-]+\.(md|json|ts|tsx|mjs|cjs|yml|yaml)$')
fails, checked = [], []
for doc in DOCS:
    base = os.path.dirname(os.path.join(ROOT, doc))
    in_fence = False
    for n, line in enumerate(open(os.path.join(ROOT, doc), encoding='utf8'), 1):
        if line.startswith('```'):
            in_fence = not in_fence
        for target in re.findall(r'\]\(([^)\s]+)\)', line):
            if target.startswith(('http://', 'https://', 'mailto:')):
                continue
            file, _, frag = target.partition('#')
            full = os.path.normpath(os.path.join(base, file)) if file else os.path.join(ROOT, doc)
            ok = os.path.exists(full) and (not frag or frag in anchors(full))
            checked.append(('link', doc, n, target)); ok or fails.append((doc, n, target))
        for span in re.findall(r'`([^`]+)`', line):
            for part in re.split(r'[,\s]+', span):
                part = part.strip('()')
                if part.startswith(('src/', 'docs/', 'skills/', 'scripts/')) and PATHLIKE.match(part):
                    p = part.rstrip('/')
                    ok = os.path.exists(os.path.join(ROOT, p)) if '*' not in p else bool(subprocess.run(['git', '-C', ROOT, 'ls-files', p], capture_output=True, text=True).stdout)
                    checked.append(('path', doc, n, part)); ok or fails.append((doc, n, part))
                elif re.match(r'^[\w.]+\.(ts|tsx)$', part):
                    hit = [t for t in TRACKED if t.endswith('/' + part) or t == part]
                    # a dependency's file named in the docs (e.g. the Agent SDK's sdk.d.ts) lives in node_modules
                    hit = hit or glob.glob(os.path.join(ROOT, 'node_modules', '*', part)) + glob.glob(os.path.join(ROOT, 'node_modules', '@*', '*', part))
                    checked.append(('module', doc, n, part)); hit or fails.append((doc, n, part))
for kind, doc, n, item in checked:
    print(f'{kind:6} {doc}:{n}: {item}')
print(f'CHECKED: {len(checked)}  FAILS: {fails or "none"}')
sys.exit(1 if fails else 0)
