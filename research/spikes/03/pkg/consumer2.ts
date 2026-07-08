import { readConfigSafe, parseIntSafe, mustParse } from "./lib";
const a = readConfigSafe("x");   // branded, cross-.d.ts
const b = parseIntSafe("12");    // jsdoc @nothrow, cross-.d.ts
const c = mustParse("12");       // throwing
export { a, b, c };
