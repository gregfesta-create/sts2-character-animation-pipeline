'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {canonicalJson,hashValue,resolveContained}=require('./assets');
const {assertSpec}=require('./spec');
const fail=(code,message)=>Object.assign(new Error(message),{code});
function freeze(value) {
 if(value && typeof value==='object') { for(const child of Object.values(value))freeze(child);Object.freeze(value); }
 return value;
}
// Validate data before invoking schema recursion; no getters, scripts or loaders.
function boundedData(value) {
 const stack=[[value,0]],seen=new Set();let count=0;
 while(stack.length) {
  const [item,depth]=stack.pop();if(++count>100000 || depth>64)throw fail('QUOTA_EXCEEDED','Specification data exceeds structural bounds.');
  if(item===null || typeof item!=='object') {if(!['string','boolean','number'].includes(typeof item) && item!==null || typeof item==='number'&&!Number.isFinite(item))throw fail('INVALID_SPEC','Expected JSON data.');continue;}
  if(seen.has(item)||![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(item)))throw fail('INVALID_SPEC','Expected acyclic plain JSON data.');seen.add(item);
  for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {if(!Object.hasOwn(descriptor,'value'))throw fail('INVALID_SPEC','Accessors are forbidden.');stack.push([descriptor.value,depth+1]);}
 }
}
async function inspectComponentGraph(parentSpec,options={}) {
 const {sourceRoots,maxSpecs=16,maxDepth=4,maxBytes=64*1024*1024,maxSpecBytes=1024*1024}=options;
 for(const [value,ceiling,min] of [[maxSpecs,16,1],[maxDepth,4,0],[maxBytes,64*1024*1024,1],[maxSpecBytes,1024*1024,1]])if(!Number.isSafeInteger(value)||value<min||value>ceiling)throw fail('INVALID_INPUT','Invalid component graph limit.');
 if(!Array.isArray(sourceRoots)||!sourceRoots.length||sourceRoots.length>32||sourceRoots.some(r=>typeof r!=='string'))throw fail('INVALID_INPUT','Configured source roots are required.');
 const definitionRoots=options.definitionRoots===undefined?sourceRoots:options.definitionRoots;
 if(!Array.isArray(definitionRoots)||!definitionRoots.length||definitionRoots.length>33||definitionRoots.some(r=>typeof r!=='string'||!r))throw fail('INVALID_INPUT','Configured definition roots are required.');
 const canonicalRoots=async values=>[...new Set(await Promise.all(values.map(r=>fs.realpath(r))))];
 const roots=await canonicalRoots(sourceRoots),definitionsRoots=await canonicalRoots(definitionRoots);
 async function resolve(input,base,isSpec=false) {
  const allowedRoots=isSpec?definitionsRoots:roots;
  if(typeof input!=='string'||!input||input.includes('\0')||(!path.isAbsolute(input)&&input.split(/[\\/]/).some(x=>!x||x==='.'||x==='..')))throw fail('UNSAFE_PATH','Invalid component source path.');
  const candidates=base?[path.resolve(base,input)]:path.isAbsolute(input)?[input]:allowedRoots.map(r=>path.resolve(r,input));
  for(const candidate of candidates)for(const root of allowedRoots) {
   const rel=path.relative(root,candidate);if(!rel||path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..'))continue;
   try{return await resolveContained(root,rel);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  throw fail('UNSAFE_PATH','Component source is missing or outside configured roots: '+input);
 }
 let totalBytes=0;const receipts=new Map(),definitions=new Map(),ids=new Map(),active=new Set(),nodes=[],assets=[];
 async function read(file,isSpec) {
  if(receipts.has(file)){const receipt=receipts.get(file);if(receipt.kind!==(isSpec?'spec':'asset'))throw fail('CONFLICTING_SOURCE_PATH','One source path cannot be both a specification and an asset.');return receipt;}
  const handle=await fs.open(file,constants.O_RDONLY|(process.platform==='win32'?0:(constants.O_NOFOLLOW||0)));
  try {
   const stat=await handle.stat({bigint:true});if(!stat.isFile())throw fail('INVALID_INPUT','Component source must be a regular file.');
   async function verify() {
    for(const root of (isSpec?definitionsRoots:roots))if(await fs.realpath(root)!==root || (await fs.lstat(root)).isSymbolicLink())throw fail('UNSAFE_PATH','Source root changed during capture.');
    if(await resolve(file,null,isSpec)!==file)throw fail('UNSAFE_PATH','Source containment changed during capture.');
    const current=await fs.lstat(file,{bigint:true}),opened=await handle.stat({bigint:true});
    if(current.isSymbolicLink())throw fail('UNSAFE_PATH','Source became a link during capture.');
    if(current.dev!==stat.dev||current.ino!==stat.ino||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size||opened.mtimeNs!==stat.mtimeNs||opened.ctimeNs!==stat.ctimeNs)throw fail('SOURCE_CHANGED','Source identity changed during capture.');
   }
   await verify();
   const cap=Math.min(maxBytes-totalBytes,isSpec?maxSpecBytes:maxBytes);
   if(stat.size>BigInt(cap))throw fail('QUOTA_EXCEEDED','Component graph exceeds capture quota.');
   const chunks=[];let size=0;
   while(true){const buffer=Buffer.alloc(Math.min(65536,cap-size+1));const result=await handle.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;size+=result.bytesRead;if(size>cap)throw fail('QUOTA_EXCEEDED','Component graph exceeds capture quota.');chunks.push(buffer.subarray(0,result.bytesRead));}
   await verify();if(BigInt(size)!==stat.size)throw fail('SOURCE_CHANGED','Source size changed during capture.');
   const bytes=Buffer.concat(chunks);totalBytes+=size;
   const receipt={path:file,hash:crypto.createHash('sha256').update(bytes).digest('hex'),size,base64:bytes.toString('base64'),kind:isSpec?'spec':'asset'};
   receipts.set(file,receipt);return receipt;
  } finally {await handle.close();}
 }
 async function visit(input,file,depth) {
  if(depth>maxDepth)throw fail('QUOTA_EXCEEDED','Component graph exceeds depth bound.');
  const key=file||'<parent>';
  if(active.has(key))throw fail('COMPONENT_CYCLE','Component specifications contain a cycle.');
  if(definitions.has(key))return definitions.get(key);
  if(definitions.size>=maxSpecs)throw fail('QUOTA_EXCEEDED','Component graph exceeds definition bound.');
  boundedData(input);const sourceSpec=assertSpec(input);
  if(ids.has(sourceSpec.id))throw fail('DUPLICATE_COMPONENT_ID','Different specification paths claim the same definition ID: '+sourceSpec.id);
  ids.set(sourceSpec.id,key);active.add(key);
  const spec=structuredClone(sourceSpec),node={id:spec.id,path:file,sourceSpec,spec,sourceHash:file?receipts.get(file).hash:hashValue(sourceSpec),dependencies:[],assets:[],inputs:[],subtreeDepth:0};
  node.hash=node.sourceHash;
  definitions.set(key,node);
  const base=file?path.dirname(file):null;
  async function asset(owner,field,label) {
   if(!owner?.[field])return;
   const original=owner[field],absolute=await resolve(original,base),receipt=await read(absolute,false);
   owner[field]=absolute;const provenance={specId:spec.id,field:label,original,path:absolute,hash:receipt.hash,size:receipt.size};node.assets.push(provenance);node.inputs.push({...provenance,kind:label.startsWith('sounds/')?'audio':'artwork'});
   if(!assets.some(a=>a.path===absolute))assets.push(receipt);
  }
  for(const [i,part] of spec.parts.entries())for(const field of ['image','mask','requiredSurfaceMask'])await asset(part[field],'path',`parts/${i}/${field}/path`);
  for(const [i,reference] of spec.references.entries())await asset(reference,'path',`references/${i}/path`);
  for(const [i,sound] of (spec.sounds||[]).entries())await asset(sound,'path',`sounds/${i}/path`);
  await asset(spec.artwork,'source','artwork/source');
  for(const component of [...spec.components,...(spec.assembly?.descriptors||[]).filter(d=>!spec.components.some(c=>c.type===d.type)).map(d=>({id:null,socket:null,type:d.type,spec:d.spec,library:true}))]) {
   const childPath=await resolve(component.spec,base,true);let child=definitions.get(childPath);
   if(active.has(childPath))throw fail('COMPONENT_CYCLE','Component specifications contain a cycle.');
   if(!child){const receipt=await read(childPath,true);let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(receipt.base64,'base64')));}catch{throw fail('INVALID_SPEC','Child specification must be strict UTF-8 JSON.');}child=await visit(parsed,childPath,depth+1);}
   else if(depth+1+child.subtreeDepth>maxDepth)throw fail('QUOTA_EXCEEDED','Component graph exceeds depth bound.');
   node.subtreeDepth=Math.max(node.subtreeDepth,1+child.subtreeDepth);
   component.spec=childPath;node.dependencies.push({mountId:component.id,socket:component.socket,type:component.type,specId:child.id,path:childPath,...(component.library?{library:true}:{})});
  }
  for(const descriptor of spec.assembly?.descriptors||[]) {
   const declared=await resolve(descriptor.spec,base,true);
   if(node.dependencies.some(d=>d.type===descriptor.type&&d.path!==declared))throw fail('INVALID_COMPONENT','Mounted component and descriptor reference different definitions.');
  }
  active.delete(key);nodes.push(node);return node;
 }
 const parentPath=options.parentSpecPath||options.specPath;
 let file=null;
 if(parentPath){file=await resolve(parentPath,null,true);const receipt=await read(file,true);let disk;try{disk=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(receipt.base64,'base64')));}catch{throw fail('INVALID_SPEC','Parent source must be strict UTF-8 JSON.');}boundedData(disk);boundedData(parentSpec);if(canonicalJson(disk)!==canonicalJson(parentSpec))throw fail('SOURCE_CHANGED','Parent specification differs from its source.');}
 else {boundedData(parentSpec);totalBytes=Buffer.byteLength(canonicalJson(parentSpec));if(totalBytes>Math.min(maxBytes,maxSpecBytes))throw fail('QUOTA_EXCEEDED','Parent specification exceeds capture quota.');}
 const parent=await visit(parentSpec,file,0);
 return freeze({version:1,parentId:parent.id,nodes,dependencyOrder:nodes.map(n=>n.id),assets,sourceHashes:[...receipts.values()].map(({path,hash,size,kind})=>({path,hash,size,kind})),receipts:[...receipts.values()],totalBytes});
}
// Reconstruct captured definitions from the immutable, hash checked JSON receipts.
// Original paths are identifiers only: resume never opens files in source roots.
async function restoreComponentGraph(graph,inputs,jobRoot) {
 boundedData(graph);
 if(graph?.version!==1||!Array.isArray(graph.nodes)||graph.nodes.length>16||!graph.nodes.length)throw fail('INVALID_MANIFEST','Invalid captured component graph.');
 const nodes=[],ids=new Set(),paths=new Set();let bytes=0;
 for(const node of graph.nodes) {
  if(!node||ids.has(node.id)||node.path&&paths.has(node.path))throw fail('INVALID_MANIFEST','Duplicate captured definition.');
  ids.add(node.id);if(node.path)paths.add(node.path);
  if(!node.path){nodes.push(node);continue;}
  const receipt=inputs[node.path];
  if(!receipt||!Number.isSafeInteger(receipt.size)||receipt.size<1||receipt.size>1024*1024||!/^[a-f0-9]{64}$/.test(receipt.hash)||receipt.relative!=='sources/'+receipt.hash)throw fail('INVALID_MANIFEST','Invalid captured definition receipt.');
  bytes+=receipt.size;if(bytes>16*1024*1024)throw fail('QUOTA_EXCEEDED','Captured definitions exceed quota.');
  const file=await resolveContained(jobRoot,receipt.relative),stat=await fs.stat(file);
  if(stat.size!==receipt.size)throw fail('CORRUPT_ARTIFACT','Captured definition size changed.');
  const buffer=await fs.readFile(file);
  if(crypto.createHash('sha256').update(buffer).digest('hex')!==receipt.hash)throw fail('CORRUPT_ARTIFACT','Captured definition hash changed.');
  let spec;try{spec=assertSpec(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)));}catch{throw fail('INVALID_MANIFEST','Invalid captured definition JSON.');}
  function source(owner,key){if(owner?.[key]){
   owner[key]=path.resolve(path.dirname(node.path),owner[key]);
   if(key!=='spec'){
    const record=inputs[owner[key]];
    if(!record||!Number.isSafeInteger(record.size)||record.size<0||record.size>64*1024*1024||!/^[a-f0-9]{64}$/.test(record.hash)||record.relative!=='sources/'+record.hash)throw fail('INVALID_MANIFEST','Captured definition asset receipt is missing or invalid.');
   }
  }}
  for(const part of spec.parts)for(const key of ['image','mask','requiredSurfaceMask'])source(part[key],'path');
  for(const ref of spec.references)source(ref,'path');
  for(const sound of spec.sounds||[])source(sound,'path');source(spec.artwork,'source');
  for(const component of spec.components)source(component,'spec');
  if(spec.id!==node.id||canonicalJson(spec)!==canonicalJson(node.spec))throw fail('INVALID_MANIFEST','Captured definition differs from receipt.');
  nodes.push({...node,spec});
 }
 const done=new Map();
 for(const node of nodes){let depth=0;
  if(!Array.isArray(node.dependencies)||node.dependencies.length!==node.spec.components.length+(node.spec.assembly?.descriptors||[]).filter(d=>!node.spec.components.some(c=>c.type===d.type)).length)throw fail('INVALID_MANIFEST','Invalid captured dependencies.');
  for(const [i,dep] of node.dependencies.entries()) {
   const child=nodes.find(n=>n.id===dep.specId),component=dep.library ? {id:null,socket:null,type:dep.type,spec:dep.path} : node.spec.components[i];
   if(dep.library){const descriptor=node.spec.assembly?.descriptors.find(d=>d.type===dep.type);if(!descriptor||node.spec.components.some(c=>c.type===dep.type)||(node.path ? path.resolve(path.dirname(node.path),descriptor.spec)!==dep.path : !dep.path.endsWith(path.sep+descriptor.spec.split('/').join(path.sep))))throw fail('INVALID_MANIFEST','Invalid captured library dependency.');}
   if(!child||!done.has(child.id)||child.path!==dep.path||component.id!==dep.mountId||component.type!==dep.type||component.socket!==dep.socket||component.spec!==dep.path)throw fail('INVALID_MANIFEST','Captured graph is not dependency ordered.');
   depth=Math.max(depth,done.get(child.id)+1);
  }
  if(depth>4)throw fail('QUOTA_EXCEEDED','Captured graph exceeds depth bound.');done.set(node.id,depth);
 }
 if(nodes.at(-1).id!==graph.parentId)throw fail('INVALID_MANIFEST','Invalid captured parent definition.');
 return nodes;
}
module.exports={inspectComponentGraph,restoreComponentGraph};
