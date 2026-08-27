import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('/home/user/PlantGenerator/index.html','utf8');
const dom = new JSDOM(html, { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.devicePixelRatio = 1; global.innerWidth = 1200; global.innerHeight = 800;
global.requestAnimationFrame = () => 0;
let src = readFileSync('/home/user/PlantGenerator/src/app/main.js','utf8');
src = src.replace("from 'three'", "from '/tmp/stub-three.mjs'").replace("from 'three/addons/controls/OrbitControls.js'", "from '/tmp/stub-orbit.mjs'");
src = src.replace(/from '\.\.\/core\//g, "from '/home/user/PlantGenerator/src/core/");
writeFileSync('/tmp/main-test.mjs', src);
await import('/tmp/main-test.mjs');
console.log('module executed; __PG_READY =', global.window.__PG_READY);
// exercise stage 6
const btn = [...document.querySelectorAll('#stages button')].find(b=>b.dataset.stage==='5');
btn.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
console.log('stage 6 clicked, stats panel:\n', document.getElementById('stats').textContent.slice(0, 900));
