'use strict';
// Trusted-host orchestration only: no repair operators, generation or engine
// integration is supplied here. Persist must durably acknowledge each event.
const {hashValue}=require('./assets');
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_REPAIR'});
function data(input){
 let budget=10000;
 function visit(value,depth){
  if(--budget<0||depth>16)throw invalid('Repair data exceeds traversal bounds');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw invalid('Repair numbers must be finite');return value;}
  if(typeof value==='string'){if(value.length>4096)throw invalid('Repair string exceeds bounds');return value;}
  if(!value||typeof value!=='object')throw invalid('Repair requires plain data');
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw invalid('Repair requires plain data');
  const keys=Reflect.ownKeys(value),out=array?[]:{};
  if(keys.length>1001)throw invalid('Repair collection exceeds bounds');
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))throw invalid('Invalid repair data key');
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(!d.enumerable||!Object.hasOwn(d,'value')||(array&&!/^(0|[1-9][0-9]*)$/.test(key)))throw invalid('Repair requires enumerable data fields');
   out[key]=visit(d.value,depth+1);
  }
  if(array&&(out.length!==value.length||keys.length!==value.length+1))throw invalid('Repair requires dense arrays');
  return out;
 }
 const copy=visit(input,0);if(Buffer.byteLength(JSON.stringify(copy))>256*1024)throw invalid('Repair data exceeds byte bounds');return copy;
}
function fields(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw invalid('Missing or unsupported repair field');}
function id(value){if(typeof value!=='string'||value.length>64||!ID.test(value))throw invalid('Invalid repair ID');}
function names(value,max=256){if(!Array.isArray(value)||value.length>max)throw invalid('Invalid bounded repair list');value.forEach(id);if(new Set(value).size!==value.length)throw invalid('Duplicate repair IDs');}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const immutable=value=>freeze(data(value));
function candidate(input){const c=data(input);fields(c,['value','dependencies']);if(!Array.isArray(c.dependencies)||c.dependencies.length>256)throw invalid('Invalid dependency receipts');const seen=new Set();for(const d of c.dependencies){fields(d,['id','hash']);id(d.id);if(seen.has(d.id)||typeof d.hash!=='string'||!HASH.test(d.hash))throw invalid('Invalid dependency receipt');seen.add(d.id);}c.dependencies.sort((a,b)=>a.id.localeCompare(b.id));return c;}
function inspection(input){const r=data(input);fields(r,['passed','diagnoses']);if(typeof r.passed!=='boolean'||!Array.isArray(r.diagnoses)||r.diagnoses.length>100||r.passed!==!r.diagnoses.length)throw invalid('Inspection success must match complete diagnosis list');const seen=new Set();for(const d of r.diagnoses){fields(d,['id','code','asset','message','actionIds']);for(const key of ['id','code','asset'])id(d[key]);if(seen.has(d.id)||typeof d.message!=='string'||!d.message.length||d.message.length>1024)throw invalid('Invalid repair diagnosis');seen.add(d.id);names(d.actionIds);}return r;}
async function runRepairs(options,callbacks){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['candidate','maxAttempts','permittedActions','signal'].includes(k)))throw invalid('Invalid repair options');
 const maxAttempts=options.maxAttempts??3;
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>20)throw invalid('Invalid repair attempt bound');
 let current=candidate(options.candidate);const permitted=data(options.permittedActions);names(permitted);
 if(!callbacks||['inspect','select','apply','persist'].some(k=>typeof callbacks[k]!=='function'))throw invalid('Trusted repair callbacks required');
 const signal=options.signal;if(signal!==undefined&&(!(signal instanceof AbortSignal)))throw invalid('Invalid repair cancellation signal');
 const history=[],seenActions=new Set(),seenValues=new Set([hashValue(current.value)]);let attempts=0,persistFailed=false;
 const cancelled=()=>{if(signal?.aborted)throw Object.assign(new Error('Repair cancelled'),{code:'CANCELLED'});};
 async function record(type,details={}){
  const event=immutable({version:1,type,attempt:attempts,candidateHash:hashValue(current),valueHash:hashValue(current.value),dependencies:current.dependencies,...details});
  try{await callbacks.persist(event);}catch(error){persistFailed=true;throw error;}
  history.push(event);
 }
 async function complete(status){await record('complete',{status,integrationPending:true});cancelled();return {status,integrationPending:true,candidate:data(current),attempts,history:structuredClone(history)};}
 try{
  cancelled();
  while(true){
   const report=inspection(await callbacks.inspect(immutable(current),{signal}));cancelled();
   await record('inspection',{report});cancelled();
   if(report.passed)return await complete('passed');
   if(attempts>=maxAttempts)return await complete('exhausted');
   const raw=await callbacks.select(immutable({candidate:current,diagnoses:report.diagnoses,permittedActions:permitted}),{signal});cancelled();
   if(raw===null)return await complete('irreparable');
   const action=data(raw);fields(action,['diagnosisId','actionId','parameters']);id(action.diagnosisId);id(action.actionId);
   const diagnosis=report.diagnoses.find(d=>d.id===action.diagnosisId);
   if(!diagnosis||!permitted.includes(action.actionId)||!diagnosis.actionIds.includes(action.actionId))throw invalid('Correction was not permitted for this diagnosis');
   const actionHash=hashValue({diagnosis,action});
   if(seenActions.has(actionHash))return await complete('stalled');
   seenActions.add(actionHash);
   await record('action',{nextAttempt:attempts+1,diagnosis,action,actionHash});cancelled();
   attempts++;
   const receipt=data(await callbacks.apply(immutable({candidate:current,diagnosis,action}),{signal}));cancelled();
   fields(receipt,['candidate','invalidated']);const next=candidate(receipt.candidate);names(receipt.invalidated);
   const before=new Map(current.dependencies.map(d=>[d.id,d.hash])),after=new Map(next.dependencies.map(d=>[d.id,d.hash]));
   const changed=[...new Set([...before.keys(),...after.keys()])].filter(key=>before.get(key)!==after.get(key)).sort();
   const valueHash=hashValue(next.value);
   if(valueHash===hashValue(current.value)||hashValue(next)===hashValue(current)||!changed.length||JSON.stringify([...receipt.invalidated].sort())!==JSON.stringify(changed))throw invalid('Correction must change content and exactly invalidate changed dependencies');
   if(seenValues.has(valueHash)){await record('outcome',{status:'cycle',actionHash,rejectedCandidateHash:hashValue(next)});return await complete('stalled');}
   current=next;seenValues.add(valueHash);
   await record('outcome',{status:'applied',actionHash,invalidated:changed});cancelled();
  }
 }catch(error){
  // JavaScript callbacks may reject with any value. Diagnostic formatting must
  // neither replace that rejection nor prevent its durable failure evidence.
  let code='REPAIR_CALLBACK_FAILED',message='Unknown repair callback failure';
  try{if(typeof error?.code==='string')code=error.code.slice(0,64);message=String(error?.message??error).slice(0,1024);}catch{/* Keep safe defaults for hostile getters/string conversions. */}
  if(!persistFailed){
   try{await record(code==='CANCELLED'?'cancelled':'error',{code,message,integrationPending:true});}
   catch(persistError){
    // Neither failure may hide the other. The original rejection is retained
    // verbatim as cause/errors[0], even when null, primitive or frozen. No
    // durable evidence is claimed if persist itself rejects.
    throw new AggregateError([error,persistError],'Repair failed and failure evidence could not be persisted',{cause:error});
   }
  }
  throw error;
 }
}
module.exports={runRepairs};
