/**
 * Mouse ownership tests: while the app tracks the mouse, mouse/wheel input is
 * reported to it and not used for scrolling/selection, unless Shift is held.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const MOUSE_REPORT = /^\x1b\[</;

describe('Mouse ownership', () => {
  let term: Terminal;
  let container: HTMLElement;
  let canvas: HTMLCanvasElement;
  let data: string[];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, smoothScrollDuration: 0 });
    term.open(container);
    canvas = container.querySelector('canvas')!;
    data = [];
    term.onData((d) => data.push(d));
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  function fillScrollback(): void {
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
  }

  function enableMouseTracking(): void {
    term.write('\x1b[?1000h\x1b[?1006h');
    expect(term.hasMouseTracking()).toBe(true);
  }

  // happy-dom's WheelEvent ignores MouseEvent init fields and MouseEvent has
  // no offsetX/offsetY, so define the ones the handlers read
  function withProps<T extends Event>(event: T, props: Record<string, unknown>): T {
    for (const [key, value] of Object.entries(props)) {
      Object.defineProperty(event, key, { value });
    }
    return event;
  }

  function wheel(target: EventTarget, init: WheelEventInit = {}): WheelEvent {
    const { shiftKey = false, clientX = 5, clientY = 5, ...rest } = init;
    const event = withProps(
      new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true, ...rest }),
      { shiftKey, clientX, clientY }
    );
    target.dispatchEvent(event);
    return event;
  }

  function mouse(type: string, init: MouseEventInit = {}): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    canvas.dispatchEvent(
      withProps(event, { offsetX: init.clientX ?? 0, offsetY: init.clientY ?? 0 })
    );
  }

  describe('wheel with mouse tracking', () => {
    for (const [name, getTarget] of [
      ['on the container', () => container],
      ['on the canvas', () => canvas],
    ] as const) {
      test(`one wheel event produces exactly one report and no scroll (${name})`, () => {
        fillScrollback();
        enableMouseTracking();
        const viewportY = term.viewportY;

        const event = wheel(getTarget());

        expect(data.length).toBe(1);
        expect(data[0]).toBe('\x1b[<64;1;1M');
        expect(term.viewportY).toBe(viewportY);
        expect(event.defaultPrevented).toBe(true);
      });
    }

    test('no arrow keys on the alternate screen', () => {
      term.write('\x1b[?1049h');
      enableMouseTracking();

      wheel(container);

      expect(data.length).toBe(1);
      expect(data[0]).toMatch(MOUSE_REPORT);
    });

    test('Shift+wheel scrolls the viewport and reports nothing', () => {
      fillScrollback();
      enableMouseTracking();
      const viewportY = term.viewportY;

      wheel(container, { shiftKey: true });

      expect(data).toEqual([]);
      expect(term.viewportY).toBeGreaterThan(viewportY);
    });

    test('Shift+wheel with horizontal delta (macOS) still scrolls vertically', () => {
      fillScrollback();
      enableMouseTracking();
      const viewportY = term.viewportY;

      wheel(container, { shiftKey: true, deltaY: 0, deltaX: -100 });

      expect(data).toEqual([]);
      expect(term.viewportY).toBeGreaterThan(viewportY);
    });
  });

  test('wheel without mouse tracking still scrolls and reports nothing', () => {
    fillScrollback();
    const viewportY = term.viewportY;

    wheel(container);

    expect(data).toEqual([]);
    expect(term.viewportY).toBeGreaterThan(viewportY);
  });

  describe('buttons with mouse tracking', () => {
    test('mousedown/up are reported and do not start a selection', () => {
      term.write('some text to select');
      enableMouseTracking();
      const selMgr = (term as any).selectionManager;

      mouse('mousedown', { clientX: 5, clientY: 5 });
      expect(selMgr.isSelecting).toBe(false);
      mouse('mouseup', { clientX: 5, clientY: 5 });

      expect(data.length).toBe(2);
      expect(data[0]).toMatch(/^\x1b\[<0;\d+;\d+M$/);
      expect(data[1]).toMatch(/^\x1b\[<0;\d+;\d+m$/);
    });

    test('double/triple click does not select while tracking', () => {
      term.write('hello world');
      enableMouseTracking();

      mouse('click', { detail: 2 });
      expect(term.hasSelection()).toBe(false);
      mouse('click', { detail: 3 });
      expect(term.hasSelection()).toBe(false);
    });

    test('Shift+mousedown starts a selection and reports nothing', () => {
      term.write('some text to select');
      enableMouseTracking();
      const selMgr = (term as any).selectionManager;

      mouse('mousedown', { shiftKey: true, clientX: 5, clientY: 5 });
      expect(selMgr.isSelecting).toBe(true);
      mouse('mousemove', { shiftKey: true, clientX: 50, clientY: 5 });
      mouse('mouseup', { shiftKey: true, clientX: 50, clientY: 5 });

      expect(data).toEqual([]);
    });

    test('Shift+double-click selects a word while tracking', () => {
      term.write('hello world');
      enableMouseTracking();

      mouse('click', { detail: 2, shiftKey: true });

      expect(term.getSelection()).toBe('hello');
      expect(data).toEqual([]);
    });

    test('mousedown starts a selection when the app does not track the mouse', () => {
      term.write('some text to select');
      const selMgr = (term as any).selectionManager;

      mouse('mousedown', { clientX: 5, clientY: 5 });

      expect(selMgr.isSelecting).toBe(true);
      expect(data).toEqual([]);
    });

    test('link clicks are not activated while the app tracks the mouse (Shift bypasses)', async () => {
      const activated: string[] = [];
      term.options.linkHandler = { activate: (_e, text) => activated.push(text) };
      term.write('https://tracked.example.com');
      enableMouseTracking();

      mouse('click', { clientX: 1, clientY: 1 });
      await new Promise((r) => setTimeout(r, 0));
      expect(activated).toEqual([]);

      mouse('click', { clientX: 1, clientY: 1, shiftKey: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(activated).toEqual(['https://tracked.example.com']);
    });
  });
});
