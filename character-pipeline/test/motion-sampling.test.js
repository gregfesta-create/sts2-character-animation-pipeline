'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planMotionSampling}=require('../lib/motion-sampling');
const {planNumberBits}=require('../lib/motion-sampling');
const clip=(duration=1)=>({id:'idle',duration,loop:true,tracks:[],events:[]});

test('compiler numeric bit transport preserves exact fractional plans without mutating authored values',()=>{
 const value=0.42000000000000004;
 const plans={motionPlan:{clips:[{duration:value,times:[0,value],maximumGapSeconds:value}]},maskPlan:{captures:[{time:value}]}};
 const before=structuredClone(plans),bits=planNumberBits(plans);
 assert.equal(bits.length,4);
 const parsed=JSON.parse(JSON.stringify(plans).replaceAll('0.42000000000000004','0.42'));
 for(const entry of bits){let target=parsed;for(const key of entry.path.slice(0,-1))target=target[key];target[entry.path.at(-1)]=Buffer.from(entry.hex,'hex').readDoubleLE();}
 assert.deepEqual(parsed,plans);assert.deepEqual(plans,before);
 assert(bits.every(entry=>/^[0-9a-f]{16}$/.test(entry.hex)));
});

test('compiler numeric bit transport bounds entries depth and restricts named plans',()=>{
 for(const plans of [{other:{time:.1}},{motionPlan:{time:Infinity}},{maskPlan:{times:Array(8193).fill(.1)}}])assert.throws(()=>planNumberBits(plans),{code:'INVALID_MOTION_SAMPLING'});
 let deep={time:.1};for(let i=0;i<17;i++)deep={nested:deep};assert.throws(()=>planNumberBits({motionPlan:deep}),{code:'INVALID_MOTION_SAMPLING'});
 const hostile={};Object.defineProperty(hostile,'motionPlan',{get(){throw Error('executed');},enumerable:true});assert.throws(()=>planNumberBits(hostile),{code:'INVALID_MOTION_SAMPLING'});
 assert.deepEqual(planNumberBits({motionPlan:null,maskPlan:{count:1}}),[]);
});

test('compiler numeric transport preserves internal rest anchors and render layout exactly',()=>{
 const metadata={nativeRestAnchors:[{restAnchor:[10,110.22084859876185]}],renderLayout:{scale:0.42000000000000004,pixels:[512,512]}};
 const before=structuredClone(metadata),bits=planNumberBits(metadata);
 assert.equal(bits.length,2);
 const parsed=JSON.parse(JSON.stringify(metadata).replace('110.22084859876185','110.22084859876183').replace('0.42000000000000004','0.42'));
 for(const entry of bits){let target=parsed;for(const key of entry.path.slice(0,-1))target=target[key];target[entry.path.at(-1)]=Buffer.from(entry.hex,'hex').readDoubleLE();}
 assert.deepEqual(parsed,metadata);assert.deepEqual(metadata,before);
 for(const authored of [{bones:[{position:[.1,.2]}]},{animations:[{time:.1}]},{parts:[{mesh:{vertices:[[.1,.2]]}}]}])assert.throws(()=>planNumberBits(authored),{code:'INVALID_MOTION_SAMPLING'});
});
test('normal timeline is immutable, deterministic, canonical and includes endpoints',()=>{
 const input=[clip()],a=planMotionSampling(input);assert.equal(a.clips[0].times.length,17);assert.equal(a.clips[0].times[0],0);assert.equal(a.clips[0].times.at(-1),1);assert.equal(a.clips[0].undersampled,false);assert.deepEqual(a,planMotionSampling(input));assert(Object.isFrozen(a.clips[0].times));assert.equal(a.dispatchRuntimeCues,false);assert.deepEqual(input,[clip()]);
});
test('short clips keep exact endpoints and authored rapid keys and markers',()=>{
 const c=clip(.001);c.tracks=[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.0001,value:1},{time:.001,value:0}]}];c.events=[{id:'release',name:'release',time:.0002}];const p=planMotionSampling([c]).clips[0];assert.deepEqual(p.times,[0,.0001,.0002,.001]);assert.deepEqual(p.omittedEventTimes,[]);assert.deepEqual(p.omittedKeyTimes,[]);
});
test('bounded timelines disclose omitted authored times and cadence gaps',()=>{
 const c=clip(600);c.events=Array.from({length:100},(_,i)=>({id:'e'+i,name:'event',time:i+.25}));c.tracks=[{bone:'root',property:'rotation',keys:Array.from({length:100},(_,i)=>({time:i+.5,value:0}))}];const p=planMotionSampling([c]).clips[0];assert.equal(p.times.length,64);assert.equal(p.times.at(-1),600);assert(p.undersampled);assert(p.omittedEventTimes.length);assert(p.omittedKeyTimes.length);assert(p.maximumGapSeconds>1/16);assert.equal(new Set(p.times).size,p.times.length);
});
test('clip budgets are independent and configurable',()=>{const a=clip(2),b={...clip(.25),id:'attack'};const p=planMotionSampling([a,b],{framesPerSecond:8,maxFramesPerClip:4});assert.equal(p.clips[0].times.length,4);assert.equal(p.clips[1].times.length,3);assert.equal(p.clips[1].undersampled,false);});

