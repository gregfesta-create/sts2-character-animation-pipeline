'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {inspectAudio} = require('../lib/audio-format');
function wav(frames=80) {
  const b=Buffer.alloc(44+frames*2); b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24);
  b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(frames*2,40); return b;
}
function crc(b) {let c=0; for(const x of b){c=(c^(x<<24))>>>0;for(let n=0;n<8;n++)c=((c<<1)^((c&0x80000000)?0x04c11db7:0))>>>0;}return c;}
function page(packet,seq,flags,granule=0n) {
 const segments=[];for(let n=packet.length;n>=255;n-=255)segments.push(255); segments.push(packet.length%255);
 const b=Buffer.alloc(27+segments.length+packet.length);b.write('OggS'); b[5]=flags;b.writeBigInt64LE(granule,6);b.writeUInt32LE(42,14);b.writeUInt32LE(seq,18);b[26]=segments.length;Buffer.from(segments).copy(b,27);packet.copy(b,27+segments.length);b.writeUInt32LE(crc(b),22);return b;
}
function ogg() {
 const id=Buffer.alloc(30);id[0]=1;id.write('vorbis',1);id[11]=2;id.writeUInt32LE(8000,12);id[28]=0x76;id[29]=1;
 const comment=Buffer.alloc(16);comment[0]=3;comment.write('vorbis',1);comment[15]=1;
 return Buffer.concat([page(id,0,2),page(comment,1,0),page(Buffer.from('\x05vorbis\x01','binary'),2,0),page(Buffer.from([0,1]),3,4,80n)]);
}
test('PCM inspection reports exact bounded resource counts',()=>{assert.deepEqual(inspectAudio(wav()),{format:'wav',channels:1,sampleRate:8000,frames:80,duration:0.01,encodedBytes:204,decodedBytes:160});});
test('WAV rejects malformed format, chunk sizes, counts and unsupported encoding',()=>{
 for(const [offset,value,size] of [[4,1,4],[20,3,2],[22,3,2],[24,7999,4],[28,1,4],[32,4,2],[34,8,2],[40,159,4]]){const b=wav();b[size===2?'writeUInt16LE':'writeUInt32LE'](value,offset);assert.throws(()=>inspectAudio(b),{code:'INVALID_AUDIO'});}
 for(const b of [Buffer.alloc(0),wav().subarray(0,40),wav(0),Buffer.from('not audio')])assert.throws(()=>inspectAudio(b),{code:'INVALID_AUDIO'});
 assert.throws(()=>inspectAudio(wav(240001)),{code:'QUOTA'});assert.throws(()=>inspectAudio(Buffer.alloc(16*1024*1024+1)),{code:'QUOTA'});
});
test('Ogg container inspection reports granule claim without pretending to decode setup',()=>{assert.deepEqual(inspectAudio(ogg()),{format:'ogg-vorbis',channels:2,sampleRate:8000,frames:80,duration:0.01,encodedBytes:ogg().length,decodedBytes:320});});
test('Ogg rejects corruption, truncation, missing ending and chained streams',()=>{
 const b=ogg();const broken=Buffer.from(b);broken[broken.length-1]^=1;
 for(const x of [broken,b.subarray(0,b.length-1),b.subarray(0,30),Buffer.concat([b,b])])assert.throws(()=>inspectAudio(x),{code:'INVALID_AUDIO'});
});
test('Ogg rejects header codecs, invalid identification and granule claims',()=>{
 const id=Buffer.alloc(30);id[0]=1;id.write('vorbis',1);id[11]=1;id.writeUInt32LE(8000,12);id[28]=0x76;id[29]=1;
 const comment=Buffer.alloc(16);comment[0]=3;comment.write('vorbis',1);comment[15]=1;
 const prefix=Buffer.concat([page(id,0,2),page(comment,1,0),page(Buffer.from('\x05vorbis\x01','binary'),2,0)]);
 for(const frames of [-1n,0n])assert.throws(()=>inspectAudio(Buffer.concat([prefix,page(Buffer.from([0]),3,4,frames)])),{code:'INVALID_AUDIO'});
 assert.throws(()=>inspectAudio(Buffer.concat([prefix,page(Buffer.from([0]),3,4,240001n)])),{code:'QUOTA'});
 assert.throws(()=>inspectAudio(page(Buffer.from('OpusHead'),0,6,80n)),{code:'INVALID_AUDIO'});
 id[11]=3;assert.throws(()=>inspectAudio(page(id,0,6,80n)),{code:'INVALID_AUDIO'});
});
test('Ogg enforces serial, sequence, flags, metadata and header constraints even with valid CRC',()=>{
 function mutateFirst(edit){const b=ogg();const end=27+b[26]+b[27];edit(b);b.writeUInt32LE(0,22);b.writeUInt32LE(crc(b.subarray(0,end)),22);return b;}
 for(const edit of [b=>b[4]=1,b=>b[5]=10,b=>b.writeUInt32LE(2,18),b=>b.writeBigInt64LE(1n,6),b=>b[27+1+29]=0,b=>b[27+1+28]=0,b=>b.writeUInt32LE(1,27+1+7),b=>b.writeUInt32LE(7999,27+1+12)])assert.throws(()=>inspectAudio(mutateFirst(edit)),{code:'INVALID_AUDIO'});
 const b=ogg(),firstEnd=58,secondEnd=102;
 for(const edit of [x=>x.writeUInt32LE(43,firstEnd+14),x=>x[firstEnd+5]=1,x=>x[firstEnd+5]=2,x=>x.writeUInt32LE(9,firstEnd+18)]){
  const x=Buffer.from(b);edit(x);x.writeUInt32LE(0,firstEnd+22);x.writeUInt32LE(crc(x.subarray(firstEnd,secondEnd)),firstEnd+22);assert.throws(()=>inspectAudio(x),{code:'INVALID_AUDIO'});
 }
 const first=b.subarray(0,firstEnd),rest=b.subarray(secondEnd);
 for(const packet of [Buffer.from('\x05vorbis\x01','binary'),Buffer.from('\x03vorbis','binary'),Buffer.concat([Buffer.from('\x03vorbis','binary'),Buffer.alloc(65530)])])assert.throws(()=>inspectAudio(Buffer.concat([first,page(packet,1,0),rest])),{code:'INVALID_AUDIO'});
 assert.throws(()=>inspectAudio('audio'),{code:'INVALID_AUDIO'});
});
test('WAV skips bounded unknown chunks but rejects duplicate and missing required chunks',()=>{
 const base=wav();const chunk=Buffer.from('JUNK\x01\x00\x00\x00a\x00','binary');
 const b=Buffer.concat([base,chunk]);b.writeUInt32LE(b.length-8,4);assert.equal(inspectAudio(b).frames,80);
 for(const extra of [base.subarray(12,36),base.subarray(36)]){const x=Buffer.concat([base,extra]);x.writeUInt32LE(x.length-8,4);assert.throws(()=>inspectAudio(x),{code:'INVALID_AUDIO'});}
 const x=Buffer.from(base);x.write('JUNK',12);assert.throws(()=>inspectAudio(x),{code:'INVALID_AUDIO'});
});
