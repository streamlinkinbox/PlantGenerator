// Headless bark audit: build a tree, skin it, grow the bark, measure everything.
import { generateSkeleton, DEFAULTS } from '../src/core/skeleton.js';
import { skinSkeleton, SKIN_DEFAULTS } from '../src/core/skin.js';
import { buildBark, BARK_DEFAULTS, auditBark, barkToOBJ } from '../src/core/bark.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : parseFloat(argv[i + 1]);
};
const seeds = argv.includes('--sweep') ? [1,2,3,4,5,6,7,8,9,10] : [arg('seed', 7)];

for (const seed of seeds) {
  const t0 = performance.now();
  const skel = generateSkeleton({ ...DEFAULTS, seed });
  const skin = skinSkeleton(skel, SKIN_DEFAULTS);
  const fine = skin.mesh.subdivide(Number(arg('subdiv', 1)));
  const bark = buildBark(skel, fine, { ...BARK_DEFAULTS });
  const a = auditBark(bark);
  const s = bark.stats;
  console.log(
    `seed ${String(seed).padStart(3)} | tubes ${String(skin.tubes.length).padStart(3)}` +
    ` | plates ${String(s.plates).padStart(5)} shed ${String(s.shed).padStart(4)} peel ${String(s.peeled).padStart(4)}` +
    ` | quads ${String(s.quads).padStart(7)} (${a.perPlateQuads.toFixed(1)}/plate)` +
    ` | T ${s.tJunctions} X ${s.xJunctions}` +
    ` | median ${(s.medianHeight||0).toFixed(3)}x${(s.medianWidth||0).toFixed(3)} (${(s.aspect||0).toFixed(2)}:1)` +
    ` | closed ${a.closed}/${a.plates} quads ${a.quadsOnly}/${a.plates} 1shell ${a.single}/${a.plates} chi2 ${a.euler2}/${a.plates}` +
    ` | overlaps ${s.overlaps} miss ${s.missed}(nohit ${s.missNoHit}/step ${s.missStep}) rej ${s.rejected} dropped ${s.dropped} maxAspect ${a.worstAspect.toFixed(1)} pinched ${a.pinched}` +
    ` | cover ${(100*s.plateArea/Math.max(s.cellArea,1e-9)).toFixed(0)}% | ${s.ms.toFixed(0)}ms (total ${(performance.now()-t0).toFixed(0)}ms)`
  );
  if (argv.includes('--obj') && seeds.length === 1) {
    writeFileSync('shots/bark.obj', barkToOBJ(bark));
    console.log('wrote shots/bark.obj');
  }
}
