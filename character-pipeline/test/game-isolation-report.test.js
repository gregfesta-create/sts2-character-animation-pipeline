'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateReport}=require('./godot/game_pack_isolation_native');
const token='CharacterPipelineIsolation_'+'a'.repeat(32);
function report(userData='C:/isolated/'+token){const before={userData,projectName:token,mainScene:'',autoloads:[],children:['IsolationFixture']};return {token,mounted:true,before,after:structuredClone(before),gameStartupExecuted:false};}
test('isolation evidence requires an absolute canonical user data path',()=>{
 for(const path of [token,'../'+token,'C:/other/../'+token,'res://'+token])assert.throws(()=>validateReport(report(path),token));
 assert.doesNotThrow(()=>validateReport(report(),token));
});
test('isolation evidence refuses shared userdata, changed settings and a nonempty game tree',()=>{
 for(const mutate of [r=>r.before.userData='C:/game',r=>r.after.projectName='game',r=>r.after.autoloads=['autoload/Game'],r=>r.before.children=['NGame'],r=>r.gameStartupExecuted=true,r=>r.mounted=false]){const r=report();mutate(r);assert.throws(()=>validateReport(r,token));}
});
