'use strict';
// Preview projection only. Skeleton coordinates and exported character geometry
// remain canonical pixels; one uniform viewport transform fits the review image.
const MAX_SIDE=512,MAX_SHEET_BYTES=32*1024*1024;
const encodedBound=(width,height)=>{const raw=width*height*4+height;return raw+Math.ceil(raw/16384)*5+65536;};
function planRenderViewport(canvas,frameCount){
 const fail=()=>{throw Object.assign(new Error('Invalid bounded preview canvas or frame count'),{code:'INVALID_RENDER_LAYOUT'});};
 if(!canvas||![canvas.width,canvas.height].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=16384)||!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>64)fail();
 const {width,height}=canvas,columns=Math.ceil(Math.sqrt(frameCount)),rows=Math.ceil(frameCount/columns),cells=columns*rows;
 // Reserve scanline/filter/deflate/PNG framing overhead, even for noisy images.
 const framePixels=Math.floor((MAX_SHEET_BYTES-131072)/(4*cells));
 let scale=Math.min(1,MAX_SIDE/width,MAX_SIDE/height,Math.sqrt(framePixels/(width*height)));
 const dimensions=s=>[Math.max(1,Math.ceil(width*s)),Math.max(1,Math.ceil(height*s))];
 let pixels=dimensions(scale);
 if(pixels[0]>MAX_SIDE||pixels[1]>MAX_SIDE||pixels[0]*pixels[1]>framePixels){
  let low=0,high=scale;
  for(let i=0;i<64;i++){const middle=(low+high)/2,[w,h]=dimensions(middle);if(w<=MAX_SIDE&&h<=MAX_SIDE&&w*h<=framePixels)low=middle;else high=middle;}
  scale=low;pixels=dimensions(scale);
 }
 const sheetWidth=pixels[0]*columns,sheetHeight=pixels[1]*rows;
 return Object.freeze({version:1,canonicalCanvas:Object.freeze([width,height]),pixels:Object.freeze(pixels),scale,canonicalPixelsPerRenderPixel:1/scale,frameCount,contactGrid:Object.freeze([columns,rows]),maximumFrameEncodedBytes:encodedBound(...pixels),maximumSheetEncodedBytes:encodedBound(sheetWidth,sheetHeight)});
}
module.exports={planRenderViewport};
