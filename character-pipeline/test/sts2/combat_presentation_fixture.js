'use strict';
// Synthetic developer geometry and presentation rules only. The caller supplies
// real fixture source evidence; this is not a discovery result for user mods.
// Caller contract: supply an opaque WHITE one-pixel RGBA PNG. Tint is
// multiplicative, so a colored source (for example red) would hide green poison.
// This trusted fixture helper checks dimensions; caller owns pixel provenance.
const path=require('node:path'),crypto=require('node:crypto');
const {createSpec}=require('../../lib/spec');
const {hashValue}=require('../../lib/assets');
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function createCombatPresentationFixture({imagePath,pngBytes,powerSourceBytes,powerSourcePath,powerSymbol}={}){
 if(typeof imagePath!=='string'||!path.isAbsolute(imagePath)||typeof powerSourcePath!=='string'||!path.isAbsolute(powerSourcePath))throw new Error('Absolute synthetic image and actual fixture source paths required');
 if(!Buffer.isBuffer(pngBytes)||pngBytes.length<24||!pngBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||pngBytes.readUInt32BE(16)!==1||pngBytes.readUInt32BE(20)!==1)throw new Error('Caller must supply one-pixel synthetic PNG bytes');
 if(!Buffer.isBuffer(powerSourceBytes)||powerSourceBytes.length===0||powerSourceBytes.length>1048576||typeof powerSymbol!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(powerSymbol))throw new Error('Bounded actual fixture source and symbol required');
 const lines=powerSourceBytes.toString('utf8').split(/\r?\n/),line=lines.findIndex(s=>new RegExp('\\bclass\\s+'+powerSymbol+'\\b').test(s));
 if(line<0||Buffer.byteLength(lines[line])>8192)throw new Error('Actual fixture class declaration evidence required');
 const spec=createSpec({id:'combatBowFixture',description:'Synthetic developer combat presentation fixture',template:'custom'});
 spec.canvas={width:512,height:512,units:'pixels',xAxis:'right',yAxis:'down',rotation:'clockwise-radians'};spec.export.playback='tree';
 spec.bones=[{id:'root',parent:null,rest:{position:[120,220],rotation:0,scale:[1,1]},length:1},...['upper','lower','nock'].map(id=>({id,parent:'root',rest:{position:id==='nock'?[-10,0]:[0,0],rotation:0,scale:[1,1]},length:60})),...['upper','lower'].map((id,i)=>({id:id+'Tip',parent:id,rest:{position:[10,i?30:-30],rotation:0,scale:[1,1]},length:36}))];
 const image={path:imagePath,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1};
 spec.parts=[{id:'arrow',role:'arrow',bone:'nock',pivot:[0,0],layer:3,image:structuredClone(image),mesh:{vertices:[[0,-3],[55,-3],[65,0],[55,3],[0,3]],uv:[[0,0],[1,0],[1,.5],[1,1],[0,1]],triangles:[[0,1,4],[1,3,4],[1,2,3]],weights:Array.from({length:5},()=>[{bone:'nock',weight:1}])}},...['upper','lower'].map((id,i)=>{
  const sign=i?1:-1,centers=[[0,0],[8,sign*15],[10,sign*30],[3,sign*46],[-10,sign*60]],vertices=[],uv=[],weights=[],triangles=[];
  centers.forEach(([x,y],row)=>{vertices.push([x-3,y],[x+3,y]);uv.push([0,row/4],[1,row/4]);const influence=row===0?[{bone:'root',weight:1}]:row===1?[{bone:'root',weight:.5},{bone:id,weight:.5}]:row===2?[{bone:id,weight:1}]:row===3?[{bone:id,weight:.3},{bone:id+'Tip',weight:.7}]:[{bone:id+'Tip',weight:1}];weights.push(structuredClone(influence),structuredClone(influence));if(row<4){const a=row*2;triangles.push([a,a+1,a+3],[a,a+3,a+2]);}});
  return {id,role:id,bone:'root',pivot:[0,0],layer:2,image:structuredClone(image),mesh:{vertices,uv,weights,triangles}};
 })];
 spec.polylines=[{id:'string',anchors:[{bone:'upperTip',position:[-20,-30]},{bone:'nock',position:[0,0]},{bone:'lowerTip',position:[-20,30]}],width:2,color:[1,1,1,1],layer:4}];
 spec.sockets=[{id:'release',bone:'nock',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
 const releaseAt=.5,impactAt=1,clipIds={first:'attack',second:'attackUnbuffed'},bindingIds={active:'poisonActive',snapshot:'poisonSnapshot'};
 spec.projectiles=[{id:'arrowShot',part:'arrow',forward:[1,0],flightDuration:impactAt-releaseAt,lifetime:2,removalPolicy:'cancel'}];spec.sounds=[];
 const tracks=[{bone:'nock',property:'position',keys:[{time:0,value:[-10,0]},{time:.4,value:[-55,0]},{time:releaseAt,value:[-55,0]},{time:.6,value:[-10,0]},{time:1.2,value:[-10,0]}]},... [['upper',-.1],['lower',.1],['upperTip',-.35],['lowerTip',.35]].map(([bone,value])=>({bone,property:'rotation',keys:[{time:0,value:0},{time:.4,value},{time:releaseAt,value},{time:.6,value:0},{time:1.2,value:0}]}))];
 spec.animations=[{id:'idle',duration:1,loop:true,tracks:[],events:[]},...Object.values(clipIds).map(id=>({id,duration:1.2,loop:false,tracks:structuredClone(tracks),events:['shootA','shootB'].map(id=>({id,type:'projectile',time:releaseAt,payload:{projectile:'arrowShot',sourceSocket:'release',nockedPart:'arrow'}}))}))];
 const sourceHash=crypto.createHash('sha256').update(powerSourceBytes).digest('hex'),hash=crypto.createHash('sha256').update(pngBytes).digest('hex'),styleHash=hashValue(spec.style);
 const evidence={id:'fixturePowerSource',path:powerSourcePath,hash:sourceHash,symbol:powerSymbol,lineStart:line+1,lineEnd:line+1,excerpt:lines[line]};
 const mechanics=Object.values(bindingIds).map(id=>({key:'synthetic.fixture.'+id,evidenceIds:[evidence.id]})),fingerprint=hashValue({sourceHash,mechanics});
 const bindings=Object.values(bindingIds).map((id,i)=>({id,mechanicKey:mechanics[i].key,adapterContractVersion:'1'}));
 const decisions=['whileActive','attackSnapshot'].map((scope,i)=>({id:Object.values(bindingIds)[i],mechanicKey:mechanics[i].key,outcome:'effect',reason:'Synthetic developer fixture: explicit active/snapshot views of the supplied fixture power, not user-mechanic discovery',evidenceIds:[evidence.id],bindingId:bindings[i].id,rule:{effectIds:['greenTip'],condition:{type:'amountAtLeast',threshold:1},scope,socketId:'release',channel:'tip',priority:1}}));
 const effectBuild={styleHash,plan:{version:1,characterId:spec.id,mechanicsFingerprint:fingerprint,inspectionVersion:'1',adapterContractVersion:'1',evidence:[structuredClone(evidence)],decisions},inventory:{version:1,complete:true,characterId:spec.id,fingerprint,evidence:[structuredClone(evidence)],mechanics},bindings,resources:[{hash,base64:pngBytes.toString('base64'),size:pngBytes.length,importSettings:{},styleProvenance:styleHash,approvalProvenance:'synthetic developer fixture only'}],catalog:[{id:'greenTip',capability:'tint',resourceHashes:[hash],presentation:{color:[0,1,0,1]}}],targets:{release:{partId:'arrow'}}};
 return freeze({spec,effectBuild,releaseAt,impactAt,clipIds,bindingIds});
}
module.exports={createCombatPresentationFixture};
