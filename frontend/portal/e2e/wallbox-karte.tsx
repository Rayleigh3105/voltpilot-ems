/**
 * MiSpeL MP-41b - die Wallbox-Karte in Steuerung › Laden (BK-41 Variante A).
 *
 * Dieselbe Beispielanlage wie `e2e/steuerung.*` (Dienstag 29.09.2026, 13:10 Uhr);
 * nur die Ladepunkte kommen dazu. Die „Wallbox Werkstatt“ (Auto angesteckt)
 * ist bidirektional (V2H und V2G, 11 kW), der „Ladepunkt Carport“ bleibt „nur
 * laden“. `?fall=` wählt, was am Ladepunkt steckt:
 * - `mit-ladestand`: Auto meldet 62 % → „Abfahrt und Reserve“;
 * - `ohne-ladestand`: kein Ladestand → das heutige Ladeziel bleibt;
 * - `ohne-rueckspeisen`: die Wallbox meldet ein Auto ohne Rückspeise-Funktion;
 * - `nur-laden`: beide Ladepunkte „nur laden“ (Bestand);
 * - `ohne-ladepunkt`: die Anlage hat keinen Ladepunkt;
 * - `unbekannt`: die Ladepunkte-Antwort fehlt (Bestand, so lädt die geteilte Bühne).
 * MiSpeL MP-41c (BK-41c A/A/A), Auto mit 62 % wie `mit-ladestand`:
 * - `leistung-alt`: Leistung 8 Min. alt, Ladestand 10 s - der Ladestand zählt nach seiner Uhr;
 * - `ladestand-3min` / `ladestand-alt`: Ladestand 3 bzw. 12 Min. alt (gemessen 12:58);
 * - `sofort`: die dauerhafte Steuerart „sofort“ an der Wallbox; `schnell`: der Eingriff „Schnell“.
 * `&plan=` legt den Fahrzeug-Eintrag des Laufs an die Wallbox, so wie der Optimierer ihn neben dem
 * Block `fahrzeug` ablegt (`reason_code` `fahrzeug_rueckspeisen`, je −kW, 13:00 bis morgen 13:00):
 * `zurueck` = 18:00–21:30 ans Haus (14 Viertelstunden, 8,825 kWh), `kein` = gerechnet, ohne
 * Zurückspeisen (alles 0); die Wallbox trägt dann NUR diesen Eintrag, `ohne` nimmt sie ganz aus dem
 * Lauf (Vergleich). `gemischt`: geplantes Laden bleibt Lade-Zeile (die der Steuerungs-Bühne, 13:00–16:00
 * und morgen ab 12:15), der Fahrzeug-Eintrag steht in den Rückspeise- und leeren Viertelstunden - eine
 * Zeile je Viertelstunde und Komponente, wie die Ablage sie schreibt.
 * Ohne `plan` bleibt der Lauf der Steuerungs-Bühne (Betreiber-Schalter leer, heute überall).
 * Nur von `e2e/wallbox-karte.html` geladen; nie im Produktionsbündel.
 */
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api } from '../src/api';
import type { FahrerAnfrage, FahrerEinstellungen, LadepunktAnsicht, LadepunktErtraege } from '../src/ladepunktErtraege';
import { installSteuerungFixtures, JETZT } from './steuerung-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installSteuerungFixtures();
const fall = new URLSearchParams(location.search).get('fall') ?? 'mit-ladestand';
const planFall = new URLSearchParams(location.search).get('plan');
const SITE = 'help-site';
const MIT_LADESTAND = ['mit-ladestand', 'leistung-alt', 'ladestand-3min', 'ladestand-alt', 'sofort', 'schnell'];
const vor = (ms: number) => new Date(Date.parse(JETZT) - ms).toISOString();
// Die Rückspeise-Viertelstunden 18:00–21:30 Ortszeit (16:00Z …), je kW - dasselbe Beispiel wie BK-41c.
const ZURUECK_KW = [2.4, 2.8, 3.2, 3.2, 3.0, 2.9, 2.7, 2.6, 2.5, 2.4, 2.2, 2.0, 1.8, 1.6];
const ZURUECK_AB = Date.parse('2026-09-29T16:00:00Z');

const faehigkeit = (bidi: boolean) => ({
  erfasst: bidi, nutzbarkeit: bidi ? 'bidirektional' as const : 'unidirektional' as const, v2h: bidi, v2g: bidi,
  rueckspeisung_bei_einspeisung_unterbunden: false, rueckspeiseleistung_kw: bidi ? 11 : null, gueltig_ab: bidi ? '2026-09-01' : null, gueltig_bis: null,
});

let fahrer: FahrerEinstellungen = {
  erfasst: true, rueckspeisen: 'v2h', rueckspeisen_wirksam: 'v2h', reserve_pct: 40, vollzyklen_je_tag: 1,
  abfahrten: [{ wochentage: [1, 2, 3, 4, 5], abfahrt: '07:15', abfahrt_soc_pct: 80 }], naechste_fahrt: null,
  km_je_prozent: 3.84, geaendert_am: JETZT, geaendert_von: 'Kunde',
};

const ansicht = (komponente: string, name: string, cp: string, bidi: boolean): LadepunktAnsicht => ({
  anlage: SITE, komponente, name, typ: 'ev-charger', charge_point_id: cp, am: '2026-09-29',
  faehigkeit: faehigkeit(bidi), einordnung: bidi ? 'ladepunkt_der_festlegung' : 'sonstiger_verbrauch',
  einordnung_fundstelle: 'Anlage 1 S. 26', z2: [], befunde: [], fassungen: [],
  fahrzeugfenster: bidi ? { mindest_soc_pct: fahrer.reserve_pct, kapazitaet_kwh: 64, anwesenheit: [] } : null,
  fahrer_einstellungen: bidi ? fahrer : null,
});

