'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIRECTORIES = ['adapters','backends','godot','lib','library','providers','schema','test','tools','workers'];
const ROOT_FILES = ['README.md','AGENT-OPERATIONS.md','RELEASE.md','LICENSE','.gitignore','cli.js','config/tools.example.json','release/README.md','release/ACCEPTANCE.md'];
const EXCLUDED = new Set(['.git','.godot','bin','obj','node_modules','__pycache__','.pytest_cache','.mypy_cache','.devtools','.leases','jobs','evidence','exports','outputs','captures','generated','coverage','.nyc_output','tmp','.tmp','temp']);
const SOURCE_EXTENSIONS = new Set(['.js','.cjs','.mjs','.json','.gd','.py','.cs','.csproj','.tscn','.tres','.md','.ps1','.txt']);
const LOCAL_CONFIG = /(?:^local\.|\.local(?:\.|$))/i;
const MAX_FILES=20000, MAX_FILE_BYTES=16*1024*1024, MAX_BYTES=128*1024*1024;

function absolute(value,name) {
  if(typeof value!=='string'||!value||value.includes('\0')||!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  if(value.split(/[\\/]/).includes('..')) throw new Error(`${name} must not contain traversal`);
  return path.resolve(value);
}
function ancestors(target) {
  for(let p=target;;p=path.dirname(p)) {
    const stat=fs.lstatSync(p,{throwIfNoEntry:false});
    if(stat) { if(stat.isSymbolicLink()) throw new Error(`Linked path refused: ${p}`); if(p!==target&&!stat.isDirectory()) throw new Error(`Ancestor is not a directory: ${p}`); }
    if(path.dirname(p)===p) break;
  }
}
function contains(a,b) { const r=path.relative(a,b); return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)); }
function stageSource({sourceRoot=path.resolve(__dirname,'../..'),outputRoot}={}) {
  sourceRoot=absolute(sourceRoot,'sourceRoot'); outputRoot=absolute(outputRoot,'outputRoot');
  if(contains(sourceRoot,outputRoot)||contains(outputRoot,sourceRoot)) throw new Error('Source and output overlap');
  ancestors(sourceRoot); ancestors(outputRoot);
  if(fs.existsSync(outputRoot)) throw new Error('Output already exists');
  if(!fs.statSync(sourceRoot).isDirectory()) throw new Error('Source root must be a directory');
  const selected=[]; let total=0;
  function add(relative,destination,required=false) {
    const file=path.join(sourceRoot,relative); ancestors(file);
    if(!fs.existsSync(file)) { if(required) throw new Error(`Missing required source: ${relative}`); return; }
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()) throw new Error(`Linked source refused: ${relative}`);
    if(!stat.isFile()) throw new Error(`Source must be a regular file: ${relative}`);
    total+=stat.size;
    if(stat.size>MAX_FILE_BYTES||total>MAX_BYTES||selected.length>=MAX_FILES) throw new Error('Source candidate exceeds bounds');
    selected.push({source:file,path:destination,bytes:stat.size});
  }
  function walk(relative) {
    const dir=path.join(sourceRoot,relative);
    if(!fs.existsSync(dir)) return;
    ancestors(dir);
    if(!fs.statSync(dir).isDirectory()) throw new Error(`Source directory required: ${relative}`);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const rel=relative+'/'+entry.name;
      // Refuse links even if their names would otherwise be excluded.
      if(fs.lstatSync(path.join(sourceRoot,rel)).isSymbolicLink()) throw new Error(`Linked source refused: ${rel}`);
      if(entry.name.startsWith('.')||LOCAL_CONFIG.test(entry.name)||EXCLUDED.has(entry.name.toLowerCase())||(entry.isDirectory()&&(entry.name.startsWith('runtime-')||entry.name.startsWith('stage-')||/^tmp[a-z0-9_]{6,}$/i.test(entry.name)))) continue;
      if(entry.isDirectory()) walk(rel);
      else if(SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) add(rel,rel);
    }
  }
  add('.coverage-thresholds.json','.coverage-thresholds.json',true);
  add('character-pipeline/release/README.md','README.md',true);
  add('character-pipeline/LICENSE','LICENSE',true);
  for(const file of ROOT_FILES) add('character-pipeline/'+file,'character-pipeline/'+file,true);
  for(const dir of DIRECTORIES) walk('character-pipeline/'+dir);
  selected.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const files=[];
  // The exclusive mkdir owns only this new directory. Failure leaves it in place
  // for inspection; never recursively delete an output or its source.
  fs.mkdirSync(outputRoot);
  try {
    for(const item of selected) {
      ancestors(item.source);
      const fd=fs.openSync(item.source,fs.constants.O_RDONLY| (fs.constants.O_NOFOLLOW||0));
      let bytes;
      try { const stat=fs.fstatSync(fd); if(!stat.isFile()||stat.size!==item.bytes) throw new Error('Source changed during staging'); bytes=fs.readFileSync(fd); }
      finally { fs.closeSync(fd); }
      if(bytes.length!==item.bytes) throw new Error('Source changed during staging');
      ancestors(outputRoot);
      const target=path.join(outputRoot,item.path);
      fs.mkdirSync(path.dirname(target),{recursive:true}); ancestors(path.dirname(target));
      fs.writeFileSync(target,bytes,{flag:'wx'});
      files.push({path:item.path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    }
    const result={formatVersion:1,files};
    fs.writeFileSync(path.join(outputRoot,'source-inventory.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    return result;
  } catch(error) { throw new Error(`Staging failed; owned partial candidate retained at ${outputRoot}: ${error.message}`,{cause:error}); }
}
function main(args) {
  if(args.length!==2||args[0]!=='--out') throw new Error('Usage: node tools/stage-source.js --out ABSOLUTE_OUTPUT');
  const result=stageSource({outputRoot:args[1]});
  process.stdout.write(JSON.stringify({outputRoot:path.resolve(args[1]),files:result.files.length})+'\n');
}
if(require.main===module) { try { main(process.argv.slice(2)); } catch(error) { process.stderr.write(error.message+'\n'); process.exitCode=1; } }
module.exports={stageSource};
