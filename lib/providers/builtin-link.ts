/**
 * Shared link construction for the built-in link providers.
 *
 * Routes activation/hover through `terminal.options.linkHandler` when set,
 * falling back to window.open on Ctrl/Cmd+click otherwise.
 */

import type { ILinkHandler } from '../interfaces';
import type { IBufferRange, ILink } from '../types';

/**
 * Minimal terminal interface for reading the link handler option
 */
export interface ITerminalWithLinkHandler {
  options?: {
    linkHandler?: ILinkHandler | null;
  };
}

/**
 * Create an ILink whose behavior is resolved at event time, so changes to
 * `terminal.options.linkHandler` after open() take effect immediately.
 */
export function createBuiltinLink(
  terminal: ITerminalWithLinkHandler,
  text: string,
  range: IBufferRange
): ILink {
  return {
    text,
    range,
    activate: (event) => {
      const handler = terminal.options?.linkHandler;
      if (handler) {
        handler.activate(event, text, range);
        return;
      }
      // Default: open link only if Ctrl/Cmd is pressed
      if (event.ctrlKey || event.metaKey) {
        window.open(text, '_blank', 'noopener,noreferrer');
      }
    },
    hover: (isHovered, event) => {
      const handler = terminal.options?.linkHandler;
      if (!handler || !event) return;
      if (isHovered) {
        handler.hover?.(event, text, range);
      } else {
        handler.leave?.(event, text, range);
      }
    },
  };
}
