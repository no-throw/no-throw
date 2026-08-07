/** How an unmarked function with a visible body gets its color. */
export type ColorPolicy =
  /** Read the body: inference is on, which is what ships. */
  | "hybrid"
  /** Unmarked is throwing, full stop. */
  | "declare";

/**
 * #4's rip-out lever, deliberately maintainer-internal: it is not a rule
 * option, not part of any package's API, and nothing a consumer's config can
 * reach — the user-facing option count stays zero. Set it to `declare` and the
 * tool degrades to pure declare, which is strictly tightening and never
 * unsound, and is the documented answer to a pre-release perf failure.
 *
 * A process-wide read is what keeps it off the API. Threading the policy in as
 * a parameter would put it on `createColorResolver`, then on `analyzeSourceFile`,
 * then in front of the adapters — which is the rule option the design rules out.
 * It is read when a resolver is built, never captured at module load, so one
 * process can analyze under both policies.
 */
export function colorPolicy(): ColorPolicy {
  return process.env["NOTHROW_COLOR_POLICY"] === "declare"
    ? "declare"
    : "hybrid";
}
