const path=require("path"), ts=require("typescript"), fs=require("fs");
const SRC=path.join(__dirname,"src","big");
const files=fs.readdirSync(SRC).filter(f=>f.endsWith(".ts")).map(f=>path.join(SRC,f));

function hr(){ return Number(process.hrtime.bigint())/1e6; }
const t0=hr();
const opts={strict:true, target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.CommonJS, skipLibCheck:true};
const program=ts.createProgram(files, opts);
const checker=program.getTypeChecker();
const tProgram=hr();

// collect all function declarations
const fnDecls=[];
for(const sf of program.getSourceFiles()){
  if(sf.fileName.includes("node_modules")||!sf.fileName.includes("big"))continue;
  ts.forEachChild(sf, function v(n){ if(ts.isFunctionDeclaration(n)&&n.name) fnDecls.push(n); ts.forEachChild(n,v); });
}

// transitive throws analysis, memoized by declaration node
const memo=new Map(); // decl -> boolean
const inProgress=new Set();
let visits=0, resolveCalls=0;

function declThrows(decl){
  if(memo.has(decl)) return memo.get(decl);
  if(inProgress.has(decl)) return false; // cycle: assume non-throwing to break
  inProgress.add(decl); visits++;
  let throws=false;
  const body=decl.body;
  if(body){
    (function walk(n){
      if(throws) return;
      // uncaught throw: a ThrowStatement not lexically inside a try-with-catch
      if(ts.isThrowStatement(n)){
        if(!enclosedByCatchingTry(n, decl)) throws=true; return;
      }
      if(ts.isCallExpression(n)){
        resolveCalls++;
        const sym=checker.getSymbolAtLocation(n.expression);
        let s=sym;
        if(s && (s.flags & ts.SymbolFlags.Alias)){ try{ s=checker.getAliasedSymbol(s);}catch(e){} }
        const d=s && (s.getDeclarations()||[]).find(ts.isFunctionDeclaration);
        if(d){ if(declThrows(d)){ // if the call is itself inside a catching try, it's bridged
            if(!enclosedByCatchingTry(n, decl)) throws=true; } }
      }
      ts.forEachChild(n, walk);
    })(body);
  }
  inProgress.delete(decl);
  memo.set(decl, throws);
  return throws;
}
function enclosedByCatchingTry(node, stop){
  let p=node.parent;
  while(p && p!==stop.parent){
    if(ts.isTryStatement(p) && p.catchClause){
      // ensure node is within try block, not catch/finally
      if(p.tryBlock && posContains(p.tryBlock, node)) return true;
    }
    p=p.parent;
  }
  return false;
}
function posContains(a,b){ return b.getStart()>=a.getStart() && b.getEnd()<=a.getEnd(); }

const tA0=hr();
let throwing=0;
for(const d of fnDecls){ if(declThrows(d)) throwing++; }
const tA1=hr();

console.log(JSON.stringify({
  files: files.length,
  functions: fnDecls.length,
  throwingFunctions: throwing,
  ms_createProgram_and_checker: +(tProgram-t0).toFixed(1),
  ms_full_transitive_analysis: +(tA1-tA0).toFixed(1),
  memoizedDeclVisits: visits,
  callResolutions: resolveCalls,
  heapUsedMB: +(process.memoryUsage().heapUsed/1048576).toFixed(0),
}, null, 2));
