const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "src", "big");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const FILES = 40;
const FNS_PER_FILE = 50;   // 2000 functions total
const FANOUT = 3;          // each fn calls up to 3 others

// Each function calls FANOUT lower-indexed functions (global index), forming a DAG.
// One leaf actually throws so "throwing" genuinely propagates through the graph.
function fnName(g) { return `f${g}`; }

for (let fi = 0; fi < FILES; fi++) {
  let out = "";
  // import everything we might call from earlier files
  const imports = new Set();
  const bodies = [];
  for (let li = 0; li < FNS_PER_FILE; li++) {
    const g = fi * FNS_PER_FILE + li;
    const calls = [];
    for (let k = 1; k <= FANOUT; k++) {
      const target = g - k * 7; // deterministic lower index
      if (target >= 0) calls.push(target);
    }
    for (const t of calls) {
      const tf = Math.floor(t / FNS_PER_FILE);
      if (tf !== fi) imports.add(tf);
    }
    let body;
    if (g === 0) {
      body = `export function ${fnName(g)}(): number { throw new Error("leaf"); }`;
    } else if (calls.length === 0) {
      body = `export function ${fnName(g)}(): number { return ${g}; }`;
    } else {
      const expr = calls.map(g=>fnName(g)+"()").join(" + ");
      body = `export function ${fnName(g)}(): number { return ${expr} + 1; }`;
    }
    bodies.push(body);
  }
  for (const imp of [...imports].sort((a,b)=>a-b)) {
    const names = [];
    for (let li = 0; li < FNS_PER_FILE; li++) names.push(fnName(imp * FNS_PER_FILE + li));
    out += `import { ${names.join(", ")} } from "./file${imp}";\n`;
  }
  out += bodies.join("\n") + "\n";
  fs.writeFileSync(path.join(dir, `file${fi}.ts`), out);
}
console.log(`generated ${FILES} files, ${FILES*FNS_PER_FILE} functions in ${dir}`);
