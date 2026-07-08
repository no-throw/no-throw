const path=require("path"), ts=require("typescript"), fs=require("fs");
const SRC=path.join(__dirname,"src","big");
const files=fs.readdirSync(SRC).filter(f=>f.endsWith(".ts")).map(f=>path.join(SRC,f));
const hr=()=>Number(process.hrtime.bigint())/1e6;
const program=ts.createProgram(files,{strict:true,target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,skipLibCheck:true});
const checker=program.getTypeChecker();
const sfs=program.getSourceFiles().filter(s=>s.fileName.includes("big"));

function fnsOf(sf){ const out=[]; ts.forEachChild(sf,function v(n){ if(ts.isFunctionDeclaration(n)&&n.name)out.push(n); ts.forEachChild(n,v);}); return out; }
function analyze(memo){
  let visits=0, resolves=0;
  const inProg=new Set();
  function declThrows(decl){
    if(memo.has(decl))return memo.get(decl);
    if(inProg.has(decl))return false;
    inProg.add(decl); visits++;
    let throws=false;
    if(decl.body)(function walk(n){ if(throws)return;
      if(ts.isThrowStatement(n)){throws=true;return;}
      if(ts.isCallExpression(n)){ resolves++;
        let s=checker.getSymbolAtLocation(n.expression);
        if(s&&(s.flags&ts.SymbolFlags.Alias)){try{s=checker.getAliasedSymbol(s);}catch(e){}}
        const d=s&&(s.getDeclarations()||[]).find(ts.isFunctionDeclaration);
        if(d&&declThrows(d))throws=true;
      } ts.forEachChild(n,walk);})(decl.body);
    inProg.delete(decl); memo.set(decl,throws); return throws;
  }
  return {declThrows, stats:()=>({visits,resolves})};
}

// Mode A: one global memo across the whole run (module-level cache in the rule file)
let a=analyze(new Map()); let t=hr();
for(const sf of sfs) for(const d of fnsOf(sf)) a.declThrows(d);
const A={ms:+(hr()-t).toFixed(1), ...a.stats()};

// Mode B: memo reset per file (simulates ESLint per-file rule with NO cross-file persistence)
t=hr(); let bv=0,br=0;
for(const sf of sfs){ const b=analyze(new Map()); for(const d of fnsOf(sf)) b.declThrows(d); const s=b.stats(); bv+=s.visits; br+=s.resolves; }
const B={ms:+(hr()-t).toFixed(1), visits:bv, resolves:br};

console.log(JSON.stringify({
  modeA_globalMemo: A,
  modeB_perFileMemo_noPersistence: B,
  blowupFactor_visits: +(B.visits/A.visits).toFixed(1),
  blowupFactor_time: +(B.ms/A.ms).toFixed(1),
},null,2));