test('shared capacity retains asymmetric drawing changes using unused idle capacity',()=>{
 const attack={...clip(),id:'attack',loop:false,poseTracks:[{group:'drawings',keys:Array.from({length:42},(_,i)=>({time:i/42,part:'pose'+i}))}]};
 const input=[clip(),attack],before=structuredClone(input),p=planMotionSampling(input,{maxTotalFrames:64});
 assert.equal(p.maxTotalFrames,64);assert(p.clips.reduce((n,c)=>n+c.times.length,0)<=64);
 for(const key of attack.poseTracks[0].keys)assert(p.clips[1].times.includes(key.time));
 assert.deepEqual(p.clips[1].omittedKeyTimes,[]);assert.deepEqual(input,before);assert(Object.isFrozen(p.clips[1].times));
 assert.equal(Object.hasOwn(planMotionSampling([clip()]),'maxTotalFrames'),false);
});

test('shared priorities allocate events globally before keys and cadence with deterministic spread',()=>{
 const make=id=>({...clip(),id,events:[.1,.2,.3,.4].map((time,i)=>({id:'e'+i,name:'event',time})),tracks:[{bone:'root',property:'rotation',keys:[{time:.5,value:0}]}]});
 const input=[make('one'),make('two')],p=planMotionSampling(input,{maxTotalFrames:7});
 assert.deepEqual(p.clips.map(c=>c.times),[[0,.2,.4,1],[0,.3,1]]);
 assert.deepEqual(p,planMotionSampling(input,{maxTotalFrames:7}));
 for(let i=0;i<input.length;i++){
  const c=p.clips[i];assert.deepEqual(c.omittedEventTimes,input[i].events.map(e=>e.time).filter(t=>!c.times.includes(t)));
  assert.deepEqual(c.omittedKeyTimes,[.5]);assert(c.undersampled);assert.equal(c.maximumGapSeconds,Math.max(...c.times.slice(1).map((t,j)=>t-c.times[j])));
 }
 const keyOnly={...clip(),id:'keys',tracks:[{bone:'root',property:'rotation',keys:[{time:.123,value:0}]}]};
 const eventOnly={...clip(),id:'events',events:[{id:'release',name:'release',time:.789}]};
 assert.deepEqual(planMotionSampling([keyOnly,eventOnly],{maxTotalFrames:5}).clips.map(c=>c.times),[[0,1],[0,.789,1]]);
 assert.deepEqual(planMotionSampling([keyOnly,clip(.001)],{maxTotalFrames:5}).clips.map(c=>c.times),[[0,.123,1],[0,.001]]);
 const exact={...clip(),loop:false,events:[{id:'same',name:'same',time:.42}],tracks:[{bone:'root',property:'rotation',keys:[{time:.42,value:0},{time:.42000000000000004,value:1}]}]};
 const exactPlan=planMotionSampling([exact],{maxTotalFrames:4}).clips[0];
 assert.deepEqual(exactPlan.times,[0,.42,.42000000000000004,1]);assert.deepEqual(exactPlan.omittedKeyTimes,[]);
});

test('shared limits reserve exact endpoints and respect each clip cap',()=>{
 const clips=Array.from({length:32},(_,i)=>({...clip(.001+i/1000),id:'c'+i}));
 assert.deepEqual(planMotionSampling(clips,{maxTotalFrames:64}).clips.map(c=>c.times),clips.map(c=>[0,c.duration]));
 const p=planMotionSampling([clip(),{...clip(),id:'other'}],{maxTotalFrames:100,maxFramesPerClip:3});
 assert(p.clips.every(c=>c.times.length===3));
 assert.equal(planMotionSampling([clip(.001),{...clip(),id:'long'}],{maxTotalFrames:8}).clips[0].times.length,2);
 for(const value of [null,1,3,2049,4.5,Infinity,'64'])assert.throws(()=>planMotionSampling([clip(),{...clip(),id:'other'}],{maxTotalFrames:value}),{code:'INVALID_MOTION_SAMPLING'});
 let executed=false;const options={};Object.defineProperty(options,'maxTotalFrames',{enumerable:true,get(){executed=true;return 64;}});
 assert.throws(()=>planMotionSampling([clip()],options),{code:'INVALID_MOTION_SAMPLING'});assert.equal(executed,false);
 assert.throws(()=>planMotionSampling([clip(),{...clip(),id:'invalid',events:[{id:'late',name:'late',time:2}]}],{maxTotalFrames:4}),{code:'INVALID_MOTION_SAMPLING'});
});

