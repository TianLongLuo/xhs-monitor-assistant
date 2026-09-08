"use strict";

// Isolated Node QA: no browser, extension APIs, storage, network, or shared globals.
// This mock models centering/reflow plus reservation variables, not a CSS engine.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const modulePath = join(__dirname, "..", "process-layout.js");
const factory = vm.runInThisContext(
  `(function(module, ResizeObserver, getComputedStyle) {\n${readFileSync(modulePath, "utf8")}\n})`,
  { filename: modulePath },
);
function loadApi(observer, computedStyle) {
  const module = { exports: {} };
  factory(module, observer, computedStyle);
  return module.exports;
}
const { planDock, translateParts } = loadApi();
const ATTRIBUTE = "data-xhs-monitor-reserved";
const names = ["width", "height", "shift-x", "shift-y", "native-x", "native-y", "native-z"];
const variable = name => `--xhs-monitor-note-${name}`;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const VIEW = Object.freeze({ width: 1480, height: 940 });
const NATURAL = Object.freeze(rect(104, 32, 1270, 877));
const near = (actual, expected, message, epsilon = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: got ${actual}, expected ${expected}`);

function assertLayout(plan, width, height, context = "layout", epsilon = 1e-7) {
  assert.ok(["outside", "reserved", "stacked"].includes(plan.mode), `${context}: known mode`);
  assert.equal(plan.reserved, plan.mode !== "outside", `${context}: reservation agrees with mode`);
  assert.ok(Number.isFinite(plan.gap) && plan.gap > 0, `${context}: positive finite gap`);
  for (const key of ["note", "panel"]) {
    const box = plan[key];
    for (const field of ["left", "top", "width", "height", "right", "bottom"])
      assert.ok(Number.isFinite(box[field]), `${context}: ${key}.${field} finite`);
    assert.ok(box.width > 0 && box.height > 0, `${context}: ${key} has positive area`);
    near(box.right, box.left + box.width, `${context}: ${key}.right`, epsilon);
    near(box.bottom, box.top + box.height, `${context}: ${key}.bottom`, epsilon);
    assert.ok(box.left >= -epsilon && box.top >= -epsilon, `${context}: ${key} starts inside viewport`);
    assert.ok(box.right <= width + epsilon && box.bottom <= height + epsilon,
      `${context}: ${key} ends inside ${width}x${height}: ${JSON.stringify(box)}`);
  }
  if (plan.mode === "stacked") {
    assert.ok(plan.note.bottom + plan.gap <= plan.panel.top + epsilon, `${context}: vertical clearance`);
    near(plan.panel.left, plan.note.left, `${context}: stacked left`, epsilon);
    near(plan.panel.width, plan.note.width, `${context}: stacked width`, epsilon);
  } else {
    assert.ok(plan.note.right + plan.gap <= plan.panel.left + epsilon, `${context}: horizontal clearance`);
    near(plan.panel.top, plan.note.top, `${context}: shared top`, epsilon);
  }
}

// 20 widths x 11 heights x 2 states x 6 note shapes = 2,640 independent cases.
const widths = [240, 320, 360, 390, 480, 640, 768, 879, 880, 891, 892, 903, 915, 916, 1024, 1280, 1366, 1480, 1920, 2560];
const heights = [180, 240, 320, 480, 640, 720, 768, 877, 940, 1080, 1440];
for (const width of widths) {
  for (const collapsed of [false, true]) {
    test(`planDock grid width=${width}, collapsed=${collapsed}: bounded, disjoint, deterministic`, () => {
      for (const height of heights) {
        const shapes = [
          NATURAL,
          rect(12, 12, Math.max(1, width - 24), Math.max(1, height - 24)),
          rect(width * 0.2, height * 0.15, width * 0.4, height * 0.5),
          rect(-125, -70, width * 1.6, height * 1.7),
          rect(width - 3, height - 2, 240, 200),
          rect(12.25, 13.75, 611.375, 401.625),
        ];
        for (const [index, source] of shapes.entries()) {
          const input = Object.freeze({ viewportWidth: width, viewportHeight: height,
            rect: Object.freeze({ ...source }), collapsed });
          const before = JSON.stringify(input);
          const plan = planDock(input);
          assertLayout(plan, width, height, `${width}x${height}, collapsed=${collapsed}, shape=${index}`);
          assert.deepEqual(plan, planDock(input), "same input gives same layout");
          assert.equal(JSON.stringify(input), before, "caller-owned geometry stays untouched");
          assert.ok(plan.note.width <= source.width + 1e-7 && plan.note.height <= source.height + 1e-7,
            "reservation never stretches native content");
        }
      }
    });
  }
}

test("sidepanel regression: 1480x940 with native note 104,32,1270,877", () => {
  const plan = planDock({ viewportWidth: VIEW.width, viewportHeight: VIEW.height, rect: NATURAL });
  assert.equal(plan.mode, "reserved");
  assert.equal(plan.gap, 12);
  assert.deepEqual(plan.note, rect(12, 32, 1152, 877));
  assert.deepEqual(plan.panel, rect(1176, 32, 292, 877));
  assertLayout(plan, VIEW.width, VIEW.height);
});

test("ample right-hand space leaves native note unreserved in both states", () => {
  const source = Object.freeze(rect(140, 80, 1200, 900));
  for (const collapsed of [false, true]) {
    const plan = planDock({ viewportWidth: 1920, viewportHeight: 1080, rect: source, collapsed });
    assert.equal(plan.mode, "outside");
    assert.equal(plan.reserved, false);
    assert.deepEqual(plan.note, source);
    assertLayout(plan, 1920, 1080);
  }
});

test("collapsing returns 56px to the side-by-side note and expansion is reversible", () => {
  const input = { viewportWidth: VIEW.width, viewportHeight: VIEW.height, rect: NATURAL };
  const expanded = planDock(input);
  const collapsed = planDock({ ...input, collapsed: true });
  assert.deepEqual(collapsed.note, rect(12, 32, 1208, 877));
  assert.deepEqual(collapsed.panel, rect(1232, 32, 236, 877));
  assert.equal(collapsed.note.width - expanded.note.width, 56);
  assert.deepEqual(planDock(input), expanded);
});

test("390x844 uses a separate bottom row; collapsed row returns height to the note", () => {
  const input = { viewportWidth: 390, viewportHeight: 844, rect: rect(16, 32, 358, 780) };
  const expanded = planDock(input);
  const collapsed = planDock({ ...input, collapsed: true });
  assert.equal(expanded.mode, "stacked");
  assert.equal(collapsed.mode, "stacked");
  assert.deepEqual(expanded.note, rect(16, 12, 358, 548));
  assert.deepEqual(expanded.panel, rect(16, 572, 358, 260));
  assert.deepEqual(collapsed.note, rect(16, 12, 358, 696));
  assert.deepEqual(collapsed.panel, rect(16, 720, 358, 112));
});

test("breakpoints preserve a 640px note when switching away from stacked mode", () => {
  for (const [collapsed, breakpoint] of [[false, 916], [true, 892]]) {
    for (const width of [breakpoint - 1, breakpoint, breakpoint + 1]) {
      const plan = planDock({ viewportWidth: width, viewportHeight: 940, rect: NATURAL, collapsed });
      assert.equal(plan.mode, width < breakpoint ? "stacked" : "reserved");
      if (width >= breakpoint) assert.ok(plan.note.width >= 640);
      assertLayout(plan, width, 940);
    }
  }
  const input = { viewportWidth: 904, viewportHeight: 940, rect: NATURAL };
  assert.equal(planDock(input).mode, "stacked");
  assert.equal(planDock({ ...input, collapsed: true }).mode, "reserved");
});

for (const [value, expected] of [
  [undefined, ["0px", "0px", "0px"]],
  ["none", ["0px", "0px", "0px"]],
  ["12px", ["12px", "0px", "0px"]],
  ["-50% -50%", ["-50%", "-50%", "0px"]],
  ["10px 20px 30px", ["10px", "20px", "30px"]],
  ["  1px\t-2px\n3px  ", ["1px", "-2px", "3px"]],
  ["calc(50% - 20px) 30px", ["calc(50% - 20px)", "30px", "0px"]],
  ["calc(50% - 20px) calc(-50% + 2px) 3px", ["calc(50% - 20px)", "calc(-50% + 2px)", "3px"]],
]) {
  test(`translateParts preserves computed native translation: ${JSON.stringify(value)}`, () => {
    assert.deepEqual(translateParts(value), expected);
  });
}

class MockStyle {
  constructor() { this.values = new Map(); this.writes = []; }
  getPropertyValue(key) { return this.values.get(key)?.value || ""; }
  getPropertyPriority(key) { return this.values.get(key)?.priority || ""; }
  setProperty(key, value, priority = "") {
    this.values.set(key, { value: String(value), priority });
    this.writes.push(["set", key, String(value), priority]);
  }
  removeProperty(key) {
    const previous = this.getPropertyValue(key);
    if (this.values.delete(key)) this.writes.push(["remove", key]);
    return previous;
  }
  snapshot() { return [...this.values].sort(([a], [b]) => a.localeCompare(b)); }
}

function mockNode(natural = NATURAL, options = {}) {
  const style = new MockStyle();
  const attributes = new Map();
  const node = {
    style, className: "native-note", isConnected: true,
    parentElement: options.parent === false ? null : { kind: "native-parent" },
    natural: { ...natural }, nativeTranslate: "none", reads: 0, naturalReads: 0, attributeWrites: [],
    getAttribute(key) { return attributes.has(key) ? attributes.get(key) : null; },
    setAttribute(key, value) { attributes.set(key, String(value)); this.attributeWrites.push(["set", key, String(value)]); },
    removeAttribute(key) { if (attributes.delete(key)) this.attributeWrites.push(["remove", key]); },
    snapshot() { return { styles: style.snapshot(), attributes: [...attributes].sort() }; },
    getBoundingClientRect() {
      this.reads++;
      const reserved = ["reserved", "stacked"].includes(this.getAttribute(ATTRIBUTE));
      if (!reserved) { this.naturalReads++; return { ...this.natural }; }
      const value = (key, fallback) => {
        const text = style.getPropertyValue(variable(key));
        if (!text) return fallback;
        assert.match(text, /^-?(?:\d+\.?\d*|\.\d+)px$/, `mock expects finite CSS pixels for ${key}`);
        return Number.parseFloat(text);
      };
      const width = value("width", this.natural.width);
      const height = value("height", this.natural.height);
      // A centered native transform changes the border position when width/height shrink.
      return rect(this.natural.left + (this.natural.width - width) * (options.anchorX ?? 0.5) + value("shift-x", 0),
        this.natural.top + (this.natural.height - height) * (options.anchorY ?? 0.5) + value("shift-y", 0), width, height);
    },
  };
  return node;
}

function harness(t, options = {}) {
  const observers = [];
  class MockResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnects = 0; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.disconnects++; this.targets.clear(); }
    notify(target) { if (this.targets.has(target)) this.callback([{ target }], this); }
  }
  const api = loadApi(options.observer === false ? undefined : MockResizeObserver,
    node => ({ translate: node.nativeTranslate }));
  const controller = api.createReservation({ onResize: options.onResize });
  t.after(() => controller.release());
  return { controller, observers };
}

function assertRendered(node, plan, viewport = VIEW) {
  const actual = node.getBoundingClientRect();
  for (const key of ["left", "top", "width", "height"])
    near(actual[key], plan.note[key], `rendered note.${key}`, 0.011);
  assertLayout({ ...plan, note: actual }, viewport.width, viewport.height, "rendered border", 0.011);
  if (plan.mode === "stacked") near(plan.panel.top, actual.bottom + plan.gap, "panel follows measured bottom");
  else near(plan.panel.left, actual.right + plan.gap, "panel follows measured right");
}

test("controller: 100 repeated updates are idempotent without cumulative shrink or mutations", t => {
  const { controller, observers } = harness(t);
  const node = mockNode();
  const first = controller.update(node, "note-a", VIEW, false);
  assertRendered(node, first);
  const before = node.snapshot();
  const writes = node.style.writes.length;
  const attributes = node.attributeWrites.length;
  for (let i = 0; i < 100; i++) {
    const plan = controller.update(node, "note-a", VIEW, false);
    assert.deepEqual(plan, first);
    assertRendered(node, plan);
  }
  assert.equal(node.naturalReads, 1, "never adopt a reserved rect as the native baseline");
  assert.deepEqual(node.snapshot(), before);
  assert.equal(node.style.writes.length, writes, "unchanged updates should not rewrite inline variables");
  assert.equal(node.attributeWrites.length, attributes);
  assert.equal(observers.length, 1);
  assert.deepEqual([...observers[0].targets], [node, node.parentElement]);
});

test("controller: fractional centered geometry also settles without repeated variable writes", t => {
  const { controller } = harness(t);
  const node = mockNode(rect(104.123, 32.237, 1270.789, 877.333));
  assertRendered(node, controller.update(node, "fractional", VIEW, false));
  const settled = node.snapshot();
  const writes = node.style.writes.length;
  for (let i = 0; i < 10; i++) assertRendered(node, controller.update(node, "fractional", VIEW, false));
  assert.deepEqual(node.snapshot(), settled, "subpixel positions stay stable");
  assert.equal(node.style.writes.length, writes,
    "settled subpixel shifts must not alternate raw and rounded CSS values on every update");
});

test("controller: release restores every custom property/priority and original attribute; native transform untouched", t => {
  const { controller } = harness(t);
  const node = mockNode();
  node.setAttribute(ATTRIBUTE, "host-marker");
  for (const [index, name] of names.entries()) node.style.setProperty(variable(name), `${index + 5}px`, index % 2 ? "" : "important");
  for (const [key, value, priority] of [
    ["transform", "translate(-50%, -50%) scale(1)", "important"],
    ["translate", "10px 20px 3px", "important"],
    ["width", "calc(100vw - 208px)", ""],
    ["height", "877px", "important"],
    ["--host-theme", "purple", ""],
  ]) node.style.setProperty(key, value, priority);
  node.nativeTranslate = "10px 20px 3px";
  const original = node.snapshot();
  const firstWrite = node.style.writes.length;
  controller.update(node, "styled", VIEW, false);
  for (const [axis, value] of [["x", "10px"], ["y", "20px"], ["z", "3px"]])
    assert.equal(node.style.getPropertyValue(variable(`native-${axis}`)), value);
  controller.release();
  assert.deepEqual(node.snapshot(), original);
  assert.ok(node.style.writes.slice(firstWrite).every(([, key]) => names.map(variable).includes(key)),
    "controller owns only its custom properties, never native transform/style declarations");
});

test("controller: release removes newly introduced variables/attribute and is itself idempotent", t => {
  const { controller, observers } = harness(t);
  const node = mockNode();
  node.style.setProperty("--host-theme", "blue", "important");
  const original = node.snapshot();
  controller.update(node, "note-a", VIEW, false);
  controller.release();
  assert.deepEqual(node.snapshot(), original);
  assert.equal(controller.owns(node, "note-a"), false);
  assert.equal(observers[0].disconnects, 1);
  const writes = node.style.writes.length;
  controller.release();
  assert.equal(node.style.writes.length, writes);
  assert.equal(observers[0].disconnects, 1);
});

test("controller: ample space creates no reservation presentation", t => {
  const { controller } = harness(t);
  const node = mockNode(rect(140, 80, 1200, 900));
  const original = node.snapshot();
  for (const collapsed of [false, true, false]) {
    const plan = controller.update(node, "ample", { width: 1920, height: 1080 }, collapsed);
    assert.equal(plan.mode, "outside");
    assert.deepEqual(node.snapshot(), original);
  }
  assert.equal(node.style.writes.length, 0);
  assert.equal(node.attributeWrites.length, 0);
  assert.equal(node.naturalReads, 1);
});

test("controller: collapse/expand preserves the native baseline in both dock modes", t => {
  const { controller } = harness(t);
  for (const viewport of [VIEW, { width: 390, height: 844 }, { width: 904, height: 940 }]) {
    const node = mockNode();
    const first = controller.update(node, "toggle", viewport, false);
    const collapsed = controller.update(node, "toggle", viewport, true);
    assertRendered(node, collapsed, viewport);
    const expanded = controller.update(node, "toggle", viewport, false);
    assertRendered(node, expanded, viewport);
    assert.deepEqual(expanded, first);
    assert.equal(node.naturalReads, 1, "toggle should not measure the already-constrained note as native");
  }
});

test("controller: viewport change remeasures restored native layout and can release/reapply reservation", t => {
  const { controller } = harness(t);
  const node = mockNode();
  const original = node.snapshot();
  controller.update(node, "responsive", VIEW, false);
  node.natural = rect(140, 80, 1200, 900);
  const wide = { width: 1920, height: 1080 };
  const outside = controller.update(node, "responsive", wide, false);
  assert.equal(outside.mode, "outside");
  assert.deepEqual(outside.note, node.natural);
  assert.equal(node.naturalReads, 2);
  assert.deepEqual(node.snapshot(), original);
  node.natural = { ...NATURAL };
  assertRendered(node, controller.update(node, "responsive", VIEW, false));
  assert.equal(node.naturalReads, 3);
});

for (const kind of ["inline value", "inline priority", "class"]) {
  test(`controller: external ${kind} change remeasures native geometry in the same viewport`, t => {
    const { controller } = harness(t);
    const node = mockNode();
    node.style.setProperty("width", "1270px");
    node.style.setProperty("transform", "translateX(-50%)", "important");
    controller.update(node, "native-style", VIEW, false);
    node.natural = rect(120, 48, 1000, 800);
    if (kind === "inline value") node.style.setProperty("width", "1000px");
    if (kind === "inline priority") node.style.setProperty("width", "1270px", "important");
    if (kind === "class") node.className += " compact";
    const nativeWidth = [node.style.getPropertyValue("width"), node.style.getPropertyPriority("width")];
    const plan = controller.update(node, "native-style", VIEW, false);
    assert.equal(node.naturalReads, 2);
    assert.deepEqual(plan.note, node.natural);
    assert.equal(plan.mode, "outside");
    controller.release();
    assert.deepEqual([node.style.getPropertyValue("width"), node.style.getPropertyPriority("width")], nativeWidth);
    assert.equal(node.style.getPropertyValue("transform"), "translateX(-50%)");
    assert.equal(node.style.getPropertyPriority("transform"), "important");
  });
}

test("controller: parent resize invalidates cached native geometry without viewport/inline-style changes", t => {
  const node = mockNode();
  let controller;
  let result;
  let notifications = 0;
  const env = harness(t, { onResize() {
    notifications++;
    result = controller.update(node, "parent-resize", VIEW, false);
  } });
  controller = env.controller;
  controller.update(node, "parent-resize", VIEW, false);
  // A parent layout/CSS change may alter the native rect without touching the note's class/style.
  node.natural = rect(120, 48, 1000, 800);
  env.observers[0].notify(node.parentElement);
  assert.equal(notifications, 1);
  assert.deepEqual(result.note, node.natural, "a parent ResizeObserver event must not reuse the obsolete native rect");
  assert.equal(result.mode, "outside");
  assert.ok(node.naturalReads >= 2, "remeasure after restoring presentation");
});

test("controller: switching DOM notes restores the old note and disconnects only its observer", t => {
  const { controller, observers } = harness(t);
  const first = mockNode();
  first.setAttribute(ATTRIBUTE, "original");
  first.style.setProperty(variable("width"), "777px", "important");
  const original = first.snapshot();
  const second = mockNode(rect(60, 40, 1240, 840));
  controller.update(first, "first", VIEW, false);
  assert.equal(controller.owns(first, "first"), true);
  const plan = controller.update(second, "second", VIEW, false);
  assert.deepEqual(first.snapshot(), original);
  assert.equal(controller.owns(first, "first"), false);
  assert.equal(controller.owns(second, "second"), true);
  assert.equal(observers.length, 2);
  assert.equal(observers[0].disconnects, 1);
  assert.equal(observers[0].targets.size, 0);
  assert.equal(observers[1].disconnects, 0);
  assertRendered(second, plan);
});

test("controller: a new note ID on a reused DOM node cleans up and remeasures", t => {
  const { controller, observers } = harness(t);
  const node = mockNode();
  const original = node.snapshot();
  controller.update(node, "old-id", VIEW, false);
  node.natural = rect(90, 60, 1250, 800);
  const plan = controller.update(node, "new-id", VIEW, false);
  assert.equal(node.naturalReads, 2);
  assert.equal(controller.owns(node, "old-id"), false);
  assert.equal(controller.owns(node, "new-id"), true);
  assert.equal(observers[0].disconnects, 1);
  assert.equal(observers.length, 2);
  assertRendered(node, plan);
  controller.release();
  assert.deepEqual(node.snapshot(), original);
});

for (const invalid of ["null", "disconnected"]) {
  test(`controller: ${invalid} node releases presentation and observation`, t => {
    const { controller, observers } = harness(t);
    const node = mockNode();
    const original = node.snapshot();
    controller.update(node, "live", VIEW, false);
    if (invalid === "disconnected") node.isConnected = false;
    assert.equal(controller.update(invalid === "null" ? null : node, "live", VIEW, false), null);
    assert.deepEqual(node.snapshot(), original);
    assert.equal(controller.owns(node, "live"), false);
    assert.equal(observers[0].disconnects, 1);
  });
}

for (const [width, height] of [[0, 800], [1200, 0], [-1, 800]]) {
  test(`controller: unusable native rect ${width}x${height} returns null and tears down`, t => {
    const { controller, observers } = harness(t);
    const node = mockNode(rect(12, 12, width, height));
    const original = node.snapshot();
    assert.equal(controller.update(node, "hidden", VIEW, false), null);
    assert.deepEqual(node.snapshot(), original);
    assert.equal(controller.owns(node, "hidden"), false);
    assert.equal(observers[0].disconnects, 1);
    assert.equal(observers[0].targets.size, 0);
  });
}

test("controller: observer forwards node/parent notifications and stops after release", t => {
  let calls = 0;
  const { controller, observers } = harness(t, { onResize() { calls++; } });
  const node = mockNode();
  controller.update(node, "watched", VIEW, false);
  observers[0].notify(node);
  observers[0].notify(node.parentElement);
  assert.equal(calls, 2);
  controller.release();
  observers[0].notify(node);
  observers[0].notify(node.parentElement);
  assert.equal(calls, 2);
  assert.equal(observers[0].disconnects, 1);
});

test("controller: missing ResizeObserver and absent parent are both supported", t => {
  const withoutObserver = harness(t, { observer: false });
  const node = mockNode(NATURAL, { parent: false });
  assertRendered(node, withoutObserver.controller.update(node, "no-observer", VIEW, false));
  withoutObserver.controller.release();
  const withObserver = harness(t);
  assertRendered(node, withObserver.controller.update(node, "no-parent", VIEW, false));
  assert.deepEqual([...withObserver.observers[0].targets], [node]);
});

test("controller: release preserves a reservation attribute replaced by another owner", t => {
  const { controller } = harness(t);
  const node = mockNode();
  controller.update(node, "attribute-owner", VIEW, false);
  node.setAttribute(ATTRIBUTE, "external-owner");
  controller.release();
  assert.equal(node.getAttribute(ATTRIBUTE), "external-owner");
  for (const name of names) assert.equal(node.style.getPropertyValue(variable(name)), "");
});
