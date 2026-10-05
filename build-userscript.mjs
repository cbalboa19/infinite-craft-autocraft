// Builds autocraft.user.js (Tampermonkey / Violentmonkey / Greasy Fork) from autocraft.js.
// Usage: node build-userscript.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('./autocraft.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const match = src.match(/const VERSION = 'v(\d+(?:\.\d+)*)'/);
if (!match) throw new Error('VERSION not found in autocraft.js');
const version = match[1].includes('.') ? match[1] : match[1] + '.0';

const header = `// ==UserScript==
// @name         Infinite Craft Auto-Craft
// @namespace    https://github.com/cbalboa19
// @version      ${version}
// @description  Auto-crafts in Infinite Craft with a model that learns which pairs give new elements. Search mode, rate-limit-aware pacing, live stats panel.
// @author       cbalboa19
// @license      MIT
// @homepageURL  https://github.com/cbalboa19/infinite-craft-autocraft
// @supportURL   https://github.com/cbalboa19/infinite-craft-autocraft/issues
// @match        https://neal.fun/infinite-craft/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

// Generated from autocraft.js by build-userscript.mjs. Edit autocraft.js, not this file.
// The panel opens paused: press Resume to start crafting.

(function waitForGame(tries) {
  const ic = window.IC;
  if (ic && ic.craft && ic.getItems && ic.getItems().length) {
    window.autoCraftStartPaused = true;
    runAutoCraft();
  } else if (tries < 120) {
    setTimeout(() => waitForGame(tries + 1), 500);
  } else {
    console.warn('[autocraft] Infinite Craft did not finish loading; Auto-Craft was not started.');
  }
})(0);

function runAutoCraft() {
`;

const body = src.split('\n').map((line) => (line ? '  ' + line : line)).join('\n').trimEnd();
writeFileSync(new URL('./autocraft.user.js', import.meta.url), header + body + '\n}\n');
console.log(`autocraft.user.js built (version ${version})`);
