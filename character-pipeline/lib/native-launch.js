'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
// Windows Codex can expose the DLL to the parent while denying the launched
// mono host its runtime. Fail before starting the engine, rather than opening
// its misleading missing-assemblies dialog. This guard never elevates itself.
async function prepareNativeTool(tool,{platform=process.platform,env=process.env,fs:files=fs}={}){
 if(Object.hasOwn(tool,'env'))throw Object.assign(Error('Arbitrary tool environment overrides are unsupported'),{code:'INVALID_INPUT'});
 if(tool.dotnetRoot!==undefined){
  const paths=platform==='win32'?path.win32:path;
  const root=tool.dotnetRoot;
  try{
   if(typeof root!=='string'||root.includes('\0')||!paths.isAbsolute(root))throw Error('Runtime root must be absolute');
   for(const relative of [['host','fxr'],['shared','Microsoft.NETCore.App']]){
    if(!(await files.stat(paths.join(root,...relative))).isDirectory())throw Error('Runtime directory is absent');
   }
  }catch(cause){throw Object.assign(Error('Configured .NET runtime root must contain host/fxr and shared/Microsoft.NETCore.App directories'),{code:'CAPABILITY_MISSING',cause});}
 }
 if(platform!=='win32'||!/(?:megadot|godot).*\.exe$/i.test(path.win32.basename(tool.executable)))return tool;
 const directory=path.win32.dirname(tool.executable),normalized={...tool,cwd:directory};
 if(!/mono|megadot/i.test(path.win32.basename(tool.executable)))return normalized;
 const runtime=path.win32.join(directory,'GodotSharp','Api','Debug','GodotSharp.dll');
 try{await files.access(runtime);}catch(cause){throw Object.assign(Error('Godot .NET runtime is inaccessible at '+runtime),{code:'CAPABILITY_MISSING',cause});}
 // The probe is specific to Codex Windows execution. Ordinary installations,
 // including read-only installations, do not acquire a new write requirement.
 if(!env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY)return normalized;
 const probe=path.win32.join(directory,'.character-pipeline-launch-'+crypto.randomUUID()+'.tmp');
 let handle,created=false;
 try{
  handle=await files.open(probe,'wx');created=true;await handle.close();handle=null;
  await files.unlink(probe);created=false;
 }catch(cause){
  throw Object.assign(Error('Native engine launch blocked before startup. Retry this command through authorized execution with access to the installed tool directory; do not reinstall Godot.'),{code:'NATIVE_LAUNCH_BLOCKED',cause});
 }finally{
  if(handle)await handle.close().catch(()=>{});
  if(created)await files.unlink(probe).catch(()=>{});
 }
 return normalized;
}
function nativeEnvironment(tool){
 return tool.dotnetRoot===undefined?undefined:{...process.env,DOTNET_ROOT:tool.dotnetRoot,DOTNET_ROOT_X64:tool.dotnetRoot};
}
module.exports={prepareNativeTool,nativeEnvironment};
