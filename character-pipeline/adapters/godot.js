'use strict';
// Planning only: immutable compiler-owned captures in, namespaced runtime captures out.
// Dynamic dependencies must be declared; their runtime values must already use the
// returned namespace. This does not create a PCK or certify a game package.
const crypto=require('node:crypto');
const {proveAudioResource}=require('../lib/native-audio-resources');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(new Error(message),{code:'INVALID_GODOT_RUNTIME'});
function safePath(value){
 if(typeof value!=='string'||!value||value.length>512||/[\\\x00-\x1f:*?"<>|]/.test(value)||value.startsWith('/'))throw fail('Invalid runtime path or namespace');
 if(value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)))throw fail('Invalid runtime path or namespace');
 return value;
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function buildGodotResources({namespace,rootScene='character.tscn',files,dynamicReferences={},maxBytes=256*1024*1024}={},trusted={},rewrite=true,preflight=false){
 if(rewrite)safePath(namespace);safePath(rootScene);
 if(!Array.isArray(files)||files.length>10000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024*1024||!dynamicReferences||typeof dynamicReferences!=='object'||Array.isArray(dynamicReferences))throw fail('Invalid runtime capture budget or declaration');
 const inventory=new Map(),collisions=new Set();let total=0;
 for(const record of files){
  if(!record||typeof record.base64!=='string'||!/^[a-f0-9]{64}$/.test(record.hash))throw fail('Invalid captured resource hash');
  const name=safePath(record.path),key=name.normalize('NFC').toLowerCase();if(collisions.has(key))throw fail('Runtime path collision');collisions.add(key);
  if(record.base64.length>Math.ceil(maxBytes/3)*4+4)throw fail('Runtime capture budget exceeded');
  const bytes=Buffer.from(record.base64,'base64');if(bytes.toString('base64')!==record.base64||digest(bytes)!==record.hash)throw fail('Captured resource hash mismatch');
  total+=bytes.length;if(total>maxBytes)throw fail('Runtime capture budget exceeded');inventory.set(name,{bytes,sourceHash:record.hash});
 }
 let edges=0;
 for(const [name,deps]of Object.entries(dynamicReferences)){
  safePath(name);if(!inventory.has(name)||!Array.isArray(deps)||deps.length>256||new Set(deps).size!==deps.length)throw fail('Invalid dynamic dependency declaration');
  for(const dep of deps)safePath(dep);edges+=deps.length;
 }
 const reached=new Map();let outputBytes=0;
 function visit(name,depth=0){
  if(reached.has(name))return;if(depth>256||++edges>50000)throw fail('Runtime dependency budget exceeded');
  const item=inventory.get(name);if(!item)throw fail('Missing runtime dependency: '+name);
  if(name.split('/').some(p=>/^(tools?|tests?|evidence|editor|source[-_ ]?art|previews?|cache|node_modules|\.git)$/i.test(p))||!/\.(tscn|tres|gd|res|png|wav|ogg)$/.test(name)||/^(compile|spec|project)\./i.test(name.split('/').pop()))throw fail('Development or unsupported runtime dependency: '+name);
  reached.set(name,null);let output=item.bytes,category;const deps=[...(dynamicReferences[name]||[])];
  if(/\.(tscn|tres|gd)$/.test(name)){
   let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(item.bytes);}catch{throw fail('Runtime text must be UTF-8');}
   if(source.includes('\0')||/(?:file|user):\/\/|["'][A-Za-z]:[\\/]/.test(source))throw fail('External runtime resource path');
   const references=[];
   for(const match of source.matchAll(/(["'])res:\/\/([^"'\r\n]*)\1/g)){
    if(++edges>50000)throw fail('Runtime dependency budget exceeded');references.push(match);
   }
   if((source.match(/res:\/\//g)||[]).length!==references.length||references.some(m=>!m[2]||m[2].endsWith('/')))throw fail('Dynamic res:// reference requires a compiled concrete path');
   for(const match of references){safePath(match[2]);deps.push(match[2]);}
   const calls=[...source.matchAll(/\b(?:load|preload)\s*\(([^()\r\n]*)\)/g)];
   if(calls.length!==(source.match(/\b(?:load|preload)\s*\(/g)||[]).length)throw fail('Dynamic complex loads require native reserialization');
   for(const call of calls){
    const argument=call[1].trim(),literal=/^(["'])([^"'\r\n]*)\1$/.exec(argument);
    if(literal){if(!literal[2].startsWith('res://'))throw fail('External or relative resource literal is unsupported');}
    else if(/["']/.test(argument)||!dynamicReferences[name]?.length)throw fail('Dynamic loads require explicit concrete dependency declarations');
   }
   if(/\.(tscn|tres)$/.test(name))for(const line of source.matchAll(/^\[ext_resource\b[^\r\n]*\]/gm)){
    const resourcePath=/\bpath="([^"]*)"/.exec(line[0]);
    if(!resourcePath||!resourcePath[1].startsWith('res://'))throw fail('External or relative scene dependency is unsupported');
   }
   // UIDs are editor-cache identities; fallback paths own this exported closure.
   source=source.replace(/\s+uid="uid:\/\/[^"\r\n]+"/g,'');
   if(source.includes('uid://'))throw fail('External UID-only dependency is unsupported');
   if(rewrite){
    if(Buffer.byteLength(source)+references.length*(Buffer.byteLength(namespace)+1)>maxBytes-outputBytes)throw fail('Rewritten runtime capture budget exceeded');
    output=Buffer.from(source.replace(/(["'])res:\/\/([^"'\r\n]+)\1/g,(_m,quote,relative)=>`${quote}res://${namespace}/${relative}${quote}`));
   }
  }else if(name.endsWith('.res')){
   const proof=proveAudioResource(trusted.audioAuthority,{path:name,hash:item.sourceHash,size:item.bytes.length},rewrite?`${namespace}/${name}`:name);
   if((!preflight&&!proof)||deps.length)throw fail('Binary resource dependencies require native inspection and reserialization');
   if(!preflight)category='audio';
  }
  outputBytes+=output.length;if(outputBytes>maxBytes)throw fail('Rewritten runtime capture budget exceeded');
  reached.set(name,{path:rewrite?`${namespace}/${name}`:name,sourcePath:name,sourceHash:item.sourceHash,hash:digest(output),size:output.length,base64:output.toString('base64'),...(category?{category}:{})});
  for(const dep of deps)visit(dep,depth+1);
 }
 visit(rootScene);
 if(preflight){const files=[...reached.values()].map(f=>({path:f.sourcePath,hash:f.sourceHash,size:inventory.get(f.sourcePath).bytes.length,base64:inventory.get(f.sourcePath).bytes.toString('base64')})).sort((a,b)=>a.path.localeCompare(b.path));return freeze({version:1,kind:'godot-resource-reachability',rootScene,files,binaryResources:files.filter(f=>f.path.endsWith('.res'))});}
 return freeze({version:1,nativeExportStatus:'pending',rootScene:rewrite?`${namespace}/${rootScene}`:rootScene,files:[...reached.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
}
const planGodotResources=(input,trusted)=>buildGodotResources(input,trusted,true);
const validateGodotResourceClosure=(input,trusted)=>buildGodotResources(input,trusted,false);
const inspectGodotResourceReachability=input=>buildGodotResources(input,{},false,true);
module.exports={planGodotResources,validateGodotResourceClosure,inspectGodotResourceReachability};
