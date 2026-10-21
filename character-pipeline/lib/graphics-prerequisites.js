'use strict';
const {createHash}=require('node:crypto');
const GRAPHICS_PROBE_SCRIPT=`import sys, json, io
from pathlib import Path
r = {'version': 1, 'python': {'version': '.'.join(map(str, sys.version_info[:3]))}, 'pathApi': {'isJunction': callable(getattr(Path, 'is_junction', None))}, 'pillow': {'version': None, 'pngRoundTrip': False, 'error': None}, 'numpy': {'version': None, 'arrayOperation': False, 'error': None}}
try:
    import PIL
    from PIL import Image
    r['pillow']['version'] = str(PIL.__version__)
    b = io.BytesIO()
    Image.new('RGBA', (1, 1), (17, 34, 51, 68)).save(b, format='PNG')
    b.seek(0)
    with Image.open(b) as image:
        image.load()
        r['pillow']['pngRoundTrip'] = image.format == 'PNG' and image.mode == 'RGBA' and image.size == (1, 1) and image.getpixel((0, 0)) == (17, 34, 51, 68)
except Exception as e:
    r['pillow']['error'] = (type(e).__name__ + ': ' + str(e))[:512]
try:
    import numpy as np
    r['numpy']['version'] = str(np.__version__)
    a = np.array([1, 2], dtype=np.uint8)
    r['numpy']['arrayOperation'] = bool((a + 1).tolist() == [2, 3] and a.dtype == np.dtype('uint8'))
except Exception as e:
    r['numpy']['error'] = (type(e).__name__ + ': ' + str(e))[:512]
print(json.dumps(r, ensure_ascii=True, separators=(',', ':')))
`;
const GRAPHICS_PROBE_IMPLEMENTATION_HASH=createHash('sha256').update(GRAPHICS_PROBE_SCRIPT).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,list)=>object(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
const version=v=>typeof v==='string'&&v.length<=128&&/^\d+\.\d+\.\d+(?:[a-zA-Z0-9.+_-]*)$/.test(v);
function validReport(r){
 if(!keys(r,['version','python','pathApi','pillow','numpy'])||r.version!==1||!keys(r.python,['version'])||!version(r.python.version)||!keys(r.pathApi,['isJunction'])||typeof r.pathApi.isJunction!=='boolean')return false;
 for(const [name,check] of [['pillow','pngRoundTrip'],['numpy','arrayOperation']]){
 const p=r[name];if(!keys(p,['version',check,'error'])||!(p.version===null||version(p.version))||typeof p[check]!=='boolean'||!(p.error===null||typeof p.error==='string'&&p.error.length>0&&p.error.length<=512))return false;
 if(p[check]&&(p.version===null||p.error!==null))return false;
 if(p.version===null&&p.error===null)return false;
 }
 return true;
}
/** Read-only, fixed Python capability probe. Registry is operator-owned, never specification data. */
async function probeGraphicsPrerequisites(config,{runTool=require('./process.js').runTool}={}){
 const result={version:1,available:false,implementationHash:GRAPHICS_PROBE_IMPLEMENTATION_HASH,python:{version:null},pillow:{version:null,pngRoundTrip:false},numpy:{version:null,arrayOperation:false},pathApi:{isJunction:false},diagnostics:[]};
 const fail=(code,message)=>{result.diagnostics.push({code,message});return result;};
 if(!config?.tools||!Object.hasOwn(config.tools,'python'))return fail('PYTHON_NOT_CONFIGURED','Configure tools.python for artwork preparation (Python with Pillow, NumPy and Path.is_junction).');
 let probe;
 try{probe=await runTool(config.tools,'python',['-B','-c',GRAPHICS_PROBE_SCRIPT],{timeoutMs:30000,maxOutputBytes:32768});}
 catch(error){return fail('GRAPHICS_PROBE_FAILED',`Python graphics probe failed: ${String(error?.message||error).slice(0,512)}`);}
 if(!object(probe)||probe.error||probe.exitCode!==0||probe.signal)return fail('GRAPHICS_PROBE_FAILED',`Python graphics probe failed: ${String(probe?.error?.code||probe?.signal||(probe?.exitCode??'invalid result')).slice(0,128)}`);
 if(typeof probe.stdout!=='string'||(probe.stderr!==undefined&&typeof probe.stderr!=='string')||Buffer.byteLength(probe.stdout)+Buffer.byteLength(probe.stderr||'')>32768)return fail('GRAPHICS_REPORT_INVALID','Python graphics report exceeds the 32 KiB output bound or has invalid output types.');
 let observed;try{observed=JSON.parse(probe.stdout);}catch{return fail('GRAPHICS_REPORT_INVALID','Python graphics report is not valid JSON.');}
 if(!validReport(observed))return fail('GRAPHICS_REPORT_INVALID','Python graphics report has an invalid or inconsistent schema.');
 result.python=observed.python;result.pathApi=observed.pathApi;
 for(const [name,check] of [['pillow','pngRoundTrip'],['numpy','arrayOperation']])result[name]={version:observed[name].version,[check]:observed[name][check]};
 if(!observed.pathApi.isJunction)fail('PATH_API_MISSING','Python must provide pathlib.Path.is_junction (Python 3.12 or later).');
 if(!observed.pillow.pngRoundTrip)fail('PILLOW_UNAVAILABLE',`Pillow must import and round-trip an RGBA PNG in memory.${observed.pillow.error?' '+observed.pillow.error:''}`);
 if(!observed.numpy.arrayOperation)fail('NUMPY_UNAVAILABLE',`NumPy must import and perform a uint8 array operation.${observed.numpy.error?' '+observed.numpy.error:''}`);
 result.available=result.diagnostics.length===0;return result;
}
module.exports={probeGraphicsPrerequisites,GRAPHICS_PROBE_IMPLEMENTATION_HASH};


