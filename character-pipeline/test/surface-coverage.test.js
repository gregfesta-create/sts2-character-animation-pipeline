const test=require('node:test');
const assert=require('node:assert/strict');
const {validateSurfaceCoverage}=require('../lib/surface-coverage');
const h='a'.repeat(64),m='b'.repeat(64),o='c'.repeat(64);
const receipt={version:1,status:'verified',sourceSha256:h,maskSha256:m,outputSha256:o,width:8,height:9,requiredPixels:5,missingPixels:0,alphaThreshold:1};
test('required surface receipts bind input, mask and final image',()=>{
 assert.throws(()=>validateSurfaceCoverage(receipt,{width:7}),{code:'INVALID_SURFACE_COVERAGE'});
 assert.throws(()=>validateSurfaceCoverage(receipt,{height:7}),{code:'INVALID_SURFACE_COVERAGE'});
 assert.equal(validateSurfaceCoverage(receipt,{sourceSha256:h,maskSha256:m,outputSha256:o,width:8,height:9}),receipt);
 for(const change of [{},{missingPixels:1},{requiredPixels:0},{alphaThreshold:0},{width:0},{height:Infinity},{sourceSha256:m},{maskSha256:h},{outputSha256:h}]){
 const candidate=Object.keys(change).length?{...receipt,...change}:undefined;
 assert.throws(()=>validateSurfaceCoverage(candidate,{sourceSha256:h,maskSha256:m,outputSha256:o,width:8,height:9}),{code:'INVALID_SURFACE_COVERAGE'});
 }
});

test('declared coverage requires independently supplied source dimensions',()=>{
 for(const dimensions of [{},{width:8},{height:9},{width:undefined,height:9},{width:8,height:undefined},{width:0,height:9},{width:8,height:Infinity}]){
 assert.throws(()=>validateSurfaceCoverage(receipt,{sourceSha256:h,maskSha256:m,outputSha256:o,...dimensions}),{code:'INVALID_SURFACE_COVERAGE'});
 }
});
