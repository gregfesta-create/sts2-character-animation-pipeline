'use strict';
// Explicit opt-in numeric compile/save/reload fixture; no creative services.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {compileGodot}=require('../../backends/godot');
const {runTool}=require('../../lib/process');
const {resolveContained}=require('../../lib/assets');
const {fixture,png}=require('./component_engine_native');
async function main(){
 const root=path.resolve(__dirname,'../..'),index=process.argv.indexOf('--evidence');
 const relative=index<0?'evidence/canvas-metadata-native':process.argv[index+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain inside the pipeline workspace.');
 const evidence=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(evidence,{recursive:true});
 const image=path.join(evidence,'numeric.png');await fs.writeFile(image,png([60,120,180]));
 const spec=fixture('canvasMetadata',image);spec.canvas.width=123;spec.canvas.height=257;
 Object.assign(spec.parts[0].image,{prepared:true,width:16,height:16,alphaBounds:[0,0,16,16],cropTranslation:[0,0],pivot:[8,8],pixelsPerUnit:1});
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'),'utf8'));
 for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const logs=[];
 const observedRun=async(...args)=>{const result=await runTool(...args);logs.push(result);await fs.writeFile(path.join(evidence,'native-logs.json'),JSON.stringify(logs,null,2));return result;};
 const compiled=await compileGodot(spec,{config,runTool:observedRun,stagingDir:path.join(evidence,'compiled'),render:false});
 const project=path.dirname(compiled.scene);
 const probe=`extends SceneTree
func _initialize():
 var packed=load("res://character.tscn")
 var instance=packed.instantiate()
 var value=instance.get_meta("canonical_canvas",null)
 var valid=value is Vector2 and value==Vector2(123,257)
 var output={"passed":valid,"present":instance.has_meta("canonical_canvas"),"type":type_string(typeof(value)),"dimensions":[value.x,value.y] if value is Vector2 else []}
 var file=FileAccess.open("res://canvas-metadata.json",FileAccess.WRITE)
 file.store_string(JSON.stringify(output))
 instance.free()
 quit(0 if valid else 1)
`;
 const script=path.join(project,'canvas_probe.gd');await fs.writeFile(script,probe);
 const native=await observedRun({native:config.tools.megadot||config.tools.godot},'native',['--headless','--path',project,'--script','res://canvas_probe.gd'],{timeoutMs:30000});
 const observed=JSON.parse(await fs.readFile(path.join(project,'canvas-metadata.json'),'utf8'));
 const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({observed,sceneHash:await hash(compiled.scene),probeHash:await hash(script),compilerHash:await hash(path.join(project,'compile.gd')),syntheticOnly:true},null,2));
 assert.equal(native.error,null);assert.equal(/SCRIPT ERROR|ERROR:/.test(native.stdout+native.stderr),false);
 assert.deepEqual(observed,{passed:true,present:true,type:'Vector2',dimensions:[123,257]});assert.equal(native.exitCode,0);
 console.log(JSON.stringify({passed:true,dimensions:observed.dimensions}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
