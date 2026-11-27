import { expect } from "vitest";

// Compare the actual composited pixels, including translucent hover surfaces.
export function paintedContrast(
  foreground: string,
  backgrounds: string[],
  { opaque = false, validateColors = false } = {},
): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = (color: string) => {
    if (validateColors) expect(CSS.supports("color", color), color).toBe(true);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  };
  const luminance = (label: string) => {
    const pixel = context.getImageData(0, 0, 1, 1).data;
    if (opaque) expect(pixel[3], label).toBe(255);
    const [r, g, b] = Array.from(pixel.slice(0, 3), (byte) => {
      const channel = byte / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const surface of backgrounds) paint(surface);
  const bg = luminance(backgrounds.join(" + "));
  paint(foreground);
  const fg = luminance([...backgrounds, foreground].join(" + "));
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}
