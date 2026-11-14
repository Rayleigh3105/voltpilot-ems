import { describe, expect, it } from 'vitest';
import type { SteuerlogikKarte, SteuerlogikStellwert, SteuerlogikVerlauf, SteuerlogikWarum } from './api';
import gepinnt from '../../../docs/contracts/v2/examples/steuerlogik-karte.valid.wasser.json';
import {
  erfuellt,
  fusszeile,
  geraetZeile,
  gruppen,
  herrschaft,
  insDokument,
  kopf,
  pille,
  schritt,
  stand,
  verlaufZeilen,
  warumSortiert,
  warumTitel,
  wertText,
  zahlAus,
  zusatzStoerung,
} from './steuerlogikKarte';

/** Die Karte, wie die API sie liefert (gepinnt von SteuerlogikScharfApiTest aus Block der Box und Antwort des Dienstes). */
const karte = () => structuredClone(gepinnt) as unknown as SteuerlogikKarte;
const wert = (k: SteuerlogikKarte, kennung: string) => k.stellwerte.find((s) => s.kennung === kennung)!;

describe('die Karte einer scharfen Logik', () => {
  it('sagt in einem Satz, was die Box meldet', () => {
    const k = karte();
    expect(kopf(k)).toEqual({ titel: 'Wartet auf Sonnenstrom', satz: 'Sobald Sonnenstrom übrig ist, heizt der Heizstab bis 57 °C.' });
    expect(pille(k)).toEqual({ klasse: 'wait', wort: 'wartet' });
    expect(fusszeile(k, new Date('2026-11-14T09:08:00Z'))).toBe('Heizstab · 3 Phasen');
  });

  it('zeigt eine Störung zuerst und doppelt den Titel nicht', () => {
    const k = karte();
    k.lage = { nr: 1, titel: 'Störung Fühler', art: 'fault', satz: 'Der Fühler liefert keinen Wert.' };
    k.stoerungen = [{ code: 'lage', text: 'Störung Fühler' }, { code: 'wert_fehlt', text: 'Ohne Wert: Speicher.' }];
    expect(pille(k)).toEqual({ klasse: 'lock', wort: 'Störung' });
    expect(zusatzStoerung(k)?.text).toBe('Ohne Wert: Speicher.');
  });

  it('erfindet ohne Meldung keine Lage, und eine stehende Logik sagt es', () => {
    const k = karte();
    k.lage = null;
    k.stoerungen = [{ code: 'haelt_an', text: 'Die Logik läuft auf der Box nicht.' }];
    expect(kopf(k)).toEqual({ titel: 'Läuft nicht', satz: 'Die Logik läuft auf der Box nicht.' });
    k.stoerungen = [];
    expect(kopf(k).titel).toBe('Noch keine Meldung');
  });

  it('nennt das Alter erst, wenn die Meldung alt ist', () => {
    const k = karte();
    expect(stand(k, new Date('2026-11-14T09:08:00Z'))).toBeNull();
    expect(stand(k, new Date('2026-11-14T09:20:00Z'))).toBe('Stand 10:07');
  });

  it('nennt den Schutz der Box als Grund und sagt unbekannt statt aus', () => {
    const k = karte();
    expect(geraetZeile(k.geraete[0])).toEqual({ name: 'Heizstab', jetzt: '3 Phasen', grund: 'Schutz: die Mindestlaufzeit hält es noch an.' });
    expect(geraetZeile({ ...k.geraete[0], ist: null, befehl: null, schutz: null }).jetzt).toBe('Schaltstand unbekannt');
    expect(geraetZeile({ ...k.geraete[0], halter: 'local-ui' }).grund).toBe('Gerade bestimmt von Hand.');
  });

  it('nennt bei einem Gerät, das selbst regelt, Sollwert und Betriebsart', () => {
    const g = karte().geraete[0];
    const klima = { ...g, ist: { ein: true, sollwert: 23.5, betriebsart: 'cool' }, befehl: null, schutz: null };
    expect(geraetZeile(klima).jetzt).toBe('an · 23,5\u00a0°C · kühlt');
    expect(geraetZeile({ ...klima, ist: { ein: false, sollwert: 24, betriebsart: 'cool' } }).jetzt).toBe('aus');
    expect(geraetZeile({ ...klima, ist: { betriebsart: 'boost' } }).jetzt).toBe('angehoben');
  });
});

describe('die Werte', () => {
  it('trennt, was der Kunde stellt, von dem, was der Fachbetrieb festlegt', () => {
    const { frei, fachbetrieb } = gruppen(karte().stellwerte);
    expect(frei.map((s) => s.kennung)).toEqual(['ziel', 'mindest', 'netz_ziel', 'netz_bis']);
    expect(fachbetrieb.map((s) => s.kennung)).toEqual(['netz_ab']);
    expect(wert(karte(), 'ziel').zielwert).toBe(true);
  });

  it('schreibt Werte deutsch und für die Box in der Form des Dokuments', () => {
    const ziel = wert(karte(), 'ziel');
    expect(wertText(ziel, '57 °C')).toBe('57 °C');
    expect(wertText(wert(karte(), 'netz_ab'), '06:00')).toBe('06:00 Uhr');
    expect(insDokument(ziel, 58)).toBe('58 °C');
    const halb: SteuerlogikStellwert = { ...ziel, schritt: 0.5, einheit: 'kW' };
    expect(insDokument(halb, 2.5)).toBe('2.5 kW');
    expect(wertText(halb, '2.5 kW')).toBe('2,5 kW');
    expect(wertText({ ...ziel, einheit: 'K', schritt: 1 }, '-3 K')).toBe('−3 K');
    expect(zahlAus('72.5 °C')).toBe(72.5);
  });

  it('bewegt einen Regler im Schritt und nie aus dem Bereich', () => {
    const ziel = wert(karte(), 'ziel');
    expect(schritt(ziel, 57, 1)).toBe(58);
    expect(schritt(ziel, 65, 1)).toBeNull();
    expect(schritt(ziel, 45, -1)).toBeNull();
    expect(schritt({ ...ziel, schritt: 0.5 }, 57.2, 1)).toBe(57.5);
  });
});

