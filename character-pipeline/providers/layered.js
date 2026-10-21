'use strict';

async function layered(spec, context) {
  if (!spec.artwork.source) throw context.fail('ART_INPUT_MISSING', 'Layered provider requires artwork.source OpenRaster archive');
  const input = await context.source(spec.artwork.source);
  const result = await context.worker({
    action: 'layered',
    input,
    outputDirectory: await context.directory('layers')
  });
  if (!Array.isArray(result.layers)) throw context.fail('INVALID_WORKER_OUTPUT', 'Missing archive layers');
  const names = new Set();
  for (const layer of result.layers) {
    if (names.has(layer.name)) throw context.fail('AMBIGUOUS_LAYER', 'Repeated OpenRaster layer name');
    names.add(layer.name);
    await context.output(layer.input);
  }
  const parts = [];
  for (const part of context.selected) {
    const layer = result.layers.find(l => l.name === part.id);
    if (!layer) throw context.fail('LAYER_MISSING', `No OpenRaster layer named ${part.id}`);
    if (!Array.isArray(layer.offset) || layer.offset.length !== 2 || !layer.offset.every(Number.isFinite)) throw context.fail('INVALID_WORKER_OUTPUT', 'Invalid layer offset');
    parts.push({
      id: part.id,
      input: layer.input,
      layerOffset: layer.offset,
      pivot: part.pivot.map((v, i) => v - layer.offset[i]),
      pixelsPerUnit: part.image?.pixelsPerUnit || 1,
      ...(part.mask?.path ? {
        mask: await context.source(part.mask.path)
      } : {})
    });
  }
  return parts;
}
module.exports = {
  layered
};
