'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createSpec}=require('../lib/spec');
const {inspectComponentGraph}=require('../lib/component-build');
function spec(id, children=[]) {
 const s=createSpec({id,description:id});
 s.sockets=[{id:'mount',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:10,inheritance:{position:true,rotation:true,scale:true}}];
 s.components=children.map((file,i)=>({id:'mount'+i,socket:'mount',type:'arm',spec:file}));return s;
}
async function fixture(t) {
 const base=path.resolve(__dirname,'../../.tmp/component-graph');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'case-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'child'));return root;
}
test('captures immutable child receipts, all art inputs and repeated independent mounts',async t=>{
 const root=await fixture(t),child=spec('arm');child.parts=[{id:'part',role:'arm',bone:'root',pivot:[0,0],layer:0,image:{path:'art.png'}}];
 child.references=[{id:'ref',path:'ref.png'}];await fs.writeFile(path.join(root,'child/art.png'),'pixels');await fs.writeFile(path.join(root,'child/ref.png'),'ref');
 await fs.writeFile(path.join(root,'child/arm.json'),JSON.stringify(child));
 const parent=spec('body',['child/arm.json','child/arm.json']);const out=await inspectComponentGraph(parent,{sourceRoots:[root]});
 assert.deepEqual(out.dependencyOrder,['arm','body']);assert.equal(out.nodes.length,2);assert.equal(out.nodes.at(-1).dependencies.length,2);
 assert.equal(out.assets.length,2);assert.equal(out.nodes[0].spec.parts[0].image.path,path.join(root,'child/art.png'));
 assert.equal(out.nodes[0].sourceSpec.parts[0].image.path,'art.png');assert.ok(Object.isFrozen(out.nodes[0].spec.parts[0]));
 assert.equal(Buffer.from(out.assets[0].base64,'base64').toString(),'pixels');assert.equal(out.sourceHashes.length,3);
 await fs.writeFile(path.join(root,'child/art.png'),'changed');assert.equal(Buffer.from(out.assets[0].base64,'base64').toString(),'pixels');
});
test('rejects cycles, duplicate definition IDs, invalid JSON, traversal and bounded graphs',async t=>{
 const root=await fixture(t),write=(name,s)=>fs.writeFile(path.join(root,name),typeof s==='string'?s:JSON.stringify(s));
 await write('a.json',spec('a',['a.json']));await assert.rejects(inspectComponentGraph(spec('p',['a.json']),{sourceRoots:[root]}),{code:'COMPONENT_CYCLE'});
 await write('a.json',spec('same'));await write('b.json',spec('same'));
 await assert.rejects(inspectComponentGraph(spec('p',['a.json','b.json']),{sourceRoots:[root]}),{code:'DUPLICATE_COMPONENT_ID'});
 await write('a.json','{"bad":');await assert.rejects(inspectComponentGraph(spec('p',['a.json']),{sourceRoots:[root]}),{code:'INVALID_SPEC'});
 await assert.rejects(inspectComponentGraph(spec('p',['../escape']),{sourceRoots:[root]}),{code:'UNSAFE_PATH'});
 await write('a.json',spec('a'));for(const limits of [{maxSpecs:1},{maxDepth:0},{maxBytes:1}])await assert.rejects(inspectComponentGraph(spec('p',['a.json']),{sourceRoots:[root],...limits}),{code:'QUOTA_EXCEEDED'});
});
test('parent provenance, invalid data, audio and source capture remain read only',async t=>{
 const root=await fixture(t),parent=spec('parent');parent.artwork.source='source.png';parent.sounds=[{id:'sound',path:'audio.wav',volume:1,pitch:1}];
 // Use schema-valid audio metadata from its minimal required fields.
 delete parent.sounds[0].volume;delete parent.sounds[0].pitch;
 await fs.writeFile(path.join(root,'source.png'),'art');await fs.writeFile(path.join(root,'audio.wav'),'audio');
 const parentPath=path.join(root,'parent.json');await fs.writeFile(parentPath,JSON.stringify(parent));
 const out=await inspectComponentGraph(parent,{sourceRoots:[root],parentSpecPath:parentPath});assert.equal(out.nodes[0].inputs.find(x=>x.kind==='audio').original,'audio.wav');
 assert.equal(out.receipts.find(x=>x.kind==='spec').path,parentPath);
 await assert.rejects(inspectComponentGraph({...parent,description:'changed'},{sourceRoots:[root],specPath:parentPath}),{code:'SOURCE_CHANGED'});
 for(const options of [{sourceRoots:[]},{sourceRoots:[root],maxDepth:5}])await assert.rejects(inspectComponentGraph(parent,options),{code:'INVALID_INPUT'});
 const accessor={};Object.defineProperty(accessor,'id',{get(){throw Error('executed');}});await assert.rejects(inspectComponentGraph(accessor,{sourceRoots:[root]}),{code:'INVALID_SPEC'});
 const invalid=spec('invalid');invalid.parts=[{}];await assert.rejects(inspectComponentGraph(invalid,{sourceRoots:[root]}),{code:'INVALID_SPEC'});
 await assert.rejects(inspectComponentGraph(spec('missing',['missing.json']),{sourceRoots:[root]}),{code:'UNSAFE_PATH'});
 const directory=spec('directory');directory.references=[{id:'r',path:'child'}];await assert.rejects(inspectComponentGraph(directory,{sourceRoots:[root]}),{code:'INVALID_INPUT'});
});
test('parent specification rejects malformed UTF8 even when replacement text matches',async t=>{
 const root=await fixture(t),parent=spec('parent');parent.description='\ufffd';
 const bytes=Buffer.from(JSON.stringify(parent));const offset=bytes.indexOf(Buffer.from('\ufffd'));const malformed=Buffer.concat([bytes.subarray(0,offset),Buffer.from([255]),bytes.subarray(offset+3)]);
 const file=path.join(root,'parent.json');await fs.writeFile(file,malformed);
 await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[root],parentSpecPath:file}),{code:'INVALID_SPEC'});
});
test('opened handle identity mismatch rejects even when numeric inode values collide',async t=>{
 const root=await fixture(t),parent=spec('parent');parent.references=[{id:'art',path:'art.png'}];
 const file=path.join(root,'art.png'),other=path.join(root,'other.png');await fs.writeFile(file,'owned');await fs.writeFile(other,'different');
 const originalOpen=fs.open,originalLstat=fs.lstat;let reads=0;
 // Windows file IDs can exceed Number precision; distinct IDs may round alike.
 t.mock.method(fs,'lstat',async function(name,options){const stat=await originalLstat.call(fs,name,options);if(name===file)stat.ino=options?.bigint?9007199254740992n:Number(9007199254740992n);return stat;});
 t.mock.method(fs,'open',async function(name,...args){
  const handle=await originalOpen.call(fs,name===file?other:name,...args);
  const originalStat=handle.stat.bind(handle);handle.stat=async options=>{const stat=await originalStat(options);if(name===file)stat.ino=options?.bigint?9007199254740993n:Number(9007199254740993n);return stat;};
  if(name===file){const originalRead=handle.read.bind(handle);handle.read=async(...values)=>{reads++;return originalRead(...values);};}
  return handle;
 });
 await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[root]}),{code:'SOURCE_CHANGED'});assert.equal(reads,0);
});
test('directory junction swapped immediately before open is rejected before read',async t=>{
 const root=await fixture(t),parent=spec('parent');parent.references=[{id:'art',path:'child/art.png'}];
 const directory=path.join(root,'child'),moved=path.join(root,'saved'),target=path.join(root,'target');
 await fs.mkdir(target);await fs.writeFile(path.join(directory,'art.png'),'owned');await fs.writeFile(path.join(target,'art.png'),'target');
 const file=path.join(directory,'art.png'),originalOpen=fs.open;let reads=0;
 t.mock.method(fs,'open',async function(name,...args){
  if(name===file){await fs.rename(directory,moved);await fs.symlink(target,directory,process.platform==='win32'?'junction':'dir');}
  const handle=await originalOpen.call(fs,name,...args);const read=handle.read.bind(handle);handle.read=async(...values)=>{reads++;return read(...values);};return handle;
 });
 await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[root]}),{code:'UNSAFE_PATH'});assert.equal(reads,0);
});
test('path replaced during handle reading cannot publish a receipt',async t=>{
 const root=await fixture(t),parent=spec('parent');parent.references=[{id:'art',path:'art.png'}];
 const file=path.join(root,'art.png'),other=path.join(root,'other.png');await fs.writeFile(file,'owned');await fs.writeFile(other,'other');
 const originalOpen=fs.open;let swapped=false;
 t.mock.method(fs,'open',async function(name,...args){const handle=await originalOpen.call(fs,name,...args);if(name===file){const read=handle.read.bind(handle);handle.read=async(...values)=>{const result=await read(...values);if(!swapped){swapped=true;await fs.rename(file,file+'.saved');await fs.rename(other,file);}return result;};}return handle;});
 await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[root]}),{code:'SOURCE_CHANGED'});assert.equal(swapped,true);
});

