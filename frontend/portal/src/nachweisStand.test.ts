import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnergiemanagementTeilVermerk, Selbstauskunft } from './api';
import { VOKABULARE, WOERTER } from './energiemanagement';
import { dokumentRoute, energiemanagementRoute, pageRoute } from './nav';
import { nachweisStand, TEIL_GRUPPEN, teilDerZeile, teilZiel, type NachweisEingang } from './nachweisStand';
import { energiemanagementBuehne } from './test/energiemanagementFixtures';
import { rechteSeed } from './test/rollenFixtures';
import { wvLeer, wvR12, wvZeile } from './test/wiedervorlageFixtures';

/**
 * Der Stand je Teil für den Überblick (Konzept Nachweisen n1, Runde 2, §6.3, Entscheide 3 bis 5): auf der Bühne des
 * Referenzunternehmens am 12.02.2029 (R12) - dieselben Routen, die der Überblick liest.
 */
const JETZT = '2029-02-12T09:00:00+01:00';

async function eingang(wiedervorlage = wvR12(), vermerke: EnergiemanagementTeilVermerk[] = []): Promise<NachweisEingang> {
  const b = energiemanagementBuehne('ahrenberg', { kennung: 'IK', name: 'Ines Kaltenbach' }, () => new Date().toISOString());
  await b.bereit;
  return {
    verzeichnis: await b.routen.energiemanagementVerzeichnis(),
    dokumente: (await b.routen.energiemanagementDokumente()).dokumente,
    wiedervorlage,
    vermerke,
  };
}

