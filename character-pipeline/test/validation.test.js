'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateTelemetry}=require('../lib/validation');
function fixture(){return {version:1,thresholdVersion:'telemetry-v1',attachments:[{id:'rest',phase:'rest',expected:[0,0],actual:[1,0]},{id:'motion',phase:'moving',expected:[0,0],actual:[0,2]}],weights:[{id:'vertex',sum:1.000005}],triangles:[{id:'triangle',restSignedArea:2,signedArea:1}],inversionExceptions:[],loopEndpoints:[{id:'loop',clipId:'idle',jointId:'hand',start:[0,0],end:[1,0]}],frameJumpThresholds:[{clipId:'attack',normalizationPx:100,maxNormalizedJump:.1}],frameJumps:[{id:'jump',clipId:'attack',fromFrame:0,toFrame:1,from:[0,0],to:[10,0]}]};}
test('derives approved geometric thresholds and leaves visual quality unverified',()=>{
 const result=validateTelemetry(fixture());assert.equal(result.status,'passed');assert.equal(result.visualQuality,'unverified');assert.equal(result.scope,'telemetry-only');assert.equal(result.thresholdVersion,'telemetry-v1');assert.deepEqual(result.failures,[]);assert.equal(result.coverage.attachments,2);assert.equal(result.coverage.frameJumps,1);
});
test('seeded independent geometric defects report exact measurements and limits',()=>{
 const input=fixture();input.attachments[0].actual=[1.1,0];input.attachments[1].actual=[0,2.1];input.weights[0].sum=.9;input.triangles[0].signedArea=-1;input.loopEndpoints[0].end=[2,0];input.frameJumps[0].to=[20,0];
 const result=validateTelemetry(input);assert.equal(result.status,'failed');assert.deepEqual(result.failures.map(f=>f.code),['ATTACHMENT_ERROR','ATTACHMENT_ERROR','WEIGHT_SUM','TRIANGLE_INVERSION','LOOP_SEAM','FRAME_JUMP']);assert.equal(result.failures[0].measured,1.1);assert.equal(result.failures[0].limit,1);assert.equal(result.failures.at(-1).measured,.2);assert.equal(result.failures.at(-1).limit,.1);
});
test('specific documented inversion exceptions are visible and never excuse collapse',()=>{
 const input=fixture();input.triangles[0].signedArea=-2;input.inversionExceptions=[{triangleId:'triangle',reason:'Intentional folding in this sampled pose'}];
 const result=validateTelemetry(input);assert.equal(result.status,'passed');assert.deepEqual(result.appliedExceptions,[{triangleId:'triangle',reason:'Intentional folding in this sampled pose'}]);
 input.triangles[0].signedArea=0;assert.equal(validateTelemetry(input).failures[0].code,'TRIANGLE_COLLAPSE');
});
test('refuses malformed, nonfinite, oversized and ambiguous telemetry',()=>{
 const changes=[x=>x.thresholdVersion='future',x=>x.attachments[0].actual=[NaN,0],x=>x.weights[0].sum=-1,x=>x.triangles[0].restSignedArea=0,x=>x.inversionExceptions=[{triangleId:'unknown',reason:'not present'}],x=>x.inversionExceptions=[{triangleId:'triangle',reason:''}],x=>x.frameJumpThresholds=[],x=>x.frameJumpThresholds.push({...x.frameJumpThresholds[0]}),x=>x.frameJumps[0].toFrame=0,x=>x.attachments.push({...x.attachments[0]}),x=>x.weights=Array(65537).fill({id:'x',sum:1}),x=>x.frameJumpThresholds[0].normalizationPx=0,x=>x.frameJumps[0].to=[Infinity,0],x=>x.extra=true];
 for(const change of changes){const input=fixture();change(input);assert.throws(()=>validateTelemetry(input),{code:'INVALID_TELEMETRY'});}
});
test('empty telemetry explicitly remains unverified and results do not alias input',()=>{
 const input=fixture();for(const key of ['attachments','weights','triangles','inversionExceptions','loopEndpoints','frameJumpThresholds','frameJumps'])input[key]=[];
 const result=validateTelemetry(input);assert.equal(result.status,'unverified');assert.equal(result.visualQuality,'unverified');assert.equal(result.coverage.totalSamples,0);
 const bad=fixture();bad.attachments[0].actual=[2,0];const report=validateTelemetry(bad);bad.attachments[0].id='changed';assert.equal(report.failures[0].id,'rest');
});
test('weight tolerance includes both numeric endpoints and sparse data never counts as inspected',()=>{
 const input=fixture();input.weights=[{id:'upper',sum:1+1e-5},{id:'lower',sum:1-1e-5}];assert.equal(validateTelemetry(input).status,'passed');
 input.weights=new Array(1);assert.throws(()=>validateTelemetry(input),{code:'INVALID_TELEMETRY'});
 const sparse=fixture();sparse.attachments[0].actual=new Array(2);assert.throws(()=>validateTelemetry(sparse),{code:'INVALID_TELEMETRY'});
});