test('captured graph reconstructs from bounded verified JSON without source files',async t=>{
 const root=await fixture(t),child=spec('arm');await fs.writeFile(path.join(root,'child.json'),JSON.stringify(child));
 const graph=await inspectComponentGraph(spec('body',['child.json']),{sourceRoots:[root]});
 const snapshot={version:1,parentId:graph.parentId,nodes:graph.nodes.map(({id,path,spec,dependencies})=>({id,path,spec,dependencies}))};
 const inputs={};await fs.mkdir(path.join(root,'sources'));
 for(const receipt of graph.receipts){inputs[receipt.path]={relative:'sources/'+receipt.hash,hash:receipt.hash,size:receipt.size};await fs.writeFile(path.join(root,'sources',receipt.hash),Buffer.from(receipt.base64,'base64'));}
 await fs.rm(path.join(root,'child.json'));
 const {restoreComponentGraph}=require('../lib/component-build');
 assert.deepEqual((await restoreComponentGraph(snapshot,inputs,root)).map(n=>n.id),['arm','body']);
 const altered=structuredClone(snapshot);altered.nodes[0].spec.description='tampered';
 await assert.rejects(restoreComponentGraph(altered,inputs,root),{code:'INVALID_MANIFEST'});
 const reversed=structuredClone(snapshot);reversed.nodes.reverse();await assert.rejects(restoreComponentGraph(reversed,inputs,root),{code:'INVALID_MANIFEST'});
 const record=inputs[path.join(root,'child.json')];await fs.writeFile(path.join(root,record.relative),'corrupt');
 await assert.rejects(restoreComponentGraph(snapshot,inputs,root),{code:'CORRUPT_ARTIFACT'});
});

