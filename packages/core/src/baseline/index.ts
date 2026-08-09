/**
 * The baseline surface. The engine's main entry point re-exports the parts it
 * needs — the lookup, the keys, the condition-path grammar. What lives only
 * here is *generation*: building a lib-only `ts.Program`, walking it for an
 * inventory, and the type domains a verdict is discharged against. Only
 * maintainer-side tooling drives those, but they belong in `core` all the same,
 * because generation reuses the checker-backed judgments the engine makes at a
 * call site.
 */
export { createLibProgram } from "./program.js";
export type { LibProgram } from "./program.js";
export { collectLibMembers } from "./inventory.js";
export type { LibMember, LibParam, MemberKind } from "./inventory.js";
export { collectDomMembers } from "./dom-inventory.js";
export type { DomInventory, DomMember } from "./dom-inventory.js";
export { TypeDomains } from "./domains.js";
export { CALL_SEGMENT, CONSTRUCT_SEGMENT } from "../segments.js";
export {
  libTargetOfFileName,
  memberKey,
  staticMemberKey,
  symbolMemberName,
} from "./keys.js";
export { formatConditionPath, parseConditionPath } from "./paths.js";
export type { ParsedConditionPath, PathSegment } from "./paths.js";
export {
  baselineData,
  lookupBaselineEntry,
  sourceOfLibTarget,
} from "./data.js";
export type { BaselineSource } from "./data.js";
export type {
  AccessorColors,
  AccessorFact,
  BaselineData,
  BaselineEntry,
  BaselineLib,
  Color,
  ConditionPath,
} from "./types.js";
