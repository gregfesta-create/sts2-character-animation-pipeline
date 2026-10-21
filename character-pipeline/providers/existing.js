'use strict';

// Supplied artwork is copied into immutable job storage before a worker reads it.
async function existing(spec, context) {
  const result = [];
  for (const part of context.selected) {
    if (!part.image?.path) throw context.fail('ART_INPUT_MISSING', `Part ${part.id} requires an image`);
    const input = await context.source(part.image.path);
    const mask = !part.image.prepared && part.mask?.path ? await context.source(part.mask.path) : undefined;
    result.push({
      id: part.id,
      input,
      pivot: part.image.prepared ? part.image.pivot : part.pivot,
      pixelsPerUnit: part.image.pixelsPerUnit || 1,
      ...(mask ? {
        mask
      } : {})
    });
  }
  return result;
}
module.exports = {
  existing
};
