"""Draws public/assets/graphs/graph-3d.svg, the surface z = sin x cos y in the §5 Graphs figure,
the way Theoremis's 3D graph blocks draw it: shaded quads sorted back to front, in a box.

    python3 scripts/draw-surface.py public/assets/graphs
"""
import math
import sys
OUT = sys.argv[1]

def hex_rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# ---- 3D: z = sin(x) cos(y) on [-5,5]^2 in the box [-5,5]^3, as the app draws it ----
W, H = 560, 400
az, el = math.radians(-130 + 180), math.radians(28)
def rot(p):
    x, y, z = p
    # Turn about z, then tilt toward the viewer.
    xr = x * math.cos(az) - y * math.sin(az)
    yr = x * math.sin(az) + y * math.cos(az)
    depth = yr * math.cos(el) - z * math.sin(el)
    up = yr * math.sin(el) + z * math.cos(el)
    return xr, up, depth
S = 26.5
def proj(p):
    xr, up, depth = rot(p)
    return W / 2 + xr * S, H / 2 + 6 - up * S, depth

f = lambda x, y: math.sin(x) * math.cos(y)
N = 26
lo, hi = -5, 5
pts = [[(lo + (hi - lo) * i / N, lo + (hi - lo) * j / N) for i in range(N + 1)] for j in range(N + 1)]
light = (-0.35, -0.45, 0.82)
ln = math.sqrt(sum(c * c for c in light)); light = tuple(c / ln for c in light)
base = hex_rgb("#ff6b6b")
quads = []
for j in range(N):
    for i in range(N):
        corners = [pts[j][i], pts[j][i + 1], pts[j + 1][i + 1], pts[j + 1][i]]
        world = [(x, y, f(x, y) * 1.6) for x, y in corners]
        # Normal from two diagonals.
        a = [world[2][k] - world[0][k] for k in range(3)]
        b = [world[3][k] - world[1][k] for k in range(3)]
        n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        nl = math.sqrt(sum(c * c for c in n)) or 1
        n = tuple(c / nl for c in n)
        if n[2] < 0: n = tuple(-c for c in n)
        lam = 0.38 + 0.62 * max(0.0, sum(n[k] * light[k] for k in range(3)))
        zc = sum(w[2] for w in world) / 4
        t = (zc / 1.6 + 1) / 2
        tint = 0.62 + 0.48 * t
        rgb = tuple(max(0, min(255, int(c * lam * tint))) for c in base)
        p2 = [proj(w) for w in world]
        depth = sum(p[2] for p in p2) / 4
        quads.append((depth, p2, rgb))
quads.sort(key=lambda q: -q[0])
out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="The surface z = sin x cos y, drawn in three dimensions">']
out.append(f'<rect width="{W}" height="{H}" fill="#121318"/>')
# Box: back edges first, then the floor grid at z = 0.
box = [(x, y, z) for x in (lo, hi) for y in (lo, hi) for z in (lo * 0.7, hi * 0.7)]
edges = [(a, b) for a in range(8) for b in range(a + 1, 8) if sum(box[a][k] != box[b][k] for k in range(3)) == 1]
def line(p, q, stroke, width=1, dash=None, opacity=1):
    (x1, y1, _), (x2, y2, _) = proj(p), proj(q)
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" stroke-width="{width}" stroke-opacity="{opacity}"{d}/>'
centre_depth = proj((0, 0, 0))[2]
back = [e for e in edges if (proj(box[e[0]])[2] + proj(box[e[1]])[2]) / 2 >= centre_depth]
front = [e for e in edges if e not in back]
for a, b in back: out.append(line(box[a], box[b], "#6b6e80", 1, opacity=0.55))
for k in range(-5, 6):
    out.append(line((k, lo, 0), (k, hi, 0), "#3a3c48", 0.8, opacity=0.9))
    out.append(line((lo, k, 0), (hi, k, 0), "#3a3c48", 0.8, opacity=0.9))
# The z axis: its lower part behind the surface, the rest drawn after it.
out.append(line((0, 0, lo * 0.7), (0, 0, 1.75), "#c8cad4", 1.2))
for depth, p2, rgb in quads:
    d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y, _ in p2) + "Z"
    col = "#%02x%02x%02x" % rgb
    out.append(f'<path d="{d}" fill="{col}" stroke="{col}" stroke-width="0.6"/>')
for a, b in front: out.append(line(box[a], box[b], "#6b6e80", 1, opacity=0.55))
# Axes through the origin.
out.append(line((0, 0, 1.75), (0, 0, hi * 0.7 + 0.6), "#c8cad4", 1.2))
for label, p in (("x", (hi + 0.9, 0, 0)), ("y", (0, hi + 0.9, 0)), ("z", (0, 0, hi * 0.7 + 1.1))):
    x, y, _ = proj(p)
    out.append(f'<text x="{x:.1f}" y="{y:.1f}" fill="#e4e5ec" font-family="Georgia, serif" font-style="italic" font-size="15" text-anchor="middle" dominant-baseline="middle">{label}</text>')
out.append('</svg>')
open(f"{OUT}/graph-3d.svg", "w").write("\n".join(out))
print("3d bytes", sum(len(s) for s in out))
