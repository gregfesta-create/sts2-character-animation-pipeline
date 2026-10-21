'use strict';
const LIMIT=16*1024*1024;
function fail(message,code='INVALID_AUDIO'){throw Object.assign(new Error(message),{code});}
function check(ok,message){if(!ok)fail(message);}
function result(format,channels,sampleRate,frames,encodedBytes){
 check(channels===1||channels===2,'Audio must be mono or stereo');
 check(sampleRate>=8000&&sampleRate<=96000,'Unsupported audio sample rate');
 check(Number.isSafeInteger(frames)&&frames>0,'Audio must contain a positive safe frame count');
 const decodedBytes=frames*channels*2,duration=frames/sampleRate;
 if(duration>30||decodedBytes>LIMIT)fail('Audio exceeds duration or decoded PCM quota','QUOTA');
 return {format,channels,sampleRate,frames,duration,encodedBytes,decodedBytes};
}
function wav(b){
 check(b.length>=12&&b.toString('ascii',8,12)==='WAVE','Invalid WAVE header');
 check(b.readUInt32LE(4)===b.length-8,'RIFF size must match input');
 let fmt,data;
 for(let p=12;p<b.length;){
  check(p+8<=b.length,'Truncated WAV chunk');const n=b.readUInt32LE(p+4),end=p+8+n;
  check(end<=b.length&&end+(n%2)<=b.length,'Truncated WAV chunk data');
  const id=b.toString('ascii',p,p+4);
  if(id==='fmt '){check(!fmt&&n===16,'Expected one canonical PCM format chunk');fmt=b.subarray(p+8,end);}
  if(id==='data'){check(data===undefined,'Duplicate WAV data chunk');data=n;}
  p=end+(n%2);
 }
 check(fmt&&data!==undefined,'Missing WAV format or data');
 const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4),alignment=fmt.readUInt16LE(12);
 check(fmt.readUInt16LE(0)===1&&fmt.readUInt16LE(14)===16,'Only signed 16-bit PCM WAV is supported');
 check(alignment===channels*2&&fmt.readUInt32LE(8)===rate*alignment&&data%alignment===0,'Inconsistent WAV sample alignment or byte rate');
 return result('wav',channels,rate,data/alignment,b.length);
}
function crc(b){let c=0;for(let i=0;i<b.length;i++){const x=i>=22&&i<26?0:b[i];c=(c^(x<<24))>>>0;for(let n=0;n<8;n++)c=((c<<1)^((c&0x80000000)?0x04c11db7:0))>>>0;}return c;}
function signature(packet,type){check(packet.length>=7&&packet[0]===type&&packet.toString('ascii',1,7)==='vorbis','Invalid Vorbis header order or unsupported codec');}
function comment(packet){
 check(packet.length<=65536,'Vorbis comment metadata exceeds 64 KiB');
 let p=7;function length(){check(p+4<=packet.length,'Truncated Vorbis metadata');const n=packet.readUInt32LE(p);p+=4;return n;}
 const vendor=length();check(p+vendor<=packet.length,'Truncated Vorbis vendor');p+=vendor;
 const count=length();check(count<=16384,'Excess Vorbis comments');
 for(let i=0;i<count;i++){const n=length();check(p+n<=packet.length,'Truncated Vorbis comment');p+=n;}
 check(p+1===packet.length&&packet[p]===1,'Invalid Vorbis comment framing');
}
/** Container/header preflight only. Trusted decoder validation is still mandatory. */
function ogg(b){
 let p=0,serial,sequence=0,ended=false,parts=[],bytes=0,packets=0,channels,rate,lastGranule=0n,finalGranule;
 while(p<b.length){
  check(!ended&&p+27<=b.length,'Chained or truncated Ogg stream');
  check(b.toString('ascii',p,p+4)==='OggS'&&b[p+4]===0,'Invalid Ogg page');
  const flags=b[p+5],s=b.readUInt32LE(p+14),seq=b.readUInt32LE(p+18),count=b[p+26];
  check((flags&~7)===0&&p+27+count<=b.length,'Invalid Ogg flags or lacing');
  if(serial===undefined){serial=s;check(flags===2&&seq===0,'Expected initial Ogg BOS page');}
  else check(s===serial&&!(flags&2),'Multiplexed or chained Ogg stream');
  check(seq===sequence++,'Nonsequential Ogg pages');
  check(Boolean(flags&1)===(bytes>0),'Inconsistent continued Ogg packet');
  let end=p+27+count;for(let i=0;i<count;i++)end+=b[p+27+i];
  check(end<=b.length,'Truncated Ogg payload');const page=b.subarray(p,end);
  check(crc(page)===b.readUInt32LE(p+22),'Invalid Ogg CRC');
  const granule=b.readBigInt64LE(p+6);check(granule>=-1n,'Invalid negative Ogg granule');
  let pos=p+27+count,completed=0;
  for(let i=0;i<count;i++){
   const n=b[p+27+i];parts.push(b.subarray(pos,pos+n));pos+=n;bytes+=n;
   check(bytes<=1024*1024,'Ogg packet exceeds bounded packet size');
   if(n===255)continue;
   const packet=Buffer.concat(parts,bytes);parts=[];bytes=0;completed++;
   if(packets<3){signature(packet,[1,3,5][packets]);
    if(packets===0){check(packet.length===30&&packet.readUInt32LE(7)===0&&packet[29]===1,'Invalid Vorbis identification header');channels=packet[11];rate=packet.readUInt32LE(12);const lo=packet[28]&15,hi=packet[28]>>4;check(lo>=6&&hi>=lo&&hi<=13,'Invalid Vorbis block sizes');result('ogg-vorbis',channels,rate,1,b.length);}
    if(packets===1)comment(packet);
    if(packets===2)check(packet.length>7,'Empty Vorbis setup header');
   }else check(packet.length>0&&(packet[0]&1)===0,'Invalid Vorbis audio packet');
   packets++;
  }
  if(seq===0)check(packets===1&&completed===1&&bytes===0&&granule===0n,'Identification must occupy the initial zero-granule page');
  if(packets<=3)check(granule===0n||granule===-1n,'Header pages cannot claim decoded audio');
  if(granule>=0n){check(completed>0&&granule>=lastGranule,'Inconsistent Ogg granule');lastGranule=granule;}
  if(flags&4){check(bytes===0&&packets>=4&&granule>=0n,'Invalid final Ogg page');ended=true;finalGranule=granule;}
  p=end;
 }
 check(ended&&finalGranule<=BigInt(Number.MAX_SAFE_INTEGER),'Missing Ogg EOS or unsafe sample count');
 return result('ogg-vorbis',channels,rate,Number(finalGranule),b.length);
}
function inspectAudio(buffer){
 check(Buffer.isBuffer(buffer),'Audio input must be a Buffer');
 if(buffer.length>LIMIT)fail('Encoded audio exceeds 16 MiB','QUOTA');
 check(buffer.length>=4,'Truncated audio');
 const magic=buffer.toString('ascii',0,4);
 if(magic==='RIFF')return wav(buffer);
 if(magic==='OggS')return ogg(buffer);
 fail('Unsupported audio container');
}
module.exports={inspectAudio};
