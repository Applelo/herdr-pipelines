// Where the button's popup opens: kept as the button's distance from the window's bottom-right corner,
// since absolute bounds go stale once the window is resized or moved to another screen.
const GAP = 6, STATUS_BAR = 28;

export const anchorOffset = (b, v) => ({ right: Math.round(v.width - b.x - b.width), bottom: Math.round(v.height - b.y) });

// Without an offset (never hovered, or an anchor saved in the old `{ x, y }` shape): the bottom-right corner.
export function popupAt(v, offset, size) {
  const { right = 0, bottom = STATUS_BAR } = offset ?? {};
  const clamp = (n, room) => Math.max(GAP, Math.min(n, room - GAP));
  return {
    x: clamp(v.width - right - size.width - GAP, v.width - size.width),
    y: clamp(v.height - bottom - size.height - GAP, v.height - size.height),
  };
}
