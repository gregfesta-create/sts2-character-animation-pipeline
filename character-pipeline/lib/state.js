'use strict';

// Sequence orders transport messages; revision orders authoritative state versions.
// Both are nondecreasing; neither is a locally computed gameplay value.
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function invalid(path, message) {
  const error = new Error('Invalid authoritative presentation state');
  error.code = 'INVALID_STATE';
  error.diagnostics = [{path, code:'STATE', message}];
  throw error;
}
function object(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid(path,'Expected plain object');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key=>!keys.includes(key))) invalid(path,'Missing or unknown field');
  for (const key of own) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!Object.hasOwn(descriptor,'value')||!descriptor.enumerable) invalid(path,'Expected enumerable data fields');
  }
}
function id(value,path) { if(typeof value !== 'string' || !ID.test(value)) invalid(path,'Expected bounded stable ID'); }
function integer(value,path,min=0,max=Number.MAX_SAFE_INTEGER) { if(!Number.isSafeInteger(value)||value<min||value>max) invalid(path,'Integer outside permitted bounds'); }
function lifecycle(value) { if(!['alive','dead','removed'].includes(value)) invalid('/lifecycle','Unsupported lifecycle'); }
function array(value,path,min,max) {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max) invalid(path,'Expected ordinary array within permitted bounds');
  if(Reflect.ownKeys(value).length!==value.length+1) invalid(path,'Array must contain only dense indices');
  for(let index=0;index<value.length;index++) {
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable) invalid(path,'Expected dense enumerable data indices');
  }
}
function createStateReconciler(config) {
  object(config,['instanceId','sockets'],''); id(config.instanceId,'/instanceId');
  array(config.sockets,'/sockets',0,256);
  const sockets=new Map();
  for(const socket of config.sockets) {
    object(socket,['id','capacity','types'],'/sockets');id(socket.id,'/sockets/id');integer(socket.capacity,'/sockets/capacity',1,64);
    array(socket.types,'/sockets/types',1,64);
    if(sockets.has(socket.id)||new Set(socket.types).size!==socket.types.length) invalid('/sockets','Duplicate socket or invalid types');
    socket.types.forEach(type=>id(type,'/sockets/types'));
    sockets.set(socket.id,structuredClone(socket));
  }
  const instanceId=config.instanceId;
  let state={version:1,instanceId,sequence:null,revision:null,lifecycle:'alive',visualMode:'idle',components:[]};
  let requiredSequence=0, requiredRevision=0, needsSnapshot=true, disposed=false;
  const read=()=>structuredClone(state);
  const result=status=>({status,requestSnapshot:needsSnapshot&&!disposed&&state.lifecycle!=='removed',state:read()});
  function component(value) {
    object(value,['id','socket','type','revision','damageState','upgrade','visualMode'],'/components');
    for(const key of ['id','socket','type','damageState','visualMode'])id(value[key],'/components/'+key);
    integer(value.revision,'/components/revision',1);integer(value.upgrade,'/components/upgrade',0,1000000);
    const socket=sockets.get(value.socket);
    if(!socket||!socket.types.includes(value.type))invalid('/components/socket','Unknown or incompatible socket');
  }
  function occupancy(components) {
    array(components,'/components',0,4096);
    const ids=new Set(),counts=new Map();
    for(const value of components) {
      component(value);
      const count=(counts.get(value.socket)||0)+1;
      if(ids.has(value.id)||count>sockets.get(value.socket).capacity)invalid('/components','Duplicate component or exceeded capacity');
      ids.add(value.id);counts.set(value.socket,count);
    }
  }
  function envelope(message,keys) {
    object(message,keys,'');
    if(message.version!==1||message.instanceId!==instanceId)invalid('','Version or instance mismatch');
    integer(message.sequence,'/sequence');integer(message.revision,'/revision',1);
  }
  function retainedRevision(value,previous) {
    if(value.revision<previous.revision)invalid('/components/revision','Component revision rollback');
    if(value.revision===previous.revision&&Object.keys(previous).some(key=>value[key]!==previous[key]))invalid('/components/revision','Conflicting data for component revision');
  }
  // Equal global revisions may advance transport sequence only for a no-op.
  // Occupancy order is not state: stable component IDs define identity.
  function globalRevision(next) {
    if(next.revision!==state.revision)return;
    const changed=next.lifecycle!==state.lifecycle||next.visualMode!==state.visualMode||next.components.length!==state.components.length||next.components.some(value=>{
      const previous=state.components.find(item=>item.id===value.id);
      return !previous||Object.keys(previous).some(key=>previous[key]!==value[key]);
    });
    if(changed)invalid('/revision','Conflicting state for authoritative revision');
  }
  return {
    getState:read,
    snapshot(message) {
      envelope(message,['version','instanceId','sequence','revision','lifecycle','visualMode','components']);
      lifecycle(message.lifecycle);id(message.visualMode,'/visualMode');occupancy(message.components);
      if(message.lifecycle==='removed'&&message.components.length)invalid('/components','Removed instances must be empty');
      if(disposed)return result('disposed');
      if(state.lifecycle==='removed')return result('removed');
      if(state.sequence!==null&&(message.sequence<state.sequence||message.revision<state.revision))return result('ignored');
      if(message.sequence<requiredSequence||message.revision<requiredRevision)return result('blocked');
      if(!needsSnapshot&&message.sequence===state.sequence)return result('ignored');
      for(const value of message.components) {
        const previous=state.components.find(item=>item.id===value.id);
        if(previous)retainedRevision(value,previous);
      }
      globalRevision(message);
      state=structuredClone(message);needsSnapshot=false;return result('applied');
    },
    event(message) {
      envelope(message,['version','instanceId','sequence','revision','type','payload']);
      const {type,payload}=message;
      if(type==='upsert')component(payload);
      else if(type==='remove'){object(payload,['id'],'/payload');id(payload.id,'/payload/id');}
      else if(type==='lifecycle'){object(payload,['lifecycle'],'/payload');lifecycle(payload.lifecycle);}
      else if(type==='visualMode'){object(payload,['visualMode'],'/payload');id(payload.visualMode,'/payload/visualMode');}
      else invalid('/type','Unsupported authoritative event');
      if(disposed)return result('disposed');
      if(state.lifecycle==='removed')return result('removed');
      if(state.sequence!==null&&(message.sequence<=state.sequence||message.revision<state.revision))return result('ignored');
      if(needsSnapshot||message.sequence!==state.sequence+1) {
        needsSnapshot=true;requiredSequence=Math.max(requiredSequence,message.sequence);requiredRevision=Math.max(requiredRevision,message.revision);
        return result('blocked');
      }
      const next=read();
      if(type==='upsert') {
        const index=next.components.findIndex(value=>value.id===payload.id);
        if(index>=0) {
          retainedRevision(payload,next.components[index]);
          next.components[index]=structuredClone(payload);
        } else next.components.push(structuredClone(payload));
        occupancy(next.components);
      } else if(type==='remove') {
        const index=next.components.findIndex(value=>value.id===payload.id);
        if(index<0)invalid('/payload/id','Unknown installed component');
        next.components.splice(index,1);
      } else if(type==='lifecycle') {
        next.lifecycle=payload.lifecycle;
        if(payload.lifecycle==='removed')next.components=[];
      } else next.visualMode=payload.visualMode;
      next.sequence=message.sequence;next.revision=message.revision;
      globalRevision(next);
      state=next;return result('applied');
    },
    teardown() { disposed=true;state={...state,lifecycle:'removed',components:[]};return result('disposed'); }
  };
}
module.exports={createStateReconciler};
