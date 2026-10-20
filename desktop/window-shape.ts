import type { Rectangle } from 'electron';

/** Horizontal bands keep the native window controls while rounding its outer contour. */
export function roundedWindowShape(width: number, height: number, radius = 28): Rectangle[] {
  const r = Math.min(radius, Math.floor(Math.min(width, height) / 2));
  const shape: Rectangle[] = [{ x: 0, y: r, width, height: height - r * 2 }];
  for (let y = 0; y < r; y++) {
    const inset = Math.ceil(r - Math.sqrt(r * r - (r - y - .5) ** 2));
    shape.push({ x: inset, y, width: width - inset * 2, height: 1 });
    shape.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 });
  }
  return shape;
}
