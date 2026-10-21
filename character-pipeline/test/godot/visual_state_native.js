'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {runTool}=require('../../lib/process');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
async function main(){
 const i=process.argv.indexOf('--evidence');
 const evidence=path.resolve(i<0?path.join(__dirname,'../../evidence/w4-visual-state'):process.argv[i+1]);
 await fs.mkdir(evidence,{recursive:true});
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const chunk=(name,data)=>{const b=Buffer.concat([Buffer.from(name),data]);let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=c>>>1^(c&1?0xedb88320:0);}const out=Buffer.alloc(b.length+8);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((c^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
 const texture=path.join(evidence,'fixture.png');await fs.writeFile(texture,png);
 const spec=createSpec({id:'visualStatesFixture',description:'synthetic state roundtrip',template:'custom'});
 spec.parts=['body','arrow'].map((id,index)=>({id,role:id,bone:'root',pivot:[0,0],layer:index,image:{path:texture,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1},mesh:{vertices:[[index*25,0],[index*25+20,0],[index*25+20,20],[index*25,20]],uv:[[0,0],[1,0],[1,1],[0,1]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:1}])}}));
 spec.visualStates=[{id:'bodyOnly',parts:['body']},{id:'empty',parts:[]},{id:'all',parts:['body','arrow']}];
 const compiled=await compileGodot(spec,{config,stagingDir:path.join(evidence,'compiled')});
 const out=compiled.project;
 await fs.copyFile(path.join(__dirname,'visual_state_runtime.gd'),path.join(out,'visual_state_runtime.gd'));
 const tool=config.tools.megadot||config.tools.godot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',out,'--log-file',path.join(out,'native.log'),'--script','res://visual_state_runtime.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));
 if(!report.checks.length||report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));
 console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});


