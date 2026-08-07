export { analyzeSourceFile } from "./analyze.js";
export type { Finding } from "./analyze.js";
export { lookupBaselineEntry } from "./baseline/data.js";
export {
  libTargetOfFileName,
  memberKey,
  symbolMemberName,
} from "./baseline/keys.js";
export { formatConditionPath, parseConditionPath } from "./baseline/paths.js";
export type { ParsedConditionPath, PathSegment } from "./baseline/paths.js";
export type {
  AccessorColors,
  AccessorFact,
  BaselineEntry,
  Color,
  ConditionPath,
} from "./baseline/types.js";
export type { FloorReason } from "./colors.js";
export { findMarks } from "./marks.js";
export type { MarkProblem, MarkProblemKind, Marks, Span } from "./marks.js";
