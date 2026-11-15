// Selbstzeit der Funktionen eines CPU-Profils (`cpu-profil.mjs`), deren Quelltext je Aufruf einen Intl-Formatierer baut
// (`toLocale*`, `Intl.*`) - die Kandidaten, die man einmal bauen kann (Abschnitt „Portal-Reaktivität, Welle 3“ in
// ../perf-baseline.md). Braucht den unminifizierten Profiling-Build, aus dem das Profil stammt. Usage:
//   node intl-heiss.mjs <profil.cpuprofile> <dist-profil>
// Grobe Probe über den Funktionsrumpf: ein Treffer heißt nur, dass der Rumpf Intl nennt, nicht, dass jeder Aufruf
// formatiert - vor einem Umbau die Stelle lesen.
import { readFileSync } from 'node:fs';

const [profilDatei, dist] = process.argv.slice(2);
const p = JSON.parse(readFileSync(profilDatei, 'utf8'));
const knoten = new Map(p.nodes.map((n) => [n.id, n]));
const us = new Map();
for (let i = 0; i < p.samples.length; i++) us.set(p.samples[i], (us.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const je = new Map();
for (const [id, t] of us) {
  const f = knoten.get(id).callFrame;
  const k = `${f.functionName}|${f.url.split('/').pop()}|${f.lineNumber}`;
  je.set(k, (je.get(k) ?? 0) + t);
}
const quellen = new Map();
const zeilen = [];
for (const [k, t] of je) {
  const [fn, datei, zeile] = k.split('|');
  if (!datei.endsWith('.js')) continue;
  if (!quellen.has(datei)) {
    try { quellen.set(datei, readFileSync(`${dist}/assets/${datei}`, 'utf8').split('\n')); } catch { quellen.set(datei, null); }
  }
  const src = quellen.get(datei);
  if (!src) continue;
  let rumpf = '';
  for (let i = +zeile; i < Math.min(src.length, +zeile + 12); i++) {
    rumpf += `${src[i]}\n`;
    if (i > +zeile && /^}/.test(src[i])) break;
  }
  if (/toLocale|Intl\./.test(rumpf)) zeilen.push([t / 1000, `${fn || '(anonym)'} ${datei}:${+zeile + 1}`]);
}
zeilen.sort((x, y) => y[0] - x[0]);
for (const [ms, n] of zeilen.slice(0, 30)) console.log(`${ms.toFixed(1).padStart(8)} ms  ${n}`);
console.log(`Summe ${zeilen.reduce((s, z) => s + z[0], 0).toFixed(1)} ms`);
