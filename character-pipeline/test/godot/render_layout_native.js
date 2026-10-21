'use strict';
// Explicit opt-in real-engine proof with synthetic rectangles only.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {inspectRenderedFrames}=require('../../lib/visual-inspection');
const {planRenderViewport}=require('../../lib/render-layout');
function png(){
 const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const result=Buffer.alloc(b.length+8);result.writeUInt32BE(data.length);b.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(4,4);header[8]=8;header[9]=6;const rows=Buffer.alloc(68);for(let y=0;y<4;y++)for(let x=0;x<4;x++){const n=y*17+1+x*4;rows[n]=200;rows[n+1]=80;rows[n+2]=40;rows[n+3]=255;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(root,'evidence/render-layout-native'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});
 const image=path.join(out,'fixture.png');await fs.writeFile(image,png());
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),results=[];
 for(const [id,width,height,position]of [['wide',2048,256,[1900,128]],['tall',256,2048,[128,1900]],['fractional',1535,257,[1400,128]]]){
  const spec=createSpec({id,description:'Synthetic full-canvas projection fixture'});Object.assign(spec.canvas,{width,height});spec.bones[0].rest.position=position;
  spec.parts=[{id:'panel',role:'root',bone:'root',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1/16}}];
  spec.animations=[{id:'idle',duration:1,loop:true,tracks:[],events:[]}];
  const compiled=await compileGodot(spec,{config,stagingDir:path.join(out,id),render:true}),layout=planRenderViewport(spec.canvas,17);
  assert.deepEqual(compiled.validation.renderLayout,layout);assert.deepEqual(compiled.validation.renderProjection.pixels,layout.pixels);
  for(const sample of compiled.validation.samples)assert.deepEqual(sample.bones.root.slice(0,2),position);
  assert.equal(compiled.validation.geometry.report.coverage.loopEndpoints,1);assert.equal(compiled.validation.geometry.status,'passed');
  const scene=await fs.readFile(compiled.scene,'utf8');assert.doesNotMatch(scene,/canvas_transform|renderLayout/);
  const pixels=await inspectRenderedFrames(compiled.frames.map(f=>path.basename(f)),{sourceRoot:compiled.project,stagingDir:out,config});
  for(const frame of pixels.frames){
   assert.deepEqual([frame.width,frame.height],layout.pixels);assert(frame.visiblePixels>100&&frame.visiblePixels<1000);
   const [x0,y0,x1,y1]=frame.alphaBounds;
   assert(Math.abs(x0-position[0]*layout.scale)<=2);assert(Math.abs(y0-position[1]*layout.scale)<=2);
   assert(Math.abs(x1-(position[0]+64)*layout.scale)<=2);assert(Math.abs(y1-(position[1]+64)*layout.scale)<=2);assert.equal(frame.edgeTouchRisk,false);
  }
  results.push({id,layout,projection:compiled.validation.renderProjection,frames:pixels.frames,canonicalPosition:position,loopCoverage:compiled.validation.geometry.report.coverage.loopEndpoints});
 }
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,fixtures:results.map(r=>r.id),canonicalCoordinatesPreserved:true,transparentBackground:true}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});

