/**
 * The slice of oxlint's JS-plugin surface this adapter touches, stated
 * structurally rather than imported. oxlint hands the plugin these objects at
 * runtime — nothing here resolves the `oxlint` package — so a type dependency
 * would pin consumers to a `.d.ts` they never load, and the shapes below are
 * held to the real host by the conformance suite, which runs the real binary.
 *
 * Lines are one-based and columns zero-based, which is oxlint's convention and
 * ESLint's alike.
 */

export interface HostPosition {
  readonly line: number;
  readonly column: number;
}

export interface HostLocation {
  readonly start: HostPosition;
  readonly end: HostPosition;
}

export interface HostFix {
  readonly range: [number, number];
  readonly text: string;
}

export interface HostFixer {
  replaceTextRange(range: [number, number], text: string): HostFix;
}

export interface HostSuggestion {
  readonly messageId: string;
  readonly fix: (fixer: HostFixer) => HostFix;
}

export interface HostDiagnostic {
  readonly loc: HostLocation;
  readonly messageId: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly suggest?: readonly HostSuggestion[];
}

export interface HostContext {
  /** Absolute path of the file being linted. */
  readonly filename: string;
  readonly cwd: string;
  readonly sourceCode: { readonly text: string };
  report(diagnostic: HostDiagnostic): void;
}

export interface HostRule {
  readonly meta: {
    readonly type: "problem";
    readonly docs: { readonly description: string };
    readonly hasSuggestions?: boolean;
    readonly messages: Readonly<Record<string, string>>;
  };
  create(context: HostContext): { Program?: () => void };
}
