import sys
MODE=sys.argv[1]  # 'srgb' or 'default'
AF={'srgb':('s-app-start.png','s-app-reply.png','s-app-shifttab.png'),'default':('a-app-start.png','b-app-reply.png','c-app-shifttab.png')}[MODE]
SUF='' if MODE=='srgb' else '-default-colour-managed'
from PIL import Image, ImageDraw, ImageFont
from collections import Counter
APP=dict(ox=437,oy=293,cw=10,ch=23); WT=dict(ox=11,oy=45,cw=11,ch=23)
COLS,ROWS=169,45
def load(n): return Image.open(n).convert('RGB')
def crop(im,g): return im.crop((g['ox'],g['oy'],g['ox']+COLS*g['cw'],g['oy']+ROWS*g['ch']))
def cell(im,g,c,r,fx=.5,fy=.5): return im.getpixel((g['ox']+int(c*g['cw']+g['cw']*fx),g['oy']+int(r*g['ch']+g['ch']*fy)))
def region(im,g,c0,c1,r): return [im.getpixel((x,y)) for y in range(g['oy']+r*g['ch'],g['oy']+(r+1)*g['ch']) for x in range(g['ox']+c0*g['cw'],g['ox']+(c1+1)*g['cw'])]
def hx(c): return '#%02x%02x%02x'%c
bg=load
def font(sz):
    for p in ['C:/Windows/Fonts/consolab.ttf','C:/Windows/Fonts/arialbd.ttf']:
        try: return ImageFont.truetype(p,sz)
        except: pass
    return ImageFont.load_default()
def composite(a,w,out,title):
    A,Wt=crop(a,APP),crop(w,WT); gap=24; hdr=64
    im=Image.new('RGB',(A.width+Wt.width+gap*3,A.height+hdr+gap),(58,58,58)); d=ImageDraw.Draw(im)
    d.text((gap,12),'LEFT: Dark Mechanicus app pane (packaged build, NO colour flags, xterm.js, Consolas 13px) - %dx%d px, 169x45 cells'%A.size,font=font(26),fill=(255,255,255))
    d.text((gap*2+A.width,12),'RIGHT: standalone Windows Terminal 1.25 (portable, Skitarii scheme) - %dx%d px, 169x45 cells'%Wt.size,font=font(26),fill=(255,255,255))
    d.text((gap,38),title,font=font(20),fill=(255,214,140))
    im.paste(A,(gap,hdr)); im.paste(Wt,(gap*2+A.width,hdr)); im.save(out); print('wrote',out,im.size)
aS,wS=load(AF[0]),load('a-wt-start.png')
aR,wR=load(AF[1]),load('b-wt-reply.png')
aK,wK=load(AF[2]),load('c-wt-shifttab.png')
composite(aR,wR,'composite-reply'+SUF+'.png','Screen 2: first prompt and mock reply (wide CJK, emoji, markdown, code, status line)')
composite(aS,wS,'composite-start'+SUF+'.png','Screen 1: startup banner (true colour mascot, status line, key hint)')
composite(aK,wK,'composite-shifttab'+SUF+'.png','Screen 3: after Shift+Tab (thinking-effort key) - same message on both')
# full-window composite (window chrome included)
h=max(aR.height,wR.height); full=Image.new('RGB',(aR.width+wR.width+72,h+64),(58,58,58)); d=ImageDraw.Draw(full)
d.text((24,16),'LEFT: Dark Mechanicus app window',font=font(26),fill=(255,255,255)); d.text((48+aR.width,16),'RIGHT: standalone Windows Terminal window',font=font(26),fill=(255,255,255))
full.paste(aR,(24,64)); full.paste(wR,(48+aR.width,64)); full.save('composite-windows'+SUF+'.png'); print('wrote windows',full.size)
rows=[]
def add(name,ca,cw): rows.append((name,hx(ca),hx(cw),tuple(x-y for x,y in zip(ca,cw))))
add('terminal background (cell 80,30)',cell(aR,APP,80,30),cell(wR,WT,80,30))
add('message box bg, OMP userMessageBg (cell 80,1)',cell(aR,APP,80,1),cell(wR,WT,80,1))
def bright(im,g,c0,c1,r): return max(region(im,g,c0,c1,r),key=lambda p:sum(p))
def solid(im,g,c0,c1,r,bgc):
    c=Counter(p for p in region(im,g,c0,c1,r) if sum(abs(x-y) for x,y in zip(p,bgc))>150); return c.most_common(1)[0][0]
