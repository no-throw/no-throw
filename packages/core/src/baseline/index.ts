/**
 * The baseline generation surface. Kept off the engine's main entry point
 * because only maintainer-side tooling drives it — but kept *in* `core`,
 * because generation runs inside a live `ts.Program` and reuses the same
 * checker-backed judgments the engine makes at a call site.
 */
export { createLibProgram } from "./program.js";
export type { LibProgram } from "./program.js";
export { collectLibMembers } from "./inventory.js";
export type { LibMember, LibParam, MemberKind } from "./inventory.js";
export { TypeDomains } from "./domains.js";
export {
  globalKey,
  libTargetOfFileName,
  memberKey,
  symbolMemberName,
} from "./keys.js";
export { formatConditionPath, parseConditionPath } from "./paths.js";
export type { ParsedConditionPath, PathSegment } from "./paths.js";
export { baselineData, lookupBaselineEntry } from "./data.js";
export type {
  AccessorColors,
  AccessorFact,
  BaselineData,
  BaselineEntry,
  BaselineLib,
  Color,
  ConditionPath,
} from "./types.js";
