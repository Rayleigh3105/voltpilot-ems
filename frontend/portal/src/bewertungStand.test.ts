import { describe, expect, it } from 'vitest';
import type { BerichtRechte } from './berichtDialoge';
import { freigabeAntrag, freigabeVorschau, geltungen, vorlageKarten, zeitraumVorgabe, zeitraumWahlen } from './berichtDialoge';
import {
  bewertungWaehlen,
  darfBewertung,
  entwurfZeile,
  fristKopf,
  kriterienAnstoss,
  pruefsummeKurz,
  revisionVermerk,
  standSatz,
  standZeilen,
} from './bewertungStand';
import { bewertungStandBuehne, BW_KENNUNG, type BewertungsLage } from './test/bewertungStandBuehne';
import { rechteSeed } from './test/rollenFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/** UEMS AP-16 IP-25 (§5.5, R7, R10, R15): der Bewertungsstand auf der Seite „Bewertung“ — rein, gegen die Bühnen-Daten. */

const ZONE = 'Europe/Berlin';
const lage = async (l: BewertungsLage) => {
  const r = bewertungStandBuehne(l);
  const berichte = (await r.berichte()).berichte;
  const b = bewertungWaehlen(berichte);
  return { r, berichte, b, detail: b ? await r.bericht(b.kennung) : null };
};

const rechte = (unternehmen: string[]): BerichtRechte => ({ standorte: new Map(), unternehmen });

describe('Rechte aus /me: alles an der Bewertung hängt an `bewertung.abrufen` (AP-16 §6.1)', () => {
  it('Ines (Energiemanagerin, unternehmensweit) darf, ohne Selbstauskunft niemand', () => {
    expect(darfBewertung(rechteSeed('IK').me)).toBe(true);
    expect(darfBewertung({ unternehmen_rechte: ['bericht.unternehmen'] })).toBe(false);
    expect(darfBewertung(null)).toBe(false);
  });

  it('die Vorlage steht im Anlegen-Dialog nur mit `bewertung.abrufen`, mit Datengrundlage statt Monat', () => {
    expect(vorlageKarten(rechte(['bericht.unternehmen']), []).map((k) => k.schluessel)).not.toContain('energetische_bewertung');
    const karte = vorlageKarten(rechte(['bewertung.abrufen']), []).find((k) => k.schluessel === 'energetische_bewertung');
    expect(karte).toMatchObject({ geltungArt: 'unternehmen', zeitraumArt: 'datengrundlage' });
    expect(vorlageKarten(rechte(['bewertung.abrufen']), []).map((k) => k.schluessel)).toEqual(['energetische_bewertung']);
    const u = { id: FIXTURE_IDS.u, name: 'Kunststoffwerk Ahrenberg GmbH', zeitzone: ZONE };
    expect(geltungen('unternehmen', [], u, rechte(['bewertung.abrufen']), 'energetische_bewertung').map((g) => g.id)).toEqual([FIXTURE_IDS.u]);
    expect(geltungen('unternehmen', [], u, rechte(['bewertung.abrufen']))).toEqual([]);
  });

  it('Zeitraum: Vorgabe sind die letzten zwölf vollen Monate (§5.5 Schritt 1), keiner „läuft“', () => {
    const jetzt = Date.parse('2026-11-20T09:00:00+01:00');
    expect(zeitraumVorgabe('datengrundlage', jetzt, ZONE)).toBe('2025-11/2026-10');
    const wahl = zeitraumWahlen('datengrundlage', jetzt, ZONE);
    expect(wahl[0]).toEqual({ id: '2025-11/2026-10', label: 'November 2025 bis Oktober 2026' });
    expect(wahl[1].id).toBe('2025-10/2026-09');
    expect(wahl.every((w) => !w.label.includes('läuft'))).toBe(true);
  });
});

describe('Entwurf und Freigabe (§5.5 Schritte 1–2)', () => {
  it('der Entwurf nennt seinen Datenstand und die Datengrundlage', async () => {
    const { r, b } = await lage('entwurf');
    const e = await r.berichtEntwurf(BW_KENNUNG);
    expect(entwurfZeile(b!, e)).toBe('Entwurf · Datenstand 09.11.2026 10:05 · Datengrundlage November 2025 bis Oktober 2026');
  });

  it('F1 ohne Werte-Liste: kein Punkt „Alle 0 Werte endgültig“, die Freigabe ist nach dem Ende der Datengrundlage erlaubt', async () => {
    const { r, b, detail } = await lage('entwurf');
    const e = await r.berichtEntwurf(BW_KENNUNG);
    const v = freigabeVorschau(freigabeAntrag(b!, e, detail!.staende, Date.parse('2026-11-09T10:12:00+01:00')), null, 'de-DE');
    expect(v.punkte.map((p) => p.schluessel)).toEqual(['zeitraum', 'entwurf']);
    expect(v.erlaubt).toBe(true);
    expect(v.nr).toBe(1);
  });

  it('ohne Stand gibt es keinen Stand-Satz und keine Frist', async () => {
    const { b, detail } = await lage('entwurf');
    expect(standSatz(detail!)).toBeNull();
    expect(fristKopf(b)).toBeNull();
    expect(standZeilen(detail!, true)).toEqual([]);
  });
});

