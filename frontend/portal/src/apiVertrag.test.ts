import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Jede Client-Route in `api.ts` nutzt eine HTTP-Methode, die der Vertrag (`docs/contracts/openapi.yaml`) für diesen Pfad
 * kennt. Anlass (Konzept Auswerten a1, Befund 1): „Energieeinsatz beenden“ schickte PUT, Server und Vertrag kennen nur
 * POST - die Route antwortete 405, der Nutzer las „Der Server ist zurzeit nicht erreichbar“.
 *
 * Geprüft werden Aufrufe `request<…>(\`/api/v1/…\`, { method })`, deren Pfad (Parameter als `{}`) im Vertrag steht; Pfade,
 * die der Vertrag nicht führt, prüft diese Datei nicht.
 */
const API = readFileSync(resolve(process.cwd(), 'src/api.ts'), 'utf8');
const VERTRAG = readFileSync(resolve(process.cwd(), '../../docs/contracts/openapi.yaml'), 'utf8');

const normiert = (pfad: string) => pfad.replace(/\{[^}]*\}/g, '{}');

function vertragsMethoden(): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  let inPfaden = false;
  let pfad: string | null = null;
  for (const zeile of VERTRAG.split('\n')) {
    if (/^paths:\s*$/.test(zeile)) {
      inPfaden = true;
      continue;
    }
    if (inPfaden && /^\S/.test(zeile)) inPfaden = false;
    if (!inPfaden) continue;
    const p = /^ {2}(\/api\/[^\s:]+):\s*$/.exec(zeile);
    if (p) {
      pfad = normiert(p[1]);
      if (!m.has(pfad)) m.set(pfad, new Set());
      continue;
    }
    const v = /^ {4}(get|post|put|patch|delete):/.exec(zeile);
    if (v && pfad) m.get(pfad)!.add(v[1].toUpperCase());
  }
  return m;
}

function clientAufrufe(): Array<{ pfad: string; methode: string; zeile: number }> {
  const aufrufe: Array<{ pfad: string; methode: string; zeile: number }> = [];
  const muster = /\brequest(?:<[^`()]*?>)?\(\s*`([^`]*)`/g;
  for (let m = muster.exec(API); m; m = muster.exec(API)) {
    // Das Ende des Aufrufs: Klammern ab der öffnenden zählen - die Methode steht im zweiten Argument.
    const start = API.indexOf('(', m.index);
    let tiefe = 0;
    let ende = start;
    for (; ende < API.length; ende++) {
      if (API[ende] === '(') tiefe++;
      else if (API[ende] === ')' && --tiefe === 0) break;
    }
    const methode = /method:\s*'(\w+)'/.exec(API.slice(start, ende))?.[1] ?? 'GET';
    const pfad = normiert(m[1].replace(/\$\{[^}]*\}/g, '{}').split('?')[0]);
    aufrufe.push({ pfad, methode, zeile: API.slice(0, m.index).split('\n').length });
  }
  return aufrufe;
}

describe('Client-Routen gegen den Vertrag (openapi.yaml)', () => {
  const vertrag = vertragsMethoden();
  const geprueft = clientAufrufe().filter((a) => vertrag.has(a.pfad));

  it('liest genug Aufrufe, um etwas zu beweisen', () => {
    expect(vertrag.size).toBeGreaterThan(300);
    expect(geprueft.length).toBeGreaterThan(300);
  });

  it('nutzt für jeden Vertragspfad eine Methode, die der Vertrag kennt', () => {
    const falsch = geprueft
      .filter((a) => !vertrag.get(a.pfad)!.has(a.methode))
      .map((a) => `api.ts:${a.zeile} ${a.methode} ${a.pfad} (Vertrag: ${[...vertrag.get(a.pfad)!].join(', ')})`);
    expect(falsch).toEqual([]);
  });

  it('beendet einen Energieeinsatz mit POST', () => {
    const beenden = geprueft.filter((a) => a.pfad === '/api/v1/unternehmen/energieeinsaetze/{}/beenden');
    expect(beenden.map((a) => a.methode)).toEqual(['POST']);
  });
});
