'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {runTool:defaultRunTool}=require('../../lib/process');
function png(){const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const result=Buffer.alloc(b.length+8);result.writeUInt32BE(data.length);b.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;};const h=Buffer.alloc(13);h.writeUInt32BE(4);h.writeUInt32BE(4,4);h[8]=8;h[9]=6;const rows=Buffer.alloc(68);for(let y=0;y<4;y++)for(let x=0;x<4;x++){const n=y*17+1+x*4;rows[n]=100;rows[n+1]=150;rows[n+2]=180;rows[n+3]=255;}return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(root,'evidence/native-skinning'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});
 const image=path.join(out,'fixture.png');await fs.writeFile(image,png());
 const spec=createSpec({id:'nativeSkinning',description:'Numeric mixed-weight renderer skinning fixture'});
 spec.bones[0].rest.position=[32,32];spec.bones.push({id:'hand',parent:'root',rest:{position:[6,0],rotation:.37,scale:[-1,1.5]},length:6});
 spec.parts=[{id:'body',role:'root',bone:'hand',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[1,2],pixelsPerUnit:2},mesh:{vertices:[[0,0],[4,0],[4,4],[0,4]],uv:[[0,0],[4,0],[4,4],[0,4]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:.5},{bone:'hand',weight:.5}])}}];
 spec.animations=[{id:'idle',duration:1,loop:false,events:[],tracks:[{bone:'hand',property:'rotation',keys:[{time:0,value:.37},{time:1,value:.7}]}]}];
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),logs=[];
 const runTool=async(...args)=>{const result=await defaultRunTool(...args);logs.push({name:args[1],args:args[2],...result});await fs.writeFile(path.join(out,'native-logs.json'),JSON.stringify(logs,null,2));return result;};
 const good=await compileGodot(spec,{config,runTool,stagingDir:path.join(out,'valid'),render:true});
 assert.equal(good.validation.skinning?.version,1,'Rendered compiler must emit observed native skinning evidence');
 if(process.argv.includes('--red'))return;
 const {inspectNativeSkinning}=require('../../lib/native-skinning');
 const report=inspectNativeSkinning(spec,good.validation.motionPlan,good.validation.skinning);
 assert.equal(report.status,'passed');
 let seededScriptHash,failure,negative;
 const mutateNative=async(...args)=>{
  const script=path.join(out,'wrong-matrix/godot/compile.gd'),source=await fs.readFile(script,'utf8');
  const needle='\t\t\t\tvar skin_matrices = {}';assert.equal(source.split(needle).length,2);
  const seeded=source.replace(needle,'\t\t\t\tRenderingServer.skeleton_bone_set_transform_2d(skin_skeleton.get_skeleton(), reloaded.get_node(paths["root"]).get_index_in_skeleton(), Transform2D(Vector2(-3,0),Vector2(0,1),Vector2.ZERO))\n\t\t\t\tawait RenderingServer.frame_post_draw\n'+needle);
  await fs.writeFile(script,seeded);seededScriptHash=crypto.createHash('sha256').update(seeded).digest('hex');return runTool(...args);
 };
 try{negative=await compileGodot(spec,{config,runTool:mutateNative,stagingDir:path.join(out,'wrong-matrix'),render:true});inspectNativeSkinning(spec,negative.validation.motionPlan,negative.validation.skinning);}catch(error){failure={code:error.code,diagnostics:error.diagnostics,report:error.report};}
 assert.equal(failure?.code,'VISUAL_VALIDATION_FAILED');assert(failure.diagnostics.some(d=>d.code==='NATIVE_TRIANGLE_INVERSION'));
 assert(failure.report.triangleFailureCount>0,'Reflection must independently fail triangle winding');
 const badReceipt=JSON.parse(await fs.readFile(path.join(out,'wrong-matrix/godot/validation.json')));
 assert.deepEqual(badReceipt.samples,good.validation.samples,'RenderingServer mutation must preserve Bone2D observations');
 let translationScriptHash,translationFailure;
 const translateNative=async(...args)=>{
  const script=path.join(out,'translated-matrices/godot/compile.gd'),source=await fs.readFile(script,'utf8');
  const needle='\t\t\t\tvar skin_matrices = {}';assert.equal(source.split(needle).length,2);
  const seeded=source.replace(needle,'\t\t\t\tfor translated_bone in skinning.bones:\n\t\t\t\t\tvar translated_index = translated_bone.index\n\t\t\t\t\tvar translated_matrix = RenderingServer.skeleton_bone_get_transform_2d(skin_skeleton.get_skeleton(), translated_index)\n\t\t\t\t\ttranslated_matrix.origin.x += 8\n\t\t\t\t\tRenderingServer.skeleton_bone_set_transform_2d(skin_skeleton.get_skeleton(), translated_index, translated_matrix)\n\t\t\t\tawait RenderingServer.frame_post_draw\n'+needle);
  await fs.writeFile(script,seeded);translationScriptHash=crypto.createHash('sha256').update(seeded).digest('hex');return runTool(...args);
 };
 try{await compileGodot(spec,{config,runTool:translateNative,stagingDir:path.join(out,'translated-matrices'),render:true});}catch(error){translationFailure={code:error.code,diagnostics:error.diagnostics,report:error.report};}
 assert.equal(translationFailure?.code,'VISUAL_VALIDATION_FAILED');
 assert(translationFailure.diagnostics.some(d=>d.code==='NATIVE_VERTEX_REGISTRATION_ERROR'&&Math.abs(d.measured-8)<1e-4&&d.limit===2));
 assert.equal(translationFailure.report.triangleFailureCount,0);assert(translationFailure.report.registrationFailureCount>0);
 const translatedReceipt=JSON.parse(await fs.readFile(path.join(out,'translated-matrices/godot/validation.json')));
 assert.deepEqual(translatedReceipt.samples,good.validation.samples,'Translated renderer matrices must preserve Bone2D observations');
 const areas=receipt=>receipt.skinning.samples.flatMap(sample=>receipt.skinning.meshes.flatMap(mesh=>{
  const vertices=mesh.positions.map((v,index)=>{const influences=mesh.influences[index].filter(i=>i.weight>0),sum=influences.reduce((n,i)=>n+i.weight,0);return influences.reduce((p,i)=>{const m=sample.matrices[i.bone],w=i.weight/sum;return[p[0]+w*(m[0]*v[0]+m[2]*v[1]+m[4]),p[1]+w*(m[1]*v[0]+m[3]*v[1]+m[5])];},[0,0]);});
  return mesh.triangles.map(([a,b,c])=>(vertices[b][0]-vertices[a][0])*(vertices[c][1]-vertices[a][1])-(vertices[b][1]-vertices[a][1])*(vertices[c][0]-vertices[a][0]));
 }));
 const baselineAreas=areas(good.validation),translatedAreas=areas(translatedReceipt);assert.equal(translatedAreas.length,baselineAreas.length);translatedAreas.forEach((area,index)=>assert(Math.abs(area-baselineAreas[index])<1e-4,'Pure translation must preserve projected triangle signed areas'));
 const sceneHashes={};for(const name of ['valid','wrong-matrix','translated-matrices'])sceneHashes[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(out,name,'godot/character.tscn'))).digest('hex');
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,positive:report,failure,translationFailure,seededScriptHash,translationScriptHash,sceneHashes,boneOriginsUnchanged:true,triangleAreasUnchanged:true,baselineAreas,translatedAreas},null,2));console.log(JSON.stringify({passed:true,positive:report.status,negative:failure.diagnostics.find(d=>d.code==='NATIVE_TRIANGLE_INVERSION').code,translation:translationFailure.diagnostics[0].code,boneOriginsUnchanged:true,triangleAreasUnchanged:true}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
