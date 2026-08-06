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
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { file, line, column, endLine, endColumn, messageId, message } =
    diagnostic;
  const at = `${file}:${line}:${column}-${endLine}:${endColumn}`;
  return message === undefined
    ? `${at}  ${messageId}`
    : `${at}  ${messageId}  ${JSON.stringify(message)}`;
}

/** An expectation that omits `message` does not constrain the text. */
function matches(expected: Diagnostic, actual: Diagnostic): boolean {
  return (
    expected.file === actual.file &&
    expected.line === actual.line &&
    expected.column === actual.column &&
    expected.endLine === actual.endLine &&
    expected.endColumn === actual.endColumn &&
    expected.messageId === actual.messageId &&
    (expected.message === undefined || expected.message === actual.message)
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