test('definition roots allow generated JSON while retaining artwork authority and root bounds',async t=>{
 const root=await fixture(t),art=path.join(root,'art'),output=path.join(root,'output');await fs.mkdir(art);await fs.mkdir(output);
 const child=spec('child');child.references=[{id:'ref',path:path.join(art,'ref.png')}];await fs.writeFile(path.join(art,'ref.png'),'numeric fixture');
 await fs.writeFile(path.join(output,'child.json'),JSON.stringify(child));const parent=spec('parent',['child.json']);
 await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[art]}),{code:'UNSAFE_PATH'});
 const options={sourceRoots:[art],definitionRoots:[art,output]},graph=await inspectComponentGraph(parent,options);
 assert.deepEqual(graph.dependencyOrder,['child','parent']);assert.equal(graph.receipts.find(r=>r.kind==='spec').path,path.join(output,'child.json'));
 for(const assign of [s=>{s.references=[{id:'r',path:path.join(output,'asset')}];},s=>{s.artwork.source=path.join(output,'asset');},s=>{s.parts=[{id:'p',role:'arm',bone:'root',pivot:[0,0],layer:0,image:{path:path.join(output,'asset')}}];},s=>{s.sounds=[{id:'a',path:path.join(output,'asset')}];}]){
  const s=spec('blocked');assign(s);await fs.writeFile(path.join(output,'asset'),'bytes');await assert.rejects(inspectComponentGraph(s,options),{code:'UNSAFE_PATH'});
 }
 for(const definitionRoots of [null,[],[3],Array(34).fill(art)])await assert.rejects(inspectComponentGraph(parent,{sourceRoots:[art],definitionRoots}),{code:'INVALID_INPUT'});
 const roots=Array.from({length:32},()=>art);assert.equal((await inspectComponentGraph(parent,{sourceRoots:roots,definitionRoots:[...roots,output]})).nodes.length,2);
});

test('definition-only nested paths retain containment and checked handle identity',async t=>{
 const root=await fixture(t),art=path.join(root,'art'),output=path.join(root,'output');await fs.mkdir(art);await fs.mkdir(output);await fs.mkdir(path.join(output,'nested'));
 const leaf=path.join(output,'nested/leaf.json');await fs.writeFile(leaf,JSON.stringify(spec('leaf')));await fs.writeFile(path.join(output,'child.json'),JSON.stringify(spec('child',['nested/leaf.json'])));
 const options={sourceRoots:[art],definitionRoots:[art,output]},parent=spec('parent',['child.json']);assert.deepEqual((await inspectComponentGraph(parent,options)).dependencyOrder,['leaf','child','parent']);
 const originalOpen=fs.open;let changed=false;t.mock.method(fs,'open',async function(file,...args){const handle=await originalOpen.call(fs,file,...args);if(file===leaf){const read=handle.read.bind(handle);handle.read=async(...values)=>{const result=await read(...values);if(!changed){changed=true;await fs.rename(leaf,leaf+'.saved');await fs.writeFile(leaf,JSON.stringify(spec('replacement')));}return result;};}return handle;});
 await assert.rejects(inspectComponentGraph(parent,options),{code:'SOURCE_CHANGED'});assert.equal(changed,true);t.mock.restoreAll();
 const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'escape.json'),JSON.stringify(spec('escape')));await fs.symlink(outside,path.join(output,'link'),process.platform==='win32'?'junction':'dir');await assert.rejects(inspectComponentGraph(spec('parent',['link/escape.json']),options),{code:'UNSAFE_PATH'});
 const conflict=spec('conflict',['same.json']);conflict.references=[{id:'asset',path:'same.json'}];await fs.writeFile(path.join(art,'same.json'),JSON.stringify(spec('same')));await assert.rejects(inspectComponentGraph(conflict,options),{code:'CONFLICTING_SOURCE_PATH'});
 const mask=spec('mask');mask.parts=[{id:'p',role:'arm',bone:'root',pivot:[0,0],layer:0,image:{path:path.join(art,'same.json')},mask:{path:leaf}}];await assert.rejects(inspectComponentGraph(mask,options),{code:'UNSAFE_PATH'});
 const forged=spec('forged');forged.references=[{id:'r',path:leaf,kind:'spec'}];await assert.rejects(inspectComponentGraph(forged,options),{code:'INVALID_SPEC'});
});
