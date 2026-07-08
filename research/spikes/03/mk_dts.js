const ts=require("typescript"), path=require("path"), fs=require("fs");
const SRC=path.join(__dirname,"src");
const opts={declaration:true, emitDeclarationOnly:true, strict:true, target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.CommonJS, outDir:path.join(__dirname,"pkg")};
const prog=ts.createProgram([path.join(SRC,"lib.ts")],opts);
prog.emit();
console.log("emitted:", fs.readdirSync(path.join(__dirname,"pkg")));
