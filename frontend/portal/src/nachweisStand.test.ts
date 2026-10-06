import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnergiemanagementTeilVermerk } from './api';
import { VOKABULARE, WOERTER } from './energiemanagement';
import { dokumentRoute, energiemanagementRoute, pageRoute } from './nav';
import { nachweisStand, TEIL_GRUPPEN, teilDerZeile, type NachweisEingang } from './nachweisStand';
import { energiemanagementBuehne } from './test/energiemanagementFixtures';
import { wvLeer, wvR12 } from './test/wiedervorlageFixtures';

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

  it('ohne Wiedervorlage keine Frist - nichts wird geraten', async () => {
    const s = nachweisStand(await eingang(null as never));
    expect(s.ueberfaellig).toEqual([]);
    expect(s.demnaechst).toEqual([]);
    expect(s.teile.every((t) => t.zustand !== 'ueber')).toBe(true);
    // Ohne Überfälliges ist der erste offene Teil der nächste Schritt.
    expect(s.naechstes).toMatchObject({ art: 'festhalten', titel: 'Kontext festhalten', knopf: 'Festhalten' });
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