describe('Stände, Anstoß und Frist (R7, R10)', () => {
  it('R7: „Bewertung 2026 · Stand Nr. 2 vom 17.11.2026 (ersetzt Nr. 1 vom 09.11.2026 — Anlass: Korrektur K-2026-0007).“', async () => {
    const { detail } = await lage('nr2');
    expect(standSatz(detail!)).toBe('Bewertung 2026 · Stand Nr. 2 vom 17.11.2026 (ersetzt Nr. 1 vom 09.11.2026 — Anlass: Korrektur K-2026-0007).');
    const [n2, n1] = standZeilen(detail!, true);
    expect(n2).toMatchObject({
      titel: 'Stand Nr. 2', gueltig: true, zustand: 'gültig', anlass: 'Anlass: Korrektur K-2026-0007',
      freigabe: 'freigegeben am 17.11.2026 09:30 · Ines Kaltenbach', pruefsumme: 'Prüfsumme 8c41…7f10',
    });
    expect(n1).toMatchObject({ titel: 'Stand Nr. 1', gueltig: false, zustand: 'ersetzt durch Nr. 2', anlass: null, pruefsumme: 'Prüfsumme 3b1f…9a2e' });
    expect(n1.dateien.map((d) => d.datei)).toEqual([`bericht-${BW_KENNUNG}-nr1.pdf`, `bericht-${BW_KENNUNG}-nr1.csv`]);
    expect(standZeilen(detail!, false)[0].dateien).toEqual([]);
  });

  it('der erste Stand ohne Vorgänger', async () => {
    const { detail } = await lage('nr1');
    expect(standSatz(detail!)).toBe('Bewertung 2026 · Stand Nr. 1 vom 09.11.2026.');
    expect(revisionVermerk(detail!)).toBeNull();
  });

  it('Anstoß: „Revision nötig — Korrektur K-2026-0007“, Nr. 1 bleibt unverändert', async () => {
    const { detail } = await lage('revision');
    const v = revisionVermerk(detail!)!;
    expect(v.titel).toBe('Revision nötig — Korrektur K-2026-0007');
    expect(v.satz).toBe('Der Berichtsstand Nr. 1 bleibt unverändert.');
    expect(v.nr).toBe(1);
  });

  it('Freigabe nach dem Anstoß: Nr. 2 ersetzt Nr. 1 und nennt den Anlass (§5.5 Schritt 3)', async () => {
    const { r } = await lage('revision');
    await r.berichtFreigeben(BW_KENNUNG, '2026-11-12T10:06:00+01:00');
    const d = await r.bericht(BW_KENNUNG);
    expect(revisionVermerk(d)).toBeNull();
    expect(standSatz(d)).toBe('Bewertung 2026 · Stand Nr. 2 vom 17.11.2026 (ersetzt Nr. 1 vom 09.11.2026 — Anlass: Korrektur K-2026-0007).');
  });

  it('R10: Frist-Kopfzeile „fällig am“ und „fällig seit 1 Tag“ — mit den Verantwortlichen', async () => {
    expect(fristKopf((await lage('nr2')).b)).toEqual({
      satz: 'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig am 17.11.2027.', faellig: false, hinweis: null,
    });
    const f = fristKopf((await lage('faellig')).b)!;
    expect(f.satz).toBe('Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.');
    expect(f.faellig).toBe(true);
    expect(f.hinweis).toContain('Paul Hartmann (EE-2, EE-5)');
  });

  it('Prüfsumme gekürzt wie im Messmittel-Satz', () => {
    expect(pruefsummeKurz('3b1f7c0e5d2a9a2e')).toBe('3b1f…9a2e');
    expect(pruefsummeKurz('kurz')).toBe('kurz');
  });
});

describe('R15: nach einer Kriterien-Änderung der Anstoß-Satz — nur mit einem Stand', () => {
  it('mit Stand Nr. 2 nennt er ihn, ohne Stand fehlt er', async () => {
    expect(kriterienAnstoss((await lage('nr2')).berichte)).toBe(
      'Bewertungsstand Nr. 2 bekommt einen Anstoß — dort steht bald „Revision nötig — Kriterien-Fassung geändert“.',
    );
    expect(kriterienAnstoss((await lage('entwurf')).berichte)).toBeNull();
    expect(kriterienAnstoss((await lage('keine')).berichte)).toBeNull();
    expect(kriterienAnstoss(null)).toBeNull();
  });
});
