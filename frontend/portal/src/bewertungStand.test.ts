import { describe, expect, it } from 'vitest';
import type { BerichtRechte } from './berichtDialoge';
import { freigabeAntrag, freigabeVorschau, geltungen, vorlageKarten, zeitraumVorgabe, zeitraumWahlen } from './berichtDialoge';
import { gueltigerStand } from './berichtSeite';
import { statusZeile } from './bewertungErgebnis';
import { bewertungWaehlen, darfBewertung, kriterienAnstoss, revisionVermerk } from './bewertungStand';
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
  it('F1 ohne Werte-Liste: kein Punkt „Alle 0 Werte endgültig“, die Freigabe ist nach dem Ende der Datengrundlage erlaubt', async () => {
    const { r, b, detail } = await lage('entwurf');
    const e = await r.berichtEntwurf(BW_KENNUNG);
    const v = freigabeVorschau(freigabeAntrag(b!, e, detail!.staende, Date.parse('2026-11-09T10:12:00+01:00')), null, 'de-DE');
    expect(v.punkte.map((p) => p.schluessel)).toEqual(['zeitraum', 'entwurf']);
    expect(v.erlaubt).toBe(true);
    expect(v.nr).toBe(1);
  });

  it('ohne Stand gilt nichts: kein gültiger Stand, keine Frist', async () => {
    const { detail, berichte } = await lage('entwurf');
    expect(gueltigerStand(detail!.staende)).toBeNull();
    expect(statusZeile(berichte)).toMatchObject({ satz: 'Noch kein Stand freigegeben', faellig: false });
  });
});

describe('Stände, Anstoß und Frist (R7, R10)', () => {
  it('der erste Stand ohne Vorgänger', async () => {
    const { detail } = await lage('nr1');
    expect(gueltigerStand(detail!.staende)).toMatchObject({ nr: 1, ersetzt_durch_nr: null });
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
    expect(d.staende.map((x) => [x.nr, x.ersetzt_durch_nr, x.anlass_anstoss_id !== null])).toEqual([[1, 2, false], [2, null, true]]);
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
