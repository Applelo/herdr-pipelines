import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorOffset, popupAt } from "../mods/pipelines/placement.js";

const SIZE = { width: 380, height: 520 };
const button = (v) => ({ x: v.width - 118, y: v.height - 28, width: 118, height: 28 });

test("the popup sits 6px above the button, right edges 6px apart", () => {
  const v = { width: 1728, height: 1000 };
  assert.deepEqual(anchorOffset(button(v), v), { right: 0, bottom: 28 });
  assert.deepEqual(popupAt(v, anchorOffset(button(v), v), SIZE), { x: 1728 - 380 - 6, y: 1000 - 28 - 520 - 6 });
});

test("an offset saved in a smaller window still lands by the button in a bigger one", () => {
  const small = { width: 1728, height: 1000 }, big = { width: 2560, height: 1440 };
  assert.deepEqual(popupAt(big, anchorOffset(button(small), small), SIZE), popupAt(big, anchorOffset(button(big), big), SIZE));
  assert.deepEqual(popupAt(big, anchorOffset(button(small), small), SIZE), { x: 2560 - 380 - 6, y: 1440 - 28 - 520 - 6 });
});

test("without an offset, or with an old { x, y } anchor, it opens in the bottom-right corner", () => {
  const v = { width: 1728, height: 1000 }, corner = { x: 1728 - 380 - 6, y: 1000 - 28 - 520 - 6 };
  assert.deepEqual(popupAt(v, undefined, SIZE), corner);
  assert.deepEqual(popupAt(v, { x: 1802, y: 1023, width: 118, height: 27 }, SIZE), corner);
});

test("a button away from the right edge keeps the popup's right edge by its own", () => {
  const v = { width: 1728, height: 1000 };
  assert.deepEqual(popupAt(v, { right: 200, bottom: 28 }, SIZE), { x: 1728 - 200 - 380 - 6, y: 446 });
});

test("the popup stays inside a window too small for it", () => {
  assert.deepEqual(popupAt({ width: 300, height: 400 }, { right: 0, bottom: 28 }, SIZE), { x: 6, y: 6 });
  assert.deepEqual(popupAt({ width: 1728, height: 1000 }, { right: 1600, bottom: 900 }, SIZE), { x: 6, y: 6 });
});
