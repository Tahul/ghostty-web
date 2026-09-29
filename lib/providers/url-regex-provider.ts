/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using regex pattern matching.
 * Supports common protocols but excludes file paths.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { IBufferCellPosition, ILink, ILinkProvider } from '../types';
import { type ITerminalWithLinkHandler, createBuiltinLink } from './builtin-link';

/**
 * URL Regex Provider
 *
 * Detects plain text URLs using regex. Soft-wrapped lines (rows whose
 * successors have `isWrapped === true`) are joined into one logical line, so
 * a URL wrapped across rows yields a single multi-row link. Does not detect
 * file paths.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Matches common protocols followed by valid URL characters
   * Excludes file paths (no ./ or ../ or bare /)
   */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%]+/gi;

  /**
   * Characters to strip from end of URLs
   * Common punctuation that's unlikely to be part of the URL
   */
  private static readonly TRAILING_PUNCTUATION = /[.,;!?)\]]+$/;

  /**
   * Upper bound on rows joined into one logical line (guards against
   * pathological wrap chains)
   */
  private static readonly MAX_WRAPPED_ROWS = 64;

  constructor(private terminal: ITerminalForUrlProvider) {}

  /**
   * Provide all regex-detected URLs touching the given row
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const links: ILink[] = [];
    const buffer = this.terminal.buffer.active;

    const line = buffer.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }

    // Expand to the logical line: walk back while the current row continues
    // the previous one, and forward while the next row continues this one
    const maxRows = UrlRegexProvider.MAX_WRAPPED_ROWS;
    let startY = y;
    let current = line;
    while (current.isWrapped && startY > 0 && y - startY < maxRows) {
      const prev = buffer.getLine(startY - 1);
      if (!prev) break;
      startY--;
      current = prev;
    }
    let endY = y;
    while (endY - startY < maxRows) {
      const next = buffer.getLine(endY + 1);
      if (!next?.isWrapped) break;
      endY++;
    }

    // Build the logical line text plus a map from UTF-16 index to cell position
    let text = '';
    const positions: IBufferCellPosition[] = [];
    for (let row = startY; row <= endY; row++) {
      const rowLine = row === y ? line : buffer.getLine(row);
      if (!rowLine) break;
      text += this.lineToText(rowLine, row, positions);
    }

    // Reset regex state (global flag maintains state)
    UrlRegexProvider.URL_REGEX.lastIndex = 0;

    // Find all URL matches in the logical line
    let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(text);
    while (match !== null) {
      // Strip trailing punctuation
      const url = match[0].replace(UrlRegexProvider.TRAILING_PUNCTUATION, '');

      // Skip if URL is too short (e.g., just "http://")
      if (url.length > 8) {
        const start = positions[match.index];
        const end = positions[match.index + url.length - 1]; // Inclusive end

        // Only report links that touch the requested row
        if (start.y <= y && end.y >= y) {
          links.push(
            createBuiltinLink(this.terminal, url, {
              start: { x: start.x, y: start.y },
              end: { x: end.x, y: end.y },
            })
          );
        }
      }

      // Get next match
      match = UrlRegexProvider.URL_REGEX.exec(text);
    }

    callback(links.length > 0 ? links : undefined);
  }

  /**
   * Convert a buffer line to plain text, recording the cell position of every
   * UTF-16 code unit in `positions`
   */
  private lineToText(
    line: IBufferLineForUrlProvider,
    y: number,
    positions: IBufferCellPosition[]
  ): string {
    const chars: string[] = [];

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const codepoint = cell ? cell.getCodepoint() : 0;
      // Skip null characters and control characters
      const char = codepoint < 32 ? ' ' : String.fromCodePoint(codepoint);
      chars.push(char);
      for (let i = 0; i < char.length; i++) {
        positions.push({ x, y });
      }
    }

    return chars.join('');
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export interface ITerminalForUrlProvider extends ITerminalWithLinkHandler {
  buffer: {
    active: {
      getLine(y: number): IBufferLineForUrlProvider | undefined;
    };
  };
}

/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
  length: number;
  /** Whether this row continues the previous one (soft wrap) */
  isWrapped?: boolean;
  getCell(x: number):
    | {
        getCodepoint(): number;
      }
    | undefined;
}
