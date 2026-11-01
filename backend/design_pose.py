"""Write a standard OpenPose body map for a front-facing T-pose."""
import sys
from PIL import Image, ImageDraw

size = int(sys.argv[2])
image = Image.new("RGB", (size, size), "black")
draw = ImageDraw.Draw(image)
points = [
    (.5, .16), (.5, .26), (.38, .28), (.24, .28), (.1, .28),
    (.62, .28), (.76, .28), (.9, .28),
    (.43, .56), (.42, .73), (.41, .91),
    (.57, .56), (.58, .73), (.59, .91),
    (.48, .15), (.52, .15), (.46, .16), (.54, .16),
]
edges = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7),
         (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
         (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]
colors = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
          (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
          (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
          (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
          (255, 0, 170), (255, 0, 85)]
pixels = [(int(x * size), int(y * size)) for x, y in points]
for i, (a, b) in enumerate(edges):
    draw.line([pixels[a], pixels[b]], fill=colors[i], width=max(3, size // 128))
for i, (x, y) in enumerate(pixels):
    radius = max(3, size // 128)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=colors[i])
image.save(sys.argv[1])
