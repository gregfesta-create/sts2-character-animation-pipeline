'use strict';
const HASH=/^[a-f0-9]{64}$/;
function validateSurfaceCoverage(receipt,bindings={}) {
 const invalid=()=>{throw Object.assign(new Error('Required surface coverage receipt is missing or does not match captured artwork.'),{code:'INVALID_SURFACE_COVERAGE'});};
 if(!receipt||receipt.version!==1||receipt.status!=='verified'||receipt.alphaThreshold!==1||receipt.missingPixels!==0||!Number.isSafeInteger(receipt.width)||receipt.width<1||!Number.isSafeInteger(receipt.height)||receipt.height<1||receipt.width*receipt.height>16000000||!Number.isSafeInteger(receipt.requiredPixels)||receipt.requiredPixels<1||receipt.requiredPixels>receipt.width*receipt.height)invalid();
 for(const key of ['sourceSha256','maskSha256','outputSha256'])if(!HASH.test(receipt[key])||(bindings[key]!==undefined&&receipt[key]!==bindings[key]))invalid();
 for(const key of ['width','height'])if(!Number.isSafeInteger(bindings[key])||bindings[key]<1||receipt[key]!==bindings[key])invalid();
 return receipt;
}
module.exports={validateSurfaceCoverage};
