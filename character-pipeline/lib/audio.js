'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {resolveContained} = require('./assets');
const {runTool: defaultRunTool} = require('./process');
const {inspectAudio} = require('./audio-format');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const MAX_BYTES=16*1024*1024;
async function readBounded(file) {
  const handle=await fs.open(file,'r');
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size>MAX_BYTES) throw fail('QUOTA_EXCEEDED','Audio must be a regular file within 16 MiB.');
    const bytes=Buffer.alloc(MAX_BYTES+1); let length=0;
    while(length<bytes.length) {
      const result=await handle.read(bytes,length,bytes.length-length,null);
      if(!result.bytesRead) break;
      length+=result.bytesRead;
    }
    if(length>MAX_BYTES) throw fail('QUOTA_EXCEEDED','Audio exceeds 16 MiB.');
    return bytes.subarray(0,length);
  } finally {await handle.close();}
}
async function sourceFile(input,roots) {
  for(const root of roots||[]) {
    const relative=path.relative(path.resolve(root),path.resolve(input));
    if(!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
    return resolveContained(root,relative);
  }
  throw fail('UNSAFE_PATH','Audio source is outside configured roots.');
}
function checkDecoded(audio,container) {
  if(!audio || audio.format!==container.format || audio.channels!==container.channels || audio.sampleRate!==container.sampleRate || audio.frames!==container.frames || audio.encodedBytes!==container.encodedBytes || audio.decodedBytes!==container.decodedBytes || !Number.isFinite(audio.duration) || Math.abs(audio.duration-audio.frames/audio.sampleRate)>1e-8) throw fail('INVALID_WORKER_OUTPUT','Decoder metadata does not match the validated audio container.');
}
async function runAudioOperation(action,input,{config,stagingDir,runTool=defaultRunTool,signal,bitrate}={}) {
  if(!['inspect','encode-vorbis'].includes(action)) throw fail('UNSUPPORTED','Unknown registered audio operation.');
  if(!config?.tools?.python?.executable) throw fail('CAPABILITY_MISSING','Configured Python with the trusted audio decoder is required.');
  if(signal?.aborted) throw fail('ABORTED','Audio operation cancelled.');
  if(bitrate!==undefined && (!Number.isInteger(bitrate)||bitrate<32000||bitrate>192000)) throw fail('INVALID_INPUT','Audio bitrate must be an integer from 32000 to 192000.');
  const source=await sourceFile(input,config.sourceRoots);
  const bytes=await readBounded(source);
  const container=inspectAudio(bytes);
  const sourceHash=crypto.createHash('sha256').update(bytes).digest('hex');
  const folder=await resolveContained(stagingDir,'audio-'+crypto.randomUUID(),{mustExist:false});
  await fs.mkdir(folder,{recursive:true});
  let keep=false;
  try {
    const captured=path.join(folder,'input.'+(container.format==='wav'?'wav':'ogg'));
    await fs.writeFile(captured,bytes,{flag:'wx'});
    const request={action,sourcePath:captured,outputDirectory:path.join(folder,'output'),...(bitrate===undefined?{}:{bitrate})};
    const requestFile=path.join(folder,'request.json');
    await fs.writeFile(requestFile,JSON.stringify(request));
    const result=await runTool({python:config.tools.python},'python',[path.resolve(__dirname,'../workers/audio.py'),requestFile],{signal,timeoutMs:30000,maxOutputBytes:256*1024});
    let parsed;
    try {parsed=JSON.parse(result.stdout);} catch {throw fail(result.error?.code||'INVALID_WORKER_OUTPUT','Audio worker returned invalid JSON.');}
    if(parsed?.ok===false) throw fail(parsed.error?.code||'INVALID_AUDIO',String(parsed.error?.message||'Audio worker failed.').slice(0,4096));
    if(result.error||result.exitCode!==0) throw fail(result.error?.code||'AUDIO_OPERATION_FAILED','Audio worker failed.');
    if(parsed?.ok!==true) throw fail('INVALID_WORKER_OUTPUT','Audio worker omitted success metadata.');
    if(action==='inspect') {
      checkDecoded(parsed.audio,container);
      return {...parsed.audio,sourceHash,path:source};
    }
    if(typeof parsed.audio?.path!=='string') throw fail('INVALID_WORKER_OUTPUT','Encoder omitted its owned output.');
    const candidate=await resolveContained(request.outputDirectory,path.relative(request.outputDirectory,path.resolve(parsed.audio.path)));
    const encoded=await readBounded(candidate);
    const metadata=inspectAudio(encoded);
    if(metadata.format!=='ogg-vorbis'||metadata.channels!==container.channels||metadata.sampleRate!==container.sampleRate||metadata.frames!==container.frames) throw fail('INVALID_WORKER_OUTPUT','Encoded candidate changed source format or sample geometry.');
    checkDecoded(parsed.audio,metadata);
    keep=true;
    return {...parsed.audio,path:candidate,sourceHash,hash:crypto.createHash('sha256').update(encoded).digest('hex'),sourceBytes:bytes.length,savedBytes:bytes.length-encoded.length,encoding:{bitrate:bitrate??64000}};
  } finally {
    if(!keep) await fs.rm(folder,{recursive:true,force:true});
  }
}
module.exports={runAudioOperation,readBounded};
