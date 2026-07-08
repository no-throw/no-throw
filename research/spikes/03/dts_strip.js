const ts=require("typescript"), path=require("path");
const SRC=path.join(__dirname,"src","lib.ts");
function emit(removeComments){
  const out={};
  const prog=ts.createProgram([SRC],{declaration:true,emitDeclarationOnly:true,strict:true,
    target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,removeComments});
  prog.emit(undefined,(f,d)=>{out[path.basename(f)]=d;});
  const dts=out["lib.d.ts"]||"";
  return { nothrowSurvives:/@nothrow/.test(dts), brandSurvives:/NOTHROW/.test(dts) };
}
console.log(JSON.stringify({
  default_removeComments_false: emit(false),
  removeComments_true: emit(true),
},null,2));
