import { describe, expect, it } from "vitest";
import { compile, parse } from "./expr";
import { curve3, implicitMesh, parametricMesh, surfaceMesh, type Box3 } from "./plot3d";

const box: Box3 = { x: [-3, 3], y: [-3, 3], z: [-3, 3] };
const fn = (src: string) => compile(parse(src));

describe("3D geometry", () => {
  it("meshes a surface and leaves out undefined cells", () => {
    const plane = surfaceMesh(fn("x + y"), {}, "z", box, 10);
    expect(plane.positions.length).toBe(10 * 10 * 2 * 9);
    for (let i = 0; i < plane.positions.length; i += 3) expect(plane.positions[i + 2]).toBeCloseTo(plane.positions[i] + plane.positions[i + 1], 5);
    const half = surfaceMesh(fn("\\sqrt{x}"), {}, "z", box, 10);
    expect(half.positions.length).toBeLessThan(plane.positions.length * 0.6);
  });

  it("finds a sphere by marching tetrahedra", () => {
    const sphere = implicitMesh(fn("x^2 + y^2 + z^2 - 4"), {}, box, 24);
    expect(sphere.positions.length).toBeGreaterThan(3000);
    for (let i = 0; i < sphere.positions.length; i += 3) {
      expect(Math.hypot(sphere.positions[i], sphere.positions[i + 1], sphere.positions[i + 2])).toBeCloseTo(2, 0);
    }
    // Every triangle faces outward, toward F > 0.
    const p = sphere.positions;
    for (let i = 0; i < p.length; i += 9) {
      const u = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
      const v = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      expect(n[0] * p[i] + n[1] * p[i + 1] + n[2] * p[i + 2]).toBeGreaterThanOrEqual(0);
    }
  });

  it("samples parametric surfaces and curves", () => {
    const torus = parametricMesh([fn("(2 + \\cos v)\\cos u"), fn("(2 + \\cos v)\\sin u"), fn("\\sin v")], {}, [0, 2 * Math.PI], [0, 2 * Math.PI], 12);
    expect(torus.positions.length).toBe(12 * 12 * 2 * 9);
    const [helix] = curve3([fn("\\cos t"), fn("\\sin t"), fn("t")], {}, 0, 1, 10);
    expect(helix).toHaveLength(11);
    expect(helix[10][2]).toBeCloseTo(1);
  });
});
