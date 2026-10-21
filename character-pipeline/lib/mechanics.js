'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {hashValue,resolveContained} = require('./assets');
const TEXT = new Set(['.cs','.json','.gd','.md','.txt','.tscn','.tres','.csv','.yaml','.yml','.xml']);
const DEFAULTS = {maxFiles:256,maxTotalBytes:16*1024*1024,maxFileBytes:2*1024*1024,maxEvidence:2000,maxExcerptBytes:16*1024,maxMechanics:1000};
function fail(message) { return Object.assign(new Error(message),{code:'INVALID_MECHANICS'}); }
function string(value,label) {
  if(typeof value!=='string'||!value.trim()||value.length>2048||/[\x00-\x1f]/.test(value)) throw fail(`Invalid ${label}`);
  return value;
}
function fields(value,allowed,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(k=>!allowed.includes(k))) throw fail(`Invalid ${label} fields`);
}
function digest(bytes) {return crypto.createHash('sha256').update(bytes).digest('hex');}
async function inspectMechanics(input) {
  fields(input,['characterId','sourceRoots','mechanics','limits'],'inspection');
  const characterId=string(input.characterId,'characterId');
  fields(input.limits||{},Object.keys(DEFAULTS),'limits');
  const limits={...DEFAULTS,...input.limits};
  for(const [key,value] of Object.entries(limits)) if(!Number.isSafeInteger(value)||value<0||value>DEFAULTS[key]) throw fail(`Invalid ${key}`);
  if(!Array.isArray(input.sourceRoots)||!input.sourceRoots.length||input.sourceRoots.length>32||!Array.isArray(input.mechanics)||input.mechanics.length>limits.maxMechanics) throw fail('Invalid source roots or mechanic count');
  const roots=[];
  for(const root of input.sourceRoots) {
    string(root,'source root');if(!path.isAbsolute(root)) throw fail('Source roots must be absolute');
    const absolute=path.resolve(root);
    // Check every ancestor as well as the root: an alias through a junction is not a trusted root.
    let current=path.parse(absolute).root;
    try {
      for(const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current=path.join(current,component);const stat=await fs.lstat(current);
        if(stat.isSymbolicLink()) throw fail('Linked source roots are forbidden');
      }
      if(!(await fs.stat(absolute)).isDirectory()) throw fail('Source root must be a directory');
      roots.push(await fs.realpath(absolute));
    } catch(error) {throw fail(`Invalid source root: ${error.message}`);}
  }
  roots.sort();if(new Set(roots).size!==roots.length) throw fail('Duplicate source roots');
  if(roots.some((root,index)=>roots.some((other,j)=>j!==index&&root.startsWith(other+path.sep)))) throw fail('Overlapping source roots');
  const sourceFiles=[], membership=[], texts=new Map(), diagnostics=[];
  let total=0,count=0,entriesVisited=0;
  async function walk(root,relative='') {
    const directory=relative?await resolveContained(root,relative):root;
    const entries=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const entry of entries) {
      if(++entriesVisited>4096) throw fail('Source directory entry limit exceeded');
      const rel=relative?`${relative}/${entry.name}`:entry.name;
      const absolute=await resolveContained(root,rel);
      const stat=await fs.lstat(absolute);
      if(stat.isDirectory()) {membership.push({path:absolute,type:'directory'});await walk(root,rel);continue;}
      if(!stat.isFile()) throw fail('Special source files are forbidden');
      if(++count>limits.maxFiles||stat.size>limits.maxFileBytes||(total+=stat.size)>limits.maxTotalBytes) throw fail('Source size limit exceeded');
      const handle=await fs.open(absolute,'r');let bytes;
      try {
        const buffer=Buffer.alloc(Math.min(stat.size+1,limits.maxFileBytes+1));let offset=0;
        while(offset<buffer.length) {const read=await handle.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
        bytes=buffer.subarray(0,offset);const after=await handle.stat();
        if(bytes.length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino) throw fail('Source changed during inspection');
      } finally {await handle.close();}
      if(bytes.length>limits.maxFileBytes) throw fail('Source size limit exceeded');
      const hash=digest(bytes);sourceFiles.push({path:absolute,hash});membership.push({path:absolute,type:'file',hash});
      if(!TEXT.has(path.extname(absolute).toLowerCase())) {diagnostics.push({code:'SKIPPED_BINARY',path:absolute,message:'File hashed for invalidation; unsupported source extension is not interpreted.'});continue;}
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail(`Source is not UTF-8: ${absolute}`);}
      if(text.includes('\0')) throw fail(`Binary content in source: ${absolute}`);
      texts.set(absolute,text.replace(/\r\n/g,'\n').split('\n'));
    }
  }
  try {for(const root of roots) await walk(root);}catch(error){if(error.code==='INVALID_MECHANICS')throw error;throw fail(`Unsafe or unreadable source: ${error.message}`);}
  sourceFiles.sort((a,b)=>a.path.localeCompare(b.path));
  const evidence=[], mechanics=[], keys=new Set(), identities=new Set(), evidenceById=new Map();let evidenceCount=0;
  for(const declaration of input.mechanics) {
    fields(declaration,['key','modId','modelSymbol','evidence'],'mechanic');
    const key=string(declaration.key,'mechanic key'),modId=string(declaration.modId,'mod ID'),modelSymbol=string(declaration.modelSymbol,'model symbol');
    const identity=hashValue({modId,modelSymbol});
    if(keys.has(key)||identities.has(identity)) throw fail('Duplicate mechanic key or mod/model identity');
    keys.add(key);identities.add(identity);
    if(!Array.isArray(declaration.evidence)||!declaration.evidence.length) throw fail('Mechanic evidence required');
    const evidenceIds=[];let modelProven=false;
    for(const item of declaration.evidence) {
      if(++evidenceCount>limits.maxEvidence) throw fail('Evidence count limit exceeded');
      fields(item,['path','symbol','lineStart','lineEnd'],'evidence');
      const filename=path.resolve(string(item.path,'evidence path')),symbol=string(item.symbol,'evidence symbol');
      if(!path.isAbsolute(item.path)) throw fail('Evidence paths must be absolute');
      const lines=texts.get(filename);
      if(!lines||!Number.isSafeInteger(item.lineStart)||!Number.isSafeInteger(item.lineEnd)||item.lineStart<1||item.lineEnd<item.lineStart||item.lineEnd>lines.length) throw fail('Missing source or invalid evidence range');
      const excerpt=lines.slice(item.lineStart-1,item.lineEnd).join('\n');
      if(Buffer.byteLength(excerpt)>limits.maxExcerptBytes||!excerpt.includes(symbol)) throw fail('Evidence excerpt too large or symbol absent');
      if(symbol===modelSymbol&&excerpt.includes(modelSymbol)) modelProven=true;
      const hash=sourceFiles.find(file=>file.path===filename).hash;
      const record={path:filename,hash,symbol,lineStart:item.lineStart,lineEnd:item.lineEnd,excerpt};
      const id=hashValue(record);
      if(!evidenceById.has(id)){evidenceById.set(id,true);evidence.push({id,...record});}
      if(!evidenceIds.includes(id)) evidenceIds.push(id);
    }
    if(!modelProven) throw fail('Model symbol requires direct source evidence');
    mechanics.push({key,modId,modelSymbol,evidenceIds:evidenceIds.sort()});
  }
  mechanics.sort((a,b)=>a.key.localeCompare(b.key));evidence.sort((a,b)=>a.id.localeCompare(b.id));
  const fingerprint=hashValue({version:1,characterId,roots,membership,mechanics,evidence});
  return {version:1,characterId,fingerprint,mechanics,evidence,sourceFiles,diagnostics,complete:true};
}
module.exports={inspectMechanics};