describe('die Liste „Warum?“', () => {
  it('stellt benannte Bedingungen vor reine Formeln und urteilt dreiwertig', () => {
    const w = warumSortiert(karte().warum);
    expect(w[0].bedingungen.every((b) => !b.formel)).toBe(true);
    expect(w[w.length - 1].bedingungen.some((b) => b.formel)).toBe(true);
    expect(erfuellt({ ...w[0], modus: 'alle', bedingungen: [{ name: 'a', ok: true }, { name: 'b', ok: null }] })).toBeNull();
    expect(erfuellt({ ...w[0], modus: 'eines', bedingungen: [{ name: 'a', ok: false }, { name: 'b', ok: true }] })).toBe(true);
    expect(erfuellt({ ...w[0], modus: 'alle', bedingungen: [{ name: 'a', ok: false }, { name: 'b', ok: null }] })).toBe(false);
  });
});

describe('die Überschriften im Blatt „Warum?“', () => {
  it('tragen den Satz der Box in Alltagssprache und nie eine Kennung', () => {
    const g: SteuerlogikWarum = {
      zustand: 'netzheizen', name: 'netzheizen', satz: 'Heizt aus dem Netz bis 50\u00a0°C', eigen: true, was: 'an',
      modus: 'alle', bedingungen: [{ name: 'Uhrzeit liegt im Fenster', ok: true }, { name: 'Zu kalt', ok: false }],
    };
    expect(warumTitel(g)).toBe('Heizt aus dem Netz bis 50\u00a0°C, wenn alles erfüllt ist');
    expect(warumTitel({ ...g, modus: 'eines' })).toBe('Heizt aus dem Netz bis 50\u00a0°C, sobald eines davon zutrifft');
    expect(warumTitel({ ...g, bedingungen: [g.bedingungen[0]] })).toBe('Heizt aus dem Netz bis 50\u00a0°C, wenn dies zutrifft');
    // Eine Box ohne das Feld: ein allgemeines Wort statt der Kennung von Zustand oder Schritt.
    const alt = { ...g, satz: undefined, eigen: undefined, was: 'schritt' as const, schritt: 'zurueck', zustand: 'stufe' };
    expect(warumTitel(alt)).toBe('Nächster Schritt, wenn alles erfüllt ist');
    expect(warumTitel({ ...alt, was: 'an' })).not.toMatch(/stufe|zurueck|netzheizen/);
  });

  it('zeigen am gepinnten Beispiel nur Sätze der Logik', () => {
    const w = karte().warum ?? [];
    expect(w.length).toBeGreaterThan(0);
    for (const g of w) {
      expect(g.eigen).toBe(true);
      expect(warumTitel(g)).not.toMatch(/netzheizen|zurueck|versuch|blind|[a-z]_[a-z]|^[a-z]/);
    }
  });
});

describe('der Verlauf', () => {
  it('nennt Schaltungen und wer welchen Wert gestellt hat, jüngstes zuerst', () => {
    const v: SteuerlogikVerlauf = {
      logikId: 'l', tag: '2026-11-14',
      wechsel: [
        { box: 'b', fassung: 1, laufSeit: 's', nr: 1, t: '2026-11-14T09:02:02Z', geraet: 'heizstab', was: 'ist', neu: { stufe: 3 }, andere: { stufe: 3 }, lage: 'Heizt aus dem Netz' },
        { box: 'b', fassung: 1, laufSeit: 's', nr: 2, t: '2026-11-14T09:02:01Z', geraet: 'heizstab', was: 'wunsch', neu: { stufe: 3 }, andere: { stufe: 0 }, lage: null },
      ],
      schritte: [{ fassung: 1, was: 'stellwert', am: '2026-11-14T08:55:00Z', von: 'Jonas', rolle: 'kundenadministrator',
        daten: { kennung: 'mindest', alt: '40 °C', neu: '42 °C' } }],
    };
    const z = verlaufZeilen(v, karte());
    expect(z.map((x) => x.satz)).toEqual([
      'Heizstab: 3 Phasen · Heizt aus dem Netz',
      'Jonas: Nie kälter als 40 °C → 42 °C',
    ]);
    expect(z[0].uhr).toBe('10:02');
  });

  it('weiß, welche Logik welches Gerät führt', () => {
    expect(herrschaft([karte()]).get('7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toBe('Warmwasser');
    expect(herrschaft(null).size).toBe(0);
  });
});