const vermerk = (teil: string, aufgehoben = false): EnergiemanagementTeilVermerk => ({
  id: `v-${teil}`,
  teil,
  teil_wort: WOERTER.teil[teil],
  satz: 'Wir planen und bauen zurzeit keine Anlagen um.',
  entschieden_von: { id: 'rf', name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', mit_konto: false },
  entschieden_am: '2029-02-12',
  eingetragen: { akteur: { sub: 'ik', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' }, am: JETZT },
  aufgehoben: aufgehoben ? { akteur: { sub: 'ik', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' }, am: JETZT } : null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(JETZT));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Teile und Gruppen', () => {
  it('die vier Gruppen tragen genau die 18 Teile des Vertrags, in seiner Reihenfolge, mit Name und Kurzwort', () => {
    expect(TEIL_GRUPPEN.flatMap((g) => g.teile)).toEqual(VOKABULARE.teil);
    expect(TEIL_GRUPPEN.map((g) => g.teile.length)).toEqual([5, 6, 3, 4]);
    for (const t of VOKABULARE.teil) {
      expect(WOERTER.teil[t], t).toBeTruthy();
      expect(WOERTER.teil_kurz[t], t).toBeTruthy();
    }
    expect(WOERTER.teil_kurz.kontext).toBe('Kontext');
    expect(WOERTER.teil.kontext).toBe('Kontext und interessierte Parteien');
  });

  it('eine Zeile des Verzeichnisses gehört zu ihrem Teil - über die Art, sonst über die Gruppe', () => {
    expect(teilDerZeile({ gruppe: 'grundlagen', art: 'energiepolitik' })).toBe('energiepolitik');
    expect(teilDerZeile({ gruppe: 'verantwortung', art: 'bestellung' })).toBe('aufgaben');
    expect(teilDerZeile({ gruppe: 'kompetenz_kommunikation', art: 'bekanntmachung' })).toBe('kommunikation');
    expect(teilDerZeile({ gruppe: 'audits_feststellungen', art: 'wirksamkeit' })).toBe('feststellungen');
    // Der Stand eines Berichts gehört zum Teil seiner Gruppe: Bewertung, Leistungsvergleich, Monatsbericht.
    expect(teilDerZeile({ gruppe: 'bewertung_messplanung', art: 'berichtsstand' })).toBe('energetische_bewertung');
    expect(teilDerZeile({ gruppe: 'kennzahlen_bezugsbasen', art: 'berichtsstand' })).toBe('bezugsbasen');
    expect(teilDerZeile({ gruppe: 'berichte', art: 'berichtsstand' })).toBe('berichte');
    // Das „Vorgehen“ nennt keinen Teil; ein Vermerk kommt aus seiner eigenen Route.
    expect(teilDerZeile({ gruppe: 'grundlagen', art: 'verfahren' })).toBeNull();
    expect(teilDerZeile({ gruppe: 'risiken_chancen', art: 'teil_vermerk' })).toBeNull();
  });
});

describe('Stand je Teil am 12.02.2029 (R12)', () => {
  it('zählt nur Offenes und Überfälliges - nie eine Zahl über das Ganze (Entscheid 3, G4)', async () => {
    const s = nachweisStand(await eingang());
    expect(s.stand).toBe('12.02.2029');
    const zustand = Object.fromEntries(s.teile.map((t) => [t.teil, t.zustand]));
    expect(zustand).toMatchObject({
      energiepolitik: 'ueber',
      anwendungsbereich: 'ueber',
      rechtliche_anforderungen: 'festgehalten',
      kontext: 'offen',
      risiken_chancen: 'offen',
      aufgaben: 'festgehalten',
      energetische_bewertung: 'ueber',
      bezugsbasen: 'ueber',
      berichte: 'ueber',
    });
    // Acht abgelaufene Fristen, jede an ihrem Teil; die Bezugsbasen tragen ihre vier.
    expect(s.ueberfaellig).toHaveLength(8);
    expect(s.teile.find((t) => t.teil === 'bezugsbasen')?.ueberfaellig).toHaveLength(4);
    expect(s.teile.find((t) => t.teil === 'bezugsbasen')?.fakt).toBe('4 überfällig');
    expect(s.teile.find((t) => t.teil === 'energiepolitik')?.fakt).toBe('seit 10.12.2028');
    expect(s.offen).toBe(s.teile.filter((t) => t.zustand === 'offen').length);
    expect(s.offen).toBeGreaterThan(0);
  });

  it('„Als Nächstes“ ist das am längsten Überfällige aus Nachweisen selbst - nicht die Bezugsbasen der Nachbarn', async () => {
    const s = nachweisStand(await eingang());
    expect(s.naechstes?.art).toBe('frist');
    expect(s.naechstes?.titel).toBe('Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 entscheiden');
    expect(s.naechstes?.knopf).toBe('Entscheiden');
    expect(s.naechstes?.art === 'frist' && s.naechstes.eintrag.frist.satz).toBe('fällig seit 03.04.2028');
  });

  it('Demnächst: nur Fristen aus Nachweisen, die noch nicht abgelaufen sind', async () => {
    const s = nachweisStand(await eingang());
    expect(s.demnaechst.length).toBeGreaterThan(0);
    expect(s.demnaechst.every((x) => x.bereich === 'nachweisen' && x.tage <= 0)).toBe(true);
  });

  it('ohne Wiedervorlage keine Frist - nichts wird geraten, auch kein nächster Schritt (Review r1, P1-2)', async () => {
    const s = nachweisStand(await eingang(null as never));
    expect(s.ueberfaellig).toEqual([]);
    expect(s.demnaechst).toEqual([]);
    expect(s.teile.every((t) => t.zustand !== 'ueber')).toBe(true);
    // Unbekannt ist, ob etwas überfällig ist - „Kontext festhalten“ wäre geraten.
    expect(s.naechstes).toBeNull();
    // Mit einer Wiedervorlage ohne Überfälliges ist der erste offene Teil der nächste Schritt.
    expect(nachweisStand(await eingang(wvLeer())).naechstes).toMatchObject({ art: 'festhalten', titel: 'Kontext festhalten', knopf: 'Festhalten' });
  });

  it('Zähler und „Als Nächstes“ lesen dieselbe Menge: die Überprüfung eines Vorgehens (ohne Teil) zählt mit (Review r1, P1-3)', async () => {
    const e = await eingang();
    const vorgehen = { ...e.dokumente[0], id: 'd-vorgehen', kennzeichen: 'D-0099', art: 'verfahren', titel: 'Vorgehen Energiedaten' };
    const wv = wvR12();
    wv.faellig = [wvZeile('dokument_ueberpruefung', 'D-0099', 'Vorgehen Energiedaten - Überprüfung', '2027-10-01', 499, { id: 'd-vorgehen', aufgabe: 'dokumente' }), ...wv.faellig];
    const s = nachweisStand({ ...e, dokumente: [...e.dokumente, vorgehen], wiedervorlage: wv });
    expect(s.naechstes?.art === 'frist' && s.naechstes.eintrag.kennzeichen).toBe('D-0099');
    expect(s.ueberfaellig.map((x) => x.kennzeichen)).toContain('D-0099');
    expect(s.ueberfaellig).toHaveLength(9);
    // Keinem Teil zugeordnet: der Teil-Zustand bleibt, wie er war.
    expect(s.teile.every((t) => t.ueberfaellig.every((x) => x.kennzeichen !== 'D-0099'))).toBe(true);
  });

  it('ein Vermerk „Trifft bei uns zurzeit nicht zu“ hält den Teil fest - ein aufgehobener nicht mehr (Entscheid 5)', async () => {
    const mit = nachweisStand(await eingang(wvLeer(), [vermerk('kontext')]));
    const kontext = mit.teile.find((t) => t.teil === 'kontext')!;
    expect(kontext.zustand).toBe('festgehalten');
    expect(kontext.fakt).toBe('trifft zurzeit nicht zu');
    expect(kontext.vermerk?.id).toBe('v-kontext');
    const ohne = nachweisStand(await eingang(wvLeer(), [vermerk('kontext', true)]));
    expect(ohne.teile.find((t) => t.teil === 'kontext')?.zustand).toBe('offen');
    expect(ohne.offen).toBe(mit.offen + 1);
  });

  it('ein aufgehobenes Dokument hält seinen Teil über die Zeilen des Verzeichnisses nicht mehr fest (Review r1, P1-8)', async () => {
    const e = await eingang(wvLeer());
    const d3 = e.dokumente.find((d) => d.art === 'rechtliche_anforderungen')!;
    expect(nachweisStand(e).teile.find((t) => t.teil === 'rechtliche_anforderungen')?.zustand).toBe('festgehalten');
    const aufgehoben = e.dokumente.map((d) => (d.id === d3.id ? { ...d, zustand: 'aufgehoben' as const } : d));
    expect(nachweisStand({ ...e, dokumente: aufgehoben }).teile.find((t) => t.teil === 'rechtliche_anforderungen')?.zustand).toBe('offen');
  });

  it('jeder Teil führt an seinen Ort: das eine Dokument, die Dokumente oder die Fläche, auf der er entsteht', async () => {
    const s = nachweisStand(await eingang());
    const ort = Object.fromEntries(s.teile.map((t) => [t.teil, t.ort]));
    expect(ort.kontext).toEqual(energiemanagementRoute('dokumente'));
    expect(ort.bezugsbasen).toEqual(pageRoute('portfolio-kennzahlen'));
    expect(ort.interne_audits).toEqual(energiemanagementRoute('audits'));
    const d3 = s.teile.find((t) => t.teil === 'rechtliche_anforderungen')!;
    expect(d3.ort.page).toBe(dokumentRoute('x').page);
    expect(d3.ort.dokumentId).toBeTruthy();
    // Festhalten legt bei den Teilen eines Dokuments ein Dokument dieser Art an; die übrigen entstehen an ihrem Ort.
    expect(s.teile.find((t) => t.teil === 'kontext')?.dokumentArt).toBe('kontext');
    expect(s.teile.find((t) => t.teil === 'interne_audits')?.dokumentArt).toBeNull();
  });
});

describe('Wohin ein Teil führt (Review r1, P1-4 und P1-5)', () => {
  const ohne = (me: Selbstauskunft, ...rechte: string[]): Selbstauskunft => ({
    ...me,
    unternehmen_rechte: me.unternehmen_rechte.filter((r) => !rechte.includes(r)),
    standorte: me.standorte.map((st) => ({ ...st, rechte: st.rechte.filter((r) => !rechte.includes(r)) })),
  });

  it('ein Ort außerhalb des Energiemanagements nur mit dem Recht, ihn zu sehen; unbekannte Rechte sind nein', async () => {
    const e = await eingang(wvLeer());
    const ik = rechteSeed('IK').me;
    const sichtbar = (rechte: Selbstauskunft | null) =>
      Object.fromEntries(nachweisStand({ ...e, rechte }).teile.map((t) => [t.teil, t.ortSichtbar]));
    expect(sichtbar(ik)).toMatchObject({ energetische_bewertung: true, bezugsbasen: true, massnahmen: true, aufgaben: true, kontext: true });
    expect(sichtbar(ohne(ik, 'energieeinsatz.ansehen', 'messwerte.ansehen', 'verbesserung.ansehen'))).toMatchObject({
      energetische_bewertung: false,
      bezugsbasen: false,
      massnahmen: false,
      aufgaben: true,
      interne_audits: true,
      berichte: true,
      kontext: true,
    });
    expect(sichtbar(null)).toMatchObject({ energetische_bewertung: false, massnahmen: false, kontext: true });
  });

  it('ein offener Teil führt nur mit Recht ins Festhalten; ohne Recht an seinen Ort - oder nirgends hin', async () => {
    const e = await eingang(wvLeer(), [vermerk('risiken_chancen')]);
    const s = nachweisStand({ ...e, rechte: ohne(rechteSeed('CB').me, 'verbesserung.ansehen') });
    const teil = (k: string) => s.teile.find((t) => t.teil === k)!;
    expect(teilZiel(teil('kontext'), true)).toBe('festhalten');
    expect(teilZiel(teil('kontext'), false)).toBe('ort');
    // Den Vermerk lesen alle; aufheben steht im Blatt nur mit Recht.
    expect(teilZiel(teil('risiken_chancen'), false)).toBe('vermerk');
    expect(teilZiel(teil('massnahmen'), false)).toBeNull();
    const ueber = nachweisStand(await eingang());
    expect(teilZiel(ueber.teile.find((t) => t.teil === 'bezugsbasen')!, false)).toBe('frist');
  });
});
