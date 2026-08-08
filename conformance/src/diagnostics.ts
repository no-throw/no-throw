/**
 * An offered edit, as the reader would see it: the label an editor puts in the
 * suggestion list, and the file that accepting it produces. The whole file is
 * the assertion because a suggestion is only correct in place — a bridge that
 * wraps the wrong statement, or one that reaches around a callback, is the
 * exact mistake the rule exists to report, and only the result shows it.
 *
 * Line by line, so the expectation reads as code rather than as one escaped
 * string, and a failure diffs where a reader can see it.
 */
export interface Suggestion {
  readonly desc: string;
  readonly output: readonly string[];
}

/**
 * The one currency of the suite: a diagnostic at a place in a fixture. Nothing
 * else about the implementation is observable here, and nothing else should be.
 */
export interface Diagnostic {
  /** Slash-separated, relative to the fixture root. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly messageId: string;
  /** Asserted only where the spec makes the text normative. */
  readonly message?: string;
  /**
   * What the diagnostic offers to do about itself, in the order offered. The
   * driver always reports this; an expectation that omits it does not
   * constrain the offer, and an empty list asserts there is none.
   */
  readonly suggestions?: readonly Suggestion[];
}

/** Where a diagnostic landed, with nothing about what it said. */
export function placeOf(diagnostic: Diagnostic): string {
  const { file, line, column, endLine, endColumn } = diagnostic;
  return `${file}:${line}:${column}-${endLine}:${endColumn}`;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { messageId, message, suggestions } = diagnostic;
  const at = placeOf(diagnostic);
  const head =
    message === undefined
      ? `${at}  ${messageId}`
      : `${at}  ${messageId}  ${JSON.stringify(message)}`;
  return [head, ...(suggestions ?? []).flatMap(formatSuggestion)].join("\n  ");
}

function formatSuggestion(suggestion: Suggestion): string[] {
  return [
    `suggests ${JSON.stringify(suggestion.desc)}, producing:`,
    ...suggestion.output.map((line) => `  | ${line}`),
  ];
}

/**
 * An expectation that omits `message` does not constrain the text, and one
 * that omits `suggestions` does not constrain the offer.
 */
function matches(expected: Diagnostic, actual: Diagnostic): boolean {
  return (
    expected.file === actual.file &&
    expected.line === actual.line &&
    expected.column === actual.column &&
    expected.endLine === actual.endLine &&
    expected.endColumn === actual.endColumn &&
    expected.messageId === actual.messageId &&
    (expected.message === undefined || expected.message === actual.message) &&
    (expected.suggestions === undefined ||
      sameSuggestions(expected.suggestions, actual.suggestions ?? []))
  );
}

function sameSuggestions(
  expected: readonly Suggestion[],
  actual: readonly Suggestion[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((want, index) => {
      const got = actual[index];
      return (
        got !== undefined &&
        want.desc === got.desc &&
        want.output.length === got.output.length &&
        want.output.every((line, at) => line === got.output[at])
      );
    })
  );
}

export interface Mismatch {
  /** Expected, but not reported. */
  readonly missing: readonly Diagnostic[];
  /** Reported, but not expected. */
  readonly unexpected: readonly Diagnostic[];
}

export function compare(
  expected: readonly Diagnostic[],
  actual: readonly Diagnostic[],
): Mismatch {
  const remaining = [...actual];
  const missing: Diagnostic[] = [];

  for (const want of expected) {
    const index = remaining.findIndex((got) => matches(want, got));
    if (index === -1) missing.push(want);
    else remaining.splice(index, 1);
  }

  return { missing, unexpected: remaining };
}

export function byPosition(a: Diagnostic, b: Diagnostic): number {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn ||
    a.messageId.localeCompare(b.messageId)
  );
}
