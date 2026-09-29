/**
 * linkHandler option and wrapped URL detection tests
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ILinkHandler } from './interfaces';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { ILink } from './types';

function click(modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}): MouseEvent {
  return new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
}

function createHandler() {
  return {
    activate: mock((_event: MouseEvent, _text: string, _range: unknown) => {}),
    hover: mock((_event: MouseEvent, _text: string, _range: unknown) => {}),
    leave: mock((_event: MouseEvent, _text: string, _range: unknown) => {}),
  } satisfies ILinkHandler;
}

function provide(
  provider: { provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void },
  y: number
): Promise<ILink[] | undefined> {
  return new Promise((resolve) => provider.provideLinks(y, resolve));
}

describe('linkHandler', () => {
  let term: Terminal;
  let container: HTMLElement;
  let openSpy: ReturnType<typeof mock>;
  let originalOpen: typeof window.open;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);
    originalOpen = window.open;
    openSpy = mock(() => null);
    window.open = openSpy as unknown as typeof window.open;
  });

  afterEach(() => {
    window.open = originalOpen;
    term.dispose();
    container.remove();
  });

  async function osc8Link(): Promise<ILink> {
    term.write('\x1b]8;;https://osc8.example.com\x07click me\x1b]8;;\x07');
    const links = await provide(new OSC8LinkProvider(term), 0);
    expect(links?.length).toBe(1);
    return links![0];
  }

  async function urlLink(): Promise<ILink> {
    term.write('see https://url.example.com/path now');
    const links = await provide(new UrlRegexProvider(term), 0);
    expect(links?.length).toBe(1);
    return links![0];
  }

  for (const [name, getLink, expectedText] of [
    ['OSC 8', osc8Link, 'https://osc8.example.com'],
    ['URL regex', urlLink, 'https://url.example.com/path'],
  ] as const) {
    describe(name, () => {
      test('calls linkHandler.activate with and without modifiers, never window.open', async () => {
        const handler = createHandler();
        term.options.linkHandler = handler;
        const link = await getLink();

        const plain = click();
        link.activate(plain);
        link.activate(click({ metaKey: true }));
        link.activate(click({ ctrlKey: true }));

        expect(handler.activate).toHaveBeenCalledTimes(3);
        const [event, text, range] = handler.activate.mock.calls[0];
        expect(event).toBe(plain);
        expect(text).toBe(expectedText);
        expect(range).toEqual(link.range);
        expect(openSpy).not.toHaveBeenCalled();
      });

      test('falls back to window.open only with Ctrl/Cmd', async () => {
        const link = await getLink();

        link.activate(click());
        expect(openSpy).not.toHaveBeenCalled();

        link.activate(click({ ctrlKey: true }));
        link.activate(click({ metaKey: true }));
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(openSpy.mock.calls[0]).toEqual([expectedText, '_blank', 'noopener,noreferrer']);
      });

      test('routes hover/leave to linkHandler', async () => {
        const handler = createHandler();
        const link = await getLink();
        term.options.linkHandler = handler;

        const event = new MouseEvent('mousemove');
        link.hover?.(true, event);
        link.hover?.(false, event);

        expect(handler.hover).toHaveBeenCalledWith(event, expectedText, link.range);
        expect(handler.leave).toHaveBeenCalledWith(event, expectedText, link.range);
      });
    });
  }

  test('linkHandler passed to the constructor is used', async () => {
    const handler = createHandler();
    const t = await createIsolatedTerminal({ cols: 80, rows: 24, linkHandler: handler });
    t.open(document.createElement('div'));
    t.write('https://ctor.example.com');
    const links = await provide(new UrlRegexProvider(t), 0);
    links![0].activate(click());
    expect(handler.activate).toHaveBeenCalledTimes(1);
    t.dispose();
  });

  test('clicking a link on the canvas activates it through linkHandler', async () => {
    const handler = createHandler();
    term.options.linkHandler = handler;
    term.write('https://click.example.com');

    const canvas = container.querySelector('canvas')!;
    const renderer = (term as any).renderer;
    canvas.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: renderer.charWidth * 2 + 1,
        clientY: 1,
      })
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(handler.activate).toHaveBeenCalledTimes(1);
    expect(handler.activate.mock.calls[0][1]).toBe('https://click.example.com');
  });
});

describe('Wrapped URL detection', () => {
  let term: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 20, rows: 5, scrollback: 0 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  test('a URL soft-wrapped across rows yields one multi-row link from every row', async () => {
    // "go " (3) + 33-char URL + "." => wraps from row 0 into row 1
    const url = 'https://example.com/a/very/long/p';
    term.write(`go ${url}.`);
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);

    const provider = new UrlRegexProvider(term);
    const fromRow0 = await provide(provider, 0);
    const fromRow1 = await provide(provider, 1);

    for (const links of [fromRow0, fromRow1]) {
      expect(links?.length).toBe(1);
      expect(links![0].text).toBe(url);
      // Trailing "." trimmed: URL ends at index 3 + 33 - 1 = 35 => row 1, col 15
      expect(links![0].range).toEqual({ start: { x: 3, y: 0 }, end: { x: 15, y: 1 } });
    }

    const detector = (term as any).linkDetector;
    expect((await detector.getLinkAt(18, 0))?.text).toBe(url);
    expect((await detector.getLinkAt(2, 1))?.text).toBe(url);
    expect(await detector.getLinkAt(16, 1)).toBeUndefined();
  });

  test('hard line breaks are not joined', async () => {
    // Row 0-1: soft-wrapped URL, then a hard line break before "hijk" on row 2
    term.write('https://example.com/abcdefg\r\nhijk');
    const provider = new UrlRegexProvider(term);
    const links = await provide(provider, 0);
    expect(links?.[0].text).toBe('https://example.com/abcdefg');
    expect(links?.[0].range.end).toEqual({ x: 6, y: 1 });
    expect(await provide(provider, 2)).toBeUndefined();
  });
});
