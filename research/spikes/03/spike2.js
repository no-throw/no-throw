const path=require("path"), ts=require("typescript"), fs=require("fs");
const parser=require("@typescript-eslint/parser");
const dir=path.join(__dirname,"pkg");
const { ast, services } = parser.parseForESLint(
  fs.readFileSync(path.join(dir,"consumer2.ts"),"utf8"),
  { filePath: path.join(dir,"consumer2.ts"), project: path.join(dir,"tsconfig.json"),
    tsconfigRootDir: dir, sourceType:"module", range:true, loc:true, comment:true });
const checker = services.program.getTypeChecker();
const tsNodeOf=(n)=>services.esTreeNodeToTSNodeMap.get(n);

const calls=[];
(function walk(n){ if(!n||typeof n.type!=="string")return;
  if(n.type==="CallExpression")calls.push(n);
  for(const k of Object.keys(n)){ if(k==="parent")continue; const v=n[k];
    if(Array.isArray(v))v.forEach(c=>c&&c.type&&walk(c)); else if(v&&typeof v.type==="string")walk(v);} })(ast);

const out = calls.map(node=>{
  const tsCall=tsNodeOf(node);
  const expr=tsCall.expression;
  let sym=checker.getSymbolAtLocation(expr);
  let aliasResolved=false, aliasedTags=[], directTags=[];
  if(sym){
    directTags=sym.getJsDocTags(checker).map(t=>t.name);
    // resolve import alias -> original declaration symbol
    if(sym.flags & ts.SymbolFlags.Alias){
      try{ const orig=checker.getAliasedSymbol(sym); aliasResolved=true;
        aliasedTags=orig.getJsDocTags(checker).map(t=>t.name); }catch(e){}
    }
  }
  const t=checker.getTypeAtLocation(expr);
  const sig=checker.getSignaturesOfType(t, ts.SignatureKind.Call)[0];
  const rt=sig?checker.getReturnTypeOfSignature(sig):null;
  let hasBrand=false;
  if(rt) for(const p of (rt.getProperties()||[])) if(String(p.escapedName).includes("NOTHROW"))hasBrand=true;
  const decl=sym&&(sym.getDeclarations()||[])[0];
  return {
    callee: expr.getText(),
    resolvedDeclFile: decl?path.basename(decl.getSourceFile().fileName):null,
    returnType: rt?checker.typeToString(rt):null,
    hasBrandProp: hasBrand,
    directTags, aliasResolved, aliasedTags,
  };
});
console.log(JSON.stringify(out,null,2));
