'use strict';
// Pure bounded atlas data. Inspect property descriptors before reading values.
const invalid=()=>Object.assign(new Error('Invalid bounded effect animation descriptor.'),{code:'INVALID_EFFECT_ANIMATION'});
function data(value,keys,prototype){
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==prototype)throw invalid();
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw invalid();
 const result={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw invalid();result[key]=descriptor.value;}return result;
}
function integer(value,min,max){return Number.isSafeInteger(value)&&value>=min&&value<=max;}
function normalizeEffectAnimation(value,dimensions){
 const v=data(value,['columns','rows','frameCount','durations','loop'],Object.prototype);
 if(!integer(v.columns,1,64)||!integer(v.rows,1,64)||!integer(v.frameCount,2,64)||v.frameCount!==v.columns*v.rows||typeof v.loop!=='boolean')throw invalid();
 if(!Array.isArray(v.durations))throw invalid();
 const a=data(v.durations,[...Array.from({length:v.frameCount},(_,i)=>String(i)),'length'],Array.prototype);
 if(a.length!==v.frameCount)throw invalid();
 const durations=Array.from({length:v.frameCount},(_,i)=>a[i]);let total=0;
 for(const duration of durations){if(typeof duration!=='number'||!Number.isFinite(duration)||duration<1/240||duration>10)throw invalid();total+=duration;}
 if(total>10)throw invalid();
 if(dimensions!==undefined){const d=data(dimensions,['width','height'],Object.prototype);if(!integer(d.width,1,4096)||!integer(d.height,1,4096)||d.width%v.columns!==0||d.height%v.rows!==0||(d.width/v.columns)*(d.height/v.rows)*v.frameCount>16777216)throw invalid();}
 return Object.freeze({columns:v.columns,rows:v.rows,frameCount:v.frameCount,durations:Object.freeze(durations),loop:v.loop});
}
module.exports={normalizeEffectAnimation};
