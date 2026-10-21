'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {runAudioOperation} = require('../lib/audio');
function wav() {
  const b=Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32);
  b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(4,40); return b;
}
function vorbis(channels=1,frames=2) {
  function page(packet,seq,flags,granule=0n) {
    const b=Buffer.alloc(28+packet.length);b.write('OggS');b[5]=flags;b.writeBigInt64LE(granule,6);b.writeUInt32LE(1,14);b.writeUInt32LE(seq,18);b[26]=1;b[27]=packet.length;packet.copy(b,28);
    let c=0;for(const x of b){c=(c^(x<<24))>>>0;for(let n=0;n<8;n++)c=((c<<1)^((c&0x80000000)?0x04c11db7:0))>>>0;}b.writeUInt32LE(c,22);return b;
  }
  const id=Buffer.alloc(30);id[0]=1;id.write('vorbis',1);id[11]=channels;id.writeUInt32LE(8000,12);id[28]=0x76;id[29]=1;
  const comment=Buffer.alloc(16);comment[0]=3;comment.write('vorbis',1);comment[15]=1;
  return Buffer.concat([page(id,0,2),page(comment,1,0),page(Buffer.from('\x05vorbis\x01','binary'),2,0),page(Buffer.from([0,1]),3,4,BigInt(frames))]);
}
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-audio-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.wav'); await fs.writeFile(source,wav());
  const stagingDir=path.join(dir,'stage'); await fs.mkdir(stagingDir);
  const config={sourceRoots:[dir],tools:{python:{executable:process.execPath}}};
  return {dir,source,stagingDir,config};
}
test('audio wrapper validates container before worker and verifies actual decoded metadata',async t=>{
  const f=await fixture(t); let calls=0;
  const runTool=async(registry,name,args,options)=>{
    calls++; assert.equal(name,'python'); assert.equal(options.timeoutMs,30000);
    const request=JSON.parse(await fs.readFile(args[1])); assert.equal(request.action,'inspect');
    assert.notEqual(request.sourcePath,f.source); assert.deepEqual(await fs.readFile(request.sourcePath),wav());
    return {exitCode:0,stdout:JSON.stringify({ok:true,audio:{format:'wav',channels:1,sampleRate:8000,frames:2,duration:0.00025,encodedBytes:48,decodedBytes:4}}),stderr:''};
  };
  const result=await runAudioOperation('inspect',f.source,{...f,runTool});
  assert.equal(result.frames,2); assert.match(result.sourceHash,/^[a-f0-9]{64}$/); assert.equal(calls,1);
  await fs.writeFile(f.source,'not audio');
  await assert.rejects(runAudioOperation('inspect',f.source,{...f,runTool}),{code:'INVALID_AUDIO'});
  assert.equal(calls,1);
});
test('audio wrapper rejects escapes, missing tools, malformed workers and mismatched decoder claims',async t=>{
  const f=await fixture(t);
  await assert.rejects(runAudioOperation('shell',f.source,f),{code:'UNSUPPORTED'});
  await assert.rejects(runAudioOperation('inspect',f.source,{...f,config:{...f.config,tools:{}}}),{code:'CAPABILITY_MISSING'});
  await assert.rejects(runAudioOperation('inspect',f.source,{...f,config:{...f.config,sourceRoots:[f.stagingDir]}}),{code:'UNSAFE_PATH'});
  for(const response of [
    {exitCode:0,stdout:'nonsense'},
    {exitCode:2,stdout:JSON.stringify({ok:false,error:{code:'INVALID_AUDIO',message:'bad'}})},
    {exitCode:0,stdout:JSON.stringify({ok:true,audio:{format:'wav',channels:1,sampleRate:8000,frames:20,duration:0.0025,encodedBytes:48,decodedBytes:40}})}
  ]) await assert.rejects(runAudioOperation('inspect',f.source,{...f,runTool:async()=>response}));
});
test('conversion publishes only owned geometry-preserving validated candidates',async t=>{
  const f=await fixture(t);
  const runTool=async(_registry,_name,args)=>{
    const r=JSON.parse(await fs.readFile(args[1]));await fs.mkdir(r.outputDirectory);
    const output=path.join(r.outputDirectory,'candidate.ogg');const data=vorbis();await fs.writeFile(output,data);
    return {exitCode:0,stdout:JSON.stringify({ok:true,audio:{format:'ogg-vorbis',channels:1,sampleRate:8000,frames:2,duration:0.00025,encodedBytes:data.length,decodedBytes:4,path:output}})};
  };
  const result=await runAudioOperation('encode-vorbis',f.source,{...f,runTool,bitrate:64000});
  assert.equal(result.encoding.bitrate,64000);assert.deepEqual(await fs.readFile(result.path),vorbis());
  assert.equal(result.sourceBytes,48);assert.equal(result.savedBytes,48-vorbis().length);
  const defaultResult=await runAudioOperation('encode-vorbis',f.source,{...f,runTool});assert.equal(defaultResult.encoding.bitrate,64000);
  for(const audio of [undefined,{path:f.source}]) await assert.rejects(runAudioOperation('encode-vorbis',f.source,{...f,runTool:async()=>({exitCode:0,stdout:JSON.stringify({ok:true,audio})})}));
  for(const response of [{exitCode:1,stdout:JSON.stringify({ok:true})},{exitCode:0,stdout:'{}'},{exitCode:0,stdout:'bad',error:{code:'TIMEOUT'}}])await assert.rejects(runAudioOperation('inspect',f.source,{...f,runTool:async()=>response}));
  await assert.rejects(runAudioOperation('inspect',f.source,{...f,signal:AbortSignal.abort()}),{code:'ABORTED'});
  await assert.rejects(runAudioOperation('inspect',f.source,{...f,bitrate:0}),{code:'INVALID_INPUT'});
  const large=path.join(f.dir,'large.wav');const h=await fs.open(large,'w');await h.truncate(16*1024*1024+1);await h.close();
  await assert.rejects(runAudioOperation('inspect',large,{...f,runTool}),{code:'QUOTA_EXCEEDED'});
  assert.deepEqual(await fs.readFile(f.source),wav());
});

