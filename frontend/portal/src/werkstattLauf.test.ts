import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LaufStand, WerkstattAnsicht, WerkstattLauf } from './werkstattBank';
import { dauerText, fallSeite, jetzt, liveSeitSek, meistDauer, neueresRelease, PRUEFUNGEN_WORT, schrittListe, seitText, software, WAS } from './werkstattLauf';

/** Die Ansicht, wie Go sie schreibt (TestAnsichtVektor), mit Belegen, vorher und Schritt-Zeit. */
const vektor: WerkstattAnsicht = JSON.parse(
  readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-ansicht-v1.example.json'), 'utf8'),
);
const lauf = vektor.lauf as LaufStand;
const T = Date.parse(vektor.zeit);

describe('Lauf-Seite aus der Ansicht des Dienstes', () => {
  it('neun Prüfungen aus dem Vektor der Prüfungen, nicht acht', () => {
    expect(PRUEFUNGEN_WORT).toBe('neun');
  });

  it('Schritte mit Belegzeile und Dauer; ohne Belege (älterer Dienst) bleibt die Zeile leer statt erfunden', () => {
    const ph = schrittListe(lauf, meistDauer([]), T);
    const alle = ph.flatMap((p) => p.schritte);
    expect(alle).toHaveLength(16);
    expect(alle.find((s) => s.schritt === 'fassungen')).toMatchObject({ zustand: 'ok', dauer: '0:04', beleg: expect.stringContaining('Manifest signiert') });
    expect(alle.find((s) => s.schritt === 'programm')).toMatchObject({ zustand: 'lauf', dauer: '0:42', beleg: null });
    expect(ph.find((p) => p.id === 'abnahme')?.rechts).toMatch(/^ca\. \d+ Min$/);
    const alt = schrittListe({ ...lauf, belege: undefined, schritt_seit: undefined }, meistDauer([]), T).flatMap((p) => p.schritte);
    expect(alt.find((s) => s.schritt === 'fassungen')).toMatchObject({ zustand: 'ok', dauer: null, beleg: null });
    expect(alt.find((s) => s.schritt === 'programm')).toMatchObject({ zustand: 'lauf', dauer: null });
  });

  it('Jetzt-Karte: Schritt, seit wann, meist, Frist, danach; nur solange der Lauf arbeitet', () => {
    const j = jetzt(lauf, meistDauer([]), T)!;
    expect(j).toMatchObject({ nummer: 8, von: 16, titel: 'Edge Light einspielen', seitSek: 42, fristSek: 600, danach: 'Tunnel-Schlüssel erzeugen' });
    expect(jetzt({ ...lauf, zustand: 'angehalten' }, {}, T)).toBeNull();
    expect(jetzt({ ...lauf, zustand: 'fertig' }, {}, T)).toBeNull();
  });

  it('„meist“ ist der Median der gemessenen Dauern der letzten Läufe, sonst die Schätzung', () => {
    const l = (d: number): WerkstattLauf => ({ kennung: 'k', freigabe: null, boxArt: null, zustand: 'fertig', schritt: null, titel: null,
      grund: null, beginn: vektor.zeit, ende: null, aktualisiertAm: vektor.zeit, stand: { ...lauf, belege: [{ schritt: 'programm', dauer_s: d, zeile: 'x' }] } });
    expect(meistDauer([l(100), l(300), l(120)]).programm).toBe(120);
    expect(meistDauer([]).programm).toBe(120);
    expect(meistDauer([]).neustart).toBe(180);
    expect(dauerText(3725)).toBe('1:02:05');
  });

  it('Software: vorher → danach, Prüfsumme kurz, Stand im Lauf', () => {
    const sw = software(vektor, lauf)!;
    expect(sw.freigabe).toBe('2026-11-mango-1');
    expect(sw.openwrt).toMatchObject({ fassung: '25.12.5', pruef: '✓ schon drauf', vorher: 'OpenWrt 25.12.5', sha: '0123…cdef' });
    expect(sw.edgeLight).toMatchObject({ fassung: '2026.11.1', pruef: 'wird eingespielt', vorher: 'kein VoltPilot' });
    const halb = software(vektor, { ...lauf, zustand: 'angehalten', erledigt: [], vorher: { system: 'OpenWrt mit Passwort dieser Werkstatt', edge_light: 'edge-pmzasg2, halb eingerichtet', ersetzt: true } })!;
    expect(halb.edgeLight).toMatchObject({ ersetzt: true, pruef: 'noch nicht drauf' });
    expect(halb.openwrt.pruef).toBe('noch nicht drauf');
    // ohne „vorher“ (älterer Dienst): nichts erfunden
    expect(software(vektor, { ...lauf, vorher: undefined })!.openwrt.vorher).toBeNull();
    expect(software({ ...vektor, freigabe: { laufend: false, boxen: 0 } }, lauf)).toBeNull();
  });

  it('ein neueres Release nur, wenn es signiert und für Edge Light ist', () => {
    // Die Box-Art ist das Wort der API (EdgeUpdatesDto.ReleaseDto.boxArt: docker | light).
    const r = (version: string, signed = true, boxArt = 'light') => ({ version, signed, boxArt, releaseSeq: 1 });
    expect(neueresRelease('edge-light-2026.11.1', [r('2026.11.3'), r('2026.12.0', false), r('2026.12.1', true, 'docker')])).toBe('2026.11.3');
    expect(neueresRelease('edge-light-2026.11.4', [r('edge-light-2026.11.5')])).toBe('2026.11.5');
    expect(neueresRelease('edge-light-2026.11.4', [r('edge-light-2026.11.5', true, 'edge-light')])).toBeNull();
    expect(neueresRelease('edge-light-2026.11.10', [r('2026.11.9')])).toBeNull();
    expect(neueresRelease('edge-light-2026.11.1', [])).toBeNull();
  });

  it('jeder Fall-Code hat einen Satz; Reset-Bild und Nochmal nur, wo der Dienst es zulässt', () => {
    for (const code of Object.keys(WAS)) {
      const s = fallSeite({ code, loesung: { titel: 't', schritte: ['s'], selbst: true, zur_seite: false }, wo: 'lauf', ansicht: vektor,
        lauf: { ...lauf, zustand: 'angehalten', fall: code } });
      expect(s.bild === 'reset').toBe(code === 'gl_passwort' || code === 'halb_eigene');
      // ohne nochmal_moeglich (älterer Dienst oder Fall mit Handgriff) nie „Nochmal“
      expect(s.knoepfe.some((k) => k.art === 'nochmal')).toBe(false);
    }
    const mit = fallSeite({ code: 'box_weg', loesung: null, wo: 'lauf', ansicht: vektor, lauf: { ...lauf, zustand: 'angehalten', nochmal_moeglich: true } });
    expect(mit.knoepfe.map((k) => k.art)).toEqual(['nochmal', 'zur-seite']);
    const angenommen = fallSeite({ code: 'box_weg', loesung: null, wo: 'lauf', ansicht: vektor,
      lauf: { ...lauf, zustand: 'angehalten', nochmal_moeglich: true, nochmal_seit: vektor.zeit } });
    expect(angenommen.knoepfe.map((k) => k.art)).toEqual(['zur-seite']);
  });
});