test('twenty drawing poses retain their exact change times in native previews',()=>{
 const c={...clip(),loop:false,poseTracks:[{group:'drawings',keys:Array.from({length:20},(_,i)=>({time:i/20,part:'pose'+i}))}]};
 const before=structuredClone(c),p=planMotionSampling([c],{maxFramesPerClip:32}).clips[0];
 for(const key of c.poseTracks[0].keys)assert(p.times.includes(key.time),'Missing drawing time '+key.time);
 assert.deepEqual(p.omittedKeyTimes,[]);assert.deepEqual(c,before);
 const bounded=planMotionSampling([c],{maxFramesPerClip:4}).clips[0];
 assert.equal(bounded.times.length,4);assert(bounded.omittedKeyTimes.length>0);
 assert.deepEqual([...bounded.times,...bounded.omittedKeyTimes].filter(t=>t<1).sort((a,b)=>a-b),c.poseTracks[0].keys.map(k=>k.time));
});

test('drawing timelines reject duplicate groups and invalid change ordering independently',()=>{
 const make=()=>({...clip(),loop:false,poseTracks:[{group:'drawings',keys:[{time:0,part:'open'},{time:.5,part:'reach'}]}]});
 for(const change of [c=>c.poseTracks.push(structuredClone(c.poseTracks[0])),c=>c.poseTracks[0].keys[0].time=.1,c=>c.poseTracks[0].keys[1].time=0,c=>c.poseTracks[0].keys[1].time=1.1,c=>{c.loop=true;c.poseTracks[0].keys[1].time=1;}]){
  const c=make();change(c);assert.throws(()=>planMotionSampling([c]),{code:'INVALID_MOTION_SAMPLING'});
 }
 const endpoint=make();endpoint.poseTracks[0].keys[1].time=1;assert.doesNotThrow(()=>planMotionSampling([endpoint]));
});
test('invalid and excessive inputs reject rather than silently truncate',()=>{
 for(const bad of [null,[],Array(1),Array.from({length:33},()=>clip()),[clip(NaN)],[clip(0)],[clip(601)],[{...clip(),extra:true}],[{...clip(),events:[{id:'x',name:'x',time:2}]}],[{...clip(),tracks:[{bone:'root',property:'rotation',keys:[{time:.5,value:0},{time:.4,value:0}]}]}],[clip(),clip()]])assert.throws(()=>planMotionSampling(bad),{code:'INVALID_MOTION_SAMPLING'});
 for(const options of [{maxFramesPerClip:1},{maxFramesPerClip:65},{framesPerSecond:0},{framesPerSecond:121},{unexpected:true}])assert.throws(()=>planMotionSampling([clip()],options),{code:'INVALID_MOTION_SAMPLING'});
 const hostile=clip();Object.defineProperty(hostile,'duration',{get(){throw Error('getter executed');},enumerable:true});assert.throws(()=>planMotionSampling([hostile]),{code:'INVALID_MOTION_SAMPLING'});
});

test('rejects sparse arrays disguised by named keys and inherited array execution',()=>{
 const sparse=Array(1);sparse.extra={};assert.throws(()=>planMotionSampling(sparse),{code:'INVALID_MOTION_SAMPLING'});
 let executed=false;const custom=[clip()];Object.setPrototypeOf(custom,{[Symbol.iterator](){executed=true;throw Error('unexpected iterator');}});assert.throws(()=>planMotionSampling(custom),{code:'INVALID_MOTION_SAMPLING'});assert.equal(executed,false);
 class CustomArray extends Array {}const subclass=new CustomArray(clip());assert.throws(()=>planMotionSampling(subclass),{code:'INVALID_MOTION_SAMPLING'});
 const extra=[clip()];extra.extra={};assert.throws(()=>planMotionSampling(extra),{code:'INVALID_MOTION_SAMPLING'});
});
