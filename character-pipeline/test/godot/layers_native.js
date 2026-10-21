'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {runTool:defaultRunTool}=require('../../lib/process');
function png(){const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const result=Buffer.alloc(b.length+8);result.writeUInt32BE(data.length);b.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;};const h=Buffer.alloc(13);h.writeUInt32BE(4);h.writeUInt32BE(4,4);h[8]=8;h[9]=6;const rows=Buffer.alloc(68);for(let y=0;y<4;y++)for(let x=0;x<4;x++){const n=y*17+1+x*4;rows[n]=80;rows[n+1]=140;rows[n+2]=180;rows[n+3]=255;}return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(root,'evidence/native-layers'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});
 const image=path.join(out,'fixture.png');await fs.writeFile(image,png());
 const spec=createSpec({id:'nativeLayers',description:'Numeric equal-Z native sibling order fixture'});spec.bones[0].rest.position=[32,32];
 spec.parts=['first','second'].map(id=>({id,role:'root',bone:'root',pivot:[0,0],layer:2,image:{path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1}}));
 spec.animations=[{id:'idle',duration:1,loop:false,events:[],tracks:[]}];
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),logs=[];
 const runTool=async(...args)=>{const result=await defaultRunTool(...args);logs.push({name:args[1],args:args[2],...result});await fs.writeFile(path.join(out,'native-logs.json'),JSON.stringify(logs,null,2));return result;};
 const good=await compileGodot(spec,{config,runTool,stagingDir:path.join(out,'valid'),render:true});
 assert.equal(good.validation.layerOrder?.version,1,'Rendered compiler must emit observed native layer order evidence');
 const flags={zIndex:0,zAsRelative:true,showBehindParent:false,topLevel:false,ySortEnabled:false};
 assert.deepEqual(good.validation.layerOrder,{version:1,root:flags,container:flags,parts:spec.parts.map((p,index)=>({...flags,id:p.id,path:'Meshes/'+p.id,index,zIndex:p.layer}))});
 if(process.argv.includes('--collector-only')){console.log(JSON.stringify({passed:true,collectorOnly:true}));return;}
 assert.equal(good.validation.nativeLayerOrder.status,'passed');assert.equal(good.validation.nativeLayerOrder.checkedPairs,1);
 const negatives={};
 for(const [name,mutation,diagnostic] of [['wrong-z','reloaded.get_node("Meshes/first").z_index += 1','NATIVE_LAYER_MISMATCH'],['wrong-order','reloaded.get_node("Meshes").move_child(reloaded.get_node("Meshes/second"), 0)','NATIVE_PART_ORDER']]){
  let seededScriptHash,failure;
  const mutateNative=async(...args)=>{const script=path.join(out,name,'godot/compile.gd'),source=await fs.readFile(script,'utf8'),needle='\tvar layer_order = null';assert.equal(source.split(needle).length,2);const seeded=source.replace(needle,'\t'+mutation+'\n'+needle);await fs.writeFile(script,seeded);seededScriptHash=crypto.createHash('sha256').update(seeded).digest('hex');return runTool(...args);};
  await assert.rejects(compileGodot(spec,{config,runTool:mutateNative,stagingDir:path.join(out,name),render:true}),e=>{failure={code:e.code,diagnostics:e.diagnostics,report:e.report};return e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.some(d=>d.code===diagnostic);});
  const receipt=JSON.parse(await fs.readFile(path.join(out,name,'godot/validation.json')));assert.deepEqual(receipt.samples,good.validation.samples,'Layer mutation must preserve Bone2D observations');assert.deepEqual(receipt.meshes,good.validation.meshes,'Layer mutation must preserve geometry observations');
  negatives[name]={failure,seededScriptHash,sceneHash:crypto.createHash('sha256').update(await fs.readFile(path.join(out,name,'godot/character.tscn'))).digest('hex'),observed:receipt.layerOrder};
 }
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,positive:good.validation.nativeLayerOrder,positiveObserved:good.validation.layerOrder,sceneHash:crypto.createHash('sha256').update(await fs.readFile(path.join(out,'valid/godot/character.tscn'))).digest('hex'),negatives,boneOriginsUnchanged:true,geometryUnchanged:true},null,2));console.log(JSON.stringify({passed:true,positive:good.validation.nativeLayerOrder.status,negatives:Object.keys(negatives),boneOriginsUnchanged:true,geometryUnchanged:true}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