const bidiWb = fall !== 'nur-laden';
const liste = () => ({
  anlage: SITE, am: '2026-09-29',
  ladepunkte: fall === 'ohne-ladepunkt' ? [] : [ansicht('e-wb', 'Wallbox Werkstatt', 'CP-WERKSTATT', bidiWb), ansicht('e-lp', 'Ladepunkt Carport', 'CP-CARPORT', false)],
});

const vorChargers = api.siteChargers;
const vorVerbraucher = api.siteVerbraucher;
const vorPlan = api.consumerSchedule;
Object.assign(api, {
  ladepunkte: async () => {
    if (fall === 'unbekannt') throw new Error('nicht erreichbar');
    return liste();
  },
  ladepunktFahrerSetzen: async (_s: string, komponente: string, a: FahrerAnfrage) => {
    const wirksam = a.rueckspeisen;
    fahrer = { ...fahrer, ...a, erfasst: true, rueckspeisen_wirksam: wirksam, geaendert_am: JETZT };
    return liste().ladepunkte.find((x) => x.komponente === komponente)!;
  },
  ladepunktErtraege: async (_s: string, monat: string): Promise<LadepunktErtraege> => ({
    anlage: SITE, monat,
    ladepunkte: [{ komponente: 'e-wb', name: 'Wallbox Werkstatt', einordnung: 'ladepunkt_der_festlegung' }],
    teile: [{
      schluessel: `${monat}-A2`, erster_tag: `${monat}-01`, letzter_tag: `${monat}-30`, formelsatz: 'A2',
      formelsatz_bezeichnung: 'Formelsatz A2', nur_ladepunkt: true, stand: 'vorlaeufig', wertequelle: 'geraet',
      mengen: [{ nr: '5', begriff: 'Verbrauch im Ladepunkt', fundstelle: 'A1', kwh: 132 }, { nr: '11', begriff: 'Basiswert der zeitgleichen Netzeinspeisung', fundstelle: 'A1', kwh: 34 }],
      ins_haus: { nr: '6-11', begriff: 'ins Haus', fundstelle: 'A1', kwh: 108 },
    }],
    posten: [],
    vergleich: { stand: 'bestimmt', grund: null, summe_eur: 15.42 },
  }),
  siteChargers: async (s: string) => {
    const c = await vorChargers(s);
    if (fall === 'ohne-ladepunkt') return { ...c, chargers: [] };
    for (const cp of c.chargers ?? []) {
      if (cp.chargePointId !== 'CP-WERKSTATT') continue;
      for (const con of cp.connectors ?? []) {
        if (fall === 'mit-ladestand' || fall === 'nur-laden' || fall === 'unbekannt') con.socPct = 62;
        if (fall === 'ohne-rueckspeisen') { con.socPct = 55; con.bidirectional = false; }
        // MiSpeL MP-41c: der Ladestand mit seiner eigenen Uhr (seit MP-37b am Stecker), die Leistung mit ihrer.
        if (MIT_LADESTAND.includes(fall) && fall !== 'mit-ladestand') { con.socPct = 62; con.socMeasuredAt = vor(10_000); }
        if (fall === 'leistung-alt') con.meteredAt = vor(8 * 60_000);
        if (fall === 'ladestand-3min') con.socMeasuredAt = vor(3 * 60_000 + 5_000);
        if (fall === 'ladestand-alt') con.socMeasuredAt = vor(12 * 60_000);
        if (fall === 'schnell') con.boost = true;
      }
    }
    return c;
  },
  consumerSchedule: async (s: string) => {
    const p = await vorPlan(s);
    if (!planFall) return p;
    const andere = p.entities.filter((e) => e.entityId !== 'e-wb');
    if (planFall === 'ohne') return { ...p, entities: andere };
    // Das gesendete Fenster: 96 Viertelstunden ab der laufenden (13:00 bis morgen 13:00).
    const ab = Date.parse('2026-09-29T11:00:00Z');
    const laden = new Map((p.entities.find((e) => e.entityId === 'e-wb')?.slots ?? [])
      .filter((z) => (z.targetValue ?? 0) > 0.02).map((z) => [Date.parse(z.time), z]));
    const slots = Array.from({ length: 96 }, (_, i) => {
      const ms = ab + i * 900_000;
      const geladen = planFall === 'gemischt' ? laden.get(ms) : undefined;
      if (geladen) return geladen;
      const k = Math.round((ms - ZURUECK_AB) / 900_000);
      const kw = planFall === 'zurueck' || planFall === 'gemischt' ? ZURUECK_KW[k] ?? 0 : 0;
      return { time: new Date(ms).toISOString(), command: 'setpoint_kw' as const, targetValue: kw ? -kw : 0, reasonCode: 'fahrzeug_rueckspeisen', requirementId: null };
    });
    return { ...p, entities: [...andere, { entityId: 'e-wb', name: 'Wallbox Werkstatt', slots }] };
  },
  siteVerbraucher: async (s: string) => {
    const v = await vorVerbraucher(s);
    if (fall === 'sofort') {
      return { ...v, verbraucher: v.verbraucher.map((e) => e.entityId === 'e-wb' ? { ...e, steuerart: { quelle: 'sofort' as const, herkunft: 'saeule' as const } } : e) };
    }
    if (fall !== 'ohne-ladepunkt') return v;
    return { ...v, verbraucher: v.verbraucher.filter((e) => !e.ladepunkt), ladepunkte: { ...v.ladepunkte, gesamt: 0 } };
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