add('foreground text, modal glyph colour "Skitarii acceptance reply" (cols1-25,row4)',solid(aR,APP,1,25,4,cell(aR,APP,80,30)),solid(wR,WT,1,25,4,cell(wR,WT,80,30)))
add('brass text, modal glyph colour "inline code" (cols109-119,row4)',solid(aR,APP,109,119,4,cell(aR,APP,80,30)),solid(wR,WT,109,119,4,cell(wR,WT,80,30)))
def mode(im,g,c0,c1,r,excl):
    c=Counter(p for p in region(im,g,c0,c1,r) if p not in excl); return c.most_common(1)[0][0]
bgs={cell(aR,APP,80,30),cell(wR,WT,80,30)}
add('status-line segment bg (mode, cols0-20,row13)',mode(aR,APP,0,20,13,bgs),mode(wR,WT,0,20,13,bgs))
def findred(im,g,r):
    best=None
    for c in range(0,12):
        p=cell(im,g,c,r)
        if p[0]>150 and p[1]<110 and p[2]<90: return c,p
    return None,None
for r in (14,):
    ca,pa=findred(aR,APP,r); cw_,pw=findred(wR,WT,r); print('cursor cols',ca,cw_)
    if pa and pw: add('crimson: cursor block (#ea4134), cell (%d,%d)/(%d,%d)'%(ca,r,cw_,r),pa,pw)
import itertools
diffs=[];cells=[]
for r in range(1,15):
    for c in range(0,28):
        for fy in (.2,.8):
            pa=cell(aS,APP,c,r,.5,fy); pw=cell(wS,WT,c,r,.5,fy)
            if pa!=cell(aS,APP,80,30) or pw!=cell(wS,WT,80,30):
                d=tuple(abs(x-y) for x,y in zip(pa,pw)); diffs.append(d); cells.append((c,r,fy,pa,pw))
n=len(diffs); mean=[sum(d[i] for d in diffs)/n for i in range(3)]; mx=[max(d[i] for d in diffs) for i in range(3)]
within=sum(1 for d in diffs if max(d)<=3)
print('mascot sample points',n,'mean abs diff',mean,'max',mx,'within3',within)
open('mascot-stats'+SUF+'.txt','w').write('banner mascot, %d half-cell samples (cols0-27, rows1-14, non-background in either): mean |diff| R,G,B = %.2f, %.2f, %.2f; max |diff| = %d, %d, %d; samples within 3 per channel: %d of %d'%(n,*mean,*mx,within,n)+chr(10))
# three representative mascot samples: most red, most green, brightest
def pick(key): 
    return max(cells,key=lambda t:key(t[4]))
for nm,key in (('mascot: most crimson sample',lambda p:p[0]-p[1]-p[2]),('mascot: greenest sample (eye)',lambda p:p[1]-p[0]-p[2]),('mascot: brightest sample (hood highlight)',lambda p:sum(p))):
    c,r,fy,pa,pw=pick(key); add('%s, cell (%d,%d) %s'%(nm,c,r,'upper' if fy<.5 else 'lower'),pa,pw)
add('banner brass subtitle "The Omnissiah..." modal glyph colour (cols35-60,row9)',solid(aS,APP,35,60,9,cell(aS,APP,80,30)),solid(aS,WT,35,60,9,cell(aS,WT,80,30)) if False else solid(wS,WT,35,60,9,cell(wS,WT,80,30)))
with open('colors'+SUF+'.md','w') as f:
    f.write('| point | app pane | standalone WT | diff R,G,B (app-WT) |\n|---|---|---|---|\n')
    for n,a,w,d in rows: f.write('| %s | %s | %s | %d, %d, %d |\n'%(n,a,w,*d))
print(open('colors'+SUF+'.md').read())