describe('Läuft-Anzeige: der wiederholte Check ist ein laufender Punkt, nie ein leerer offener (Firstmate vp-werkstatt-laeuft-anzeige)', () => {
  const loesungSelbst = { titel: 't', schritte: ['s'], selbst: true, zur_seite: false };

  it('Brücke unterspannung: „fragt alle 10 Sekunden“ läuft, trägt einen Alltagssatz und das Lebenszeichen der Werkbank', () => {
    const s = fallSeite({ code: 'bruecke_unterspannung', loesung: loesungSelbst, wo: 'anschluss', ansicht: vektor, lauf: null });
    expect(s.live).toHaveLength(2);
    expect(s.live[0]).toMatchObject({ zustand: 'ok', text: 'Brücke antwortet' });
    expect(s.live[1].zustand).toBe('lauf');
    expect(s.live[1].text).toBe('Der Dienst fragt alle 10 Sekunden wieder');
    expect(s.live[1].tut).toMatch(/Strom/);
    expect(s.live[1].seit).toBe(vektor.werkbank.status_zeit);
  });

  it('Brücke nicht bereit: der Check läuft weiter, auch wenn die Brücke selbst „warn“ zeigt', () => {
    const nichtBereit = { ...vektor, werkbank: { ...vektor.werkbank, bereit: false } };
    const s = fallSeite({ code: 'bruecke_nicht_bereit', loesung: loesungSelbst, wo: 'anschluss', ansicht: nichtBereit, lauf: null });
    expect(s.live[0]).toMatchObject({ zustand: 'warn', text: 'Brücke antwortet nicht' });
    expect(s.live[1].zustand).toBe('lauf');
    expect(s.live[1].tut).toMatch(/antwortet/);
  });

  it('Startlader: der Check auf frisches OpenWrt läuft, bis es sich meldet - dann startet der nächste Lauf von selbst', () => {
    const wartend = fallSeite({ code: 'ssh_zu', loesung: loesungSelbst, wo: 'anschluss', ansicht: vektor, lauf: null });
    expect(wartend.live[0]).toMatchObject({ zustand: 'lauf', text: 'Frisches OpenWrt meldet sich am orangen Kabel' });
    expect(wartend.live[0].seit).toBe(vektor.werkbank.status_zeit);
    expect(wartend.live[1]).toMatchObject({ zustand: 'offen', text: 'Lauf beginnt von selbst' });
    const gemeldet = fallSeite({ code: 'ssh_zu', loesung: loesungSelbst, wo: 'anschluss', ansicht: { ...vektor, anschluss_fall: 'startet' }, lauf: null });
    expect(gemeldet.live[0]).toMatchObject({ zustand: 'ok' });
    expect(gemeldet.live[1]).toMatchObject({ zustand: 'lauf', text: 'Lauf beginnt von selbst' });
  });

  it('Reset: wartet aufs Drücken, dann prüft es den Neustart, dann beginnt der neue Lauf - immer genau ein laufender Punkt', () => {
    const wartetAufDruck = fallSeite({ code: 'gl_passwort', loesung: loesungSelbst, wo: 'anschluss', ansicht: vektor, lauf: null });
    expect(wartetAufDruck.live.filter((p) => p.zustand === 'lauf')).toHaveLength(1);
    expect(wartetAufDruck.live[0]).toMatchObject({ zustand: 'lauf', text: 'Warten auf den Reset' });
    expect(wartetAufDruck.live[0].tut).toMatch(/Reset-Knopf/);
    const weg = fallSeite({ code: 'gl_passwort', loesung: loesungSelbst, wo: 'anschluss', ansicht: { ...vektor, anschluss_fall: 'kein_kabel' }, lauf: null });
    expect(weg.live.filter((p) => p.zustand === 'lauf')).toHaveLength(1);
    expect(weg.live[1]).toMatchObject({ zustand: 'lauf', text: 'Mango startet neu (bis 5 Minuten)' });
    const startet = fallSeite({ code: 'gl_passwort', loesung: loesungSelbst, wo: 'anschluss', ansicht: { ...vektor, anschluss_fall: 'startet' }, lauf: null });
    expect(startet.live.filter((p) => p.zustand === 'lauf')).toHaveLength(1);
    expect(startet.live[2]).toMatchObject({ zustand: 'lauf', text: 'Neuer Lauf beginnt von selbst' });
  });

  it('ohne „selbst“ gibt es keine Läuft-Anzeige (der Dienst fasst die Box nicht an)', () => {
    const s = fallSeite({ code: 'box_in_gebrauch', loesung: { titel: 't', schritte: ['s'], selbst: false, zur_seite: false }, wo: 'lauf', ansicht: vektor, lauf: null });
    expect(s.live).toEqual([]);
  });
});

describe('seitText/liveSeitSek: das Lebenszeichen eines wiederholten Checks', () => {
  it('zählt in Sekunden, ab einer Minute mm:ss', () => {
    expect(seitText(0)).toBe('vor 0 s');
    expect(seitText(4)).toBe('vor 4 s');
    expect(seitText(75)).toBe('vor 1:15');
  });

  it('liveSeitSek liest einen beliebigen ISO-Zeitpunkt, null ohne einen', () => {
    expect(liveSeitSek('2026-11-02T10:11:58Z', Date.parse('2026-11-02T10:11:58Z') + 4000)).toBe(4);
    expect(liveSeitSek(null, Date.now())).toBeNull();
    expect(liveSeitSek(undefined, Date.now())).toBeNull();
  });
});
