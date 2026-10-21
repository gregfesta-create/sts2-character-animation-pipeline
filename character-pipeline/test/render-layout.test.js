'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planRenderViewport}=require('../lib/render-layout');
test('preview layout preserves canonical coordinates and fits rectangular artwork uniformly',()=>{
 const square=planRenderViewport({width:512,height:512},24);assert.deepEqual(square.pixels,[512,512]);assert.equal(square.scale,1);
 const wide=planRenderViewport({width:1024,height:256},24);assert.deepEqual(wide.pixels,[512,128]);assert.equal(wide.scale,.5);assert.deepEqual(wide.canonicalCanvas,[1024,256]);assert.equal(wide.canonicalPixelsPerRenderPixel,2);
 const small=planRenderViewport({width:64,height:32},2);assert.equal(small.scale,1);assert.deepEqual(small.pixels,[64,32]);
});
test('large and many-clip previews fit decoded pixels and worst-case sheet encoding budgets',()=>{
 for(const canvas of [{width:16384,height:8192},{width:512,height:512},{width:1,height:16384}])for(const count of [2,10,24,64]){
  const r=planRenderViewport(canvas,count),[w,h]=r.pixels;assert.ok(r.scale>0&&r.scale<=1&&w<=512&&h<=512);assert.ok(w>=canvas.width*r.scale&&h>=canvas.height*r.scale);assert.ok(r.maximumSheetEncodedBytes<=32*1024*1024);assert.ok(r.maximumFrameEncodedBytes<=16*1024*1024);assert.ok(w*h*count<=16*1024*1024);
 }
});
test('invalid canvas and unbounded sampling requests reject before rendering',()=>{
 for(const canvas of [null,{}, {width:0,height:1},{width:16385,height:1},{width:1.5,height:1},{width:Infinity,height:1}])assert.throws(()=>planRenderViewport(canvas,2),{code:'INVALID_RENDER_LAYOUT'});
 for(const count of [0,65,NaN,1.5])assert.throws(()=>planRenderViewport({width:512,height:512},count));
});
