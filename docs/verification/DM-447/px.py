import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB')
x,y=int(sys.argv[2]),int(sys.argv[3])
print(im.size,'#%02x%02x%02x'%im.getpixel((x,y)))
