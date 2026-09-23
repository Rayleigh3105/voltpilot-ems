import { sichtbareListe } from '../src/test/rollenFixtures';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  Funktionen,
  MessstelleOrtAendern,
  MessstelleRegisterZeile,
  MessstelleVorschlagsliste,
  MessstelleVorschlagUebernehmen,
  StandorteAmStichtag,
  UemsDatenquelleBestaetigt,
  UemsDatenquelleVorschlagsliste,
} from '../src/api';
import {
  ahrenbergFunktionen,
  funktionMessenEntwurf,
  funktionWerkAhrenberg,
  funktionWerkLindach,
} from '../src/test/funktionenFixtures';
import {
  ahrenbergMessen,
  C1_IDS,
  ENERGIEKARTEN,
  geraeteAhrenberg,
  registerNachUebernahme,
  uebernommen,
  vorschlagHalle2,
} from '../src/test/messenAssistentFixtures';
import { ortsbaumAhrenberg } from '../src/test/ortsbaumFixtures';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from '../src/test/standorteFixtures';

/**
 * Der Assistent „Messen & Auswerten" (UEMS AP-01 IP-9a/IP-9b) auf der Bühne
 * `messen-assistent.html` bei 375 und 1440 px: Schritt 1 → Schritt 2 mit genau
 * einem Einrichten, „Schritt n von 5", Abbruch und Wiedereinstieg über ein
 * Neuladen, der Standort ohne Anlage und die gestapelten Unterabläufe — ohne
 * Querlauf, GEMESSEN am Dokument (`scrollWidth − clientWidth`) und an jedem
 * Element der Dialoge.
 *
 * Die Cloud ist per `page.route` verdrahtet (Referenzunternehmen Ahrenberg,
 * Komponenten je Anlage wie in der Referenzdatei: AN-1 7, AN-2 6, AN-3 3). Mit
 * `MESSEN_ASSISTENT_BILDER=<Ordner>` legt der Lauf je Fall Bild und Messung ab.
 */

const BILDER = process.env.MESSEN_ASSISTENT_BILDER;
const BREITEN = [375, 1440] as const;
const LINDACH = FIXTURE_IDS.st2;
const KOMPONENTEN: Record<string, number> = { [FIXTURE_IDS.an1]: 7, [FIXTURE_IDS.an2]: 6, [FIXTURE_IDS.an3]: 3 };

interface Cloud {
  standorte: StandorteAmStichtag;
  funktionen: Funktionen;
  /** IP-9b: die Vorschlagsliste je Standort, das Register von heute und was gespeichert wurde. */
  vorschlag?: MessstelleVorschlagsliste;
  register?: MessstelleRegisterZeile[];
  uebernahmen?: MessstelleVorschlagUebernehmen[];
  orte?: { messstelle: string; anfrage: MessstelleOrtAendern }[];
  budgetAblehnung?: boolean;
  /** Nur die Bühne darf den künftigen Edge-Release vorwegnehmen. */
  wagoFaehig?: boolean;
  wagoProbeCount?: number;
  /** Was der Assistent an die Datenquellen-Prüfung geschickt hat (AP-05: `op: wago_kopf`, kein Datentyp). */
  wagoPruefAnfragen?: unknown[];
  wagoKomponenten?: Array<{ id: string; definitionVersion: number; label: string }>;
  /** AP-05 „WAGO-Soll speichern“: was der Assistent an die Soll-Lesung geschickt hat. */
  wagoSollLesungen?: Array<{ geraet: string; body: unknown }>;
  wagoKartenAnlagen?: Array<{ karten: Array<{ steckplatz: number; kartentyp: number | null; komponente: { templateRef: string; label?: string } }> }>;
  /** Schritt 2: die Datenquellen-Vorschlagsliste je Anlage (sonst leer) und was bestätigt wurde. */
  dqVorschlag?: Record<string, UemsDatenquelleVorschlagsliste>;
  dqUebernahmen?: { anlage: string; vorschlaege: UemsDatenquelleBestaetigt[] }[];
  /** Die erste Bestätigung trifft auf eine inzwischen geänderte Liste (409 `vorschlag_geaendert`). */
  dqGeaendertEinmal?: boolean;
  /** Knopf „Messanlage anlegen": was `POST /sites` bekam und ob `POST /devices/claim` kam. */
  angelegt?: { name: string; standortId?: string; netzladenErlaubt?: boolean; maxFeedInKw?: number | null }[];
  geclaimt?: number;
}

const DQ_LEER: UemsDatenquelleVorschlagsliste = { fuehrende_box: null, fuehrung: 'keine_box', vorschlaege: [], ausgelassen: [] };

/** Halle 1: ein freier Vorschlag (zwei Zähler am Gateway), dazu die zwei Komponenten des Claims ohne Adresse. */
function dqHalle1(): UemsDatenquelleVorschlagsliste {
  const box = { id: C1_IDS.boxHalle1, name: 'Box Halle 1', heimat_anlage: FIXTURE_IDS.an1 };
  const ohne = 'Für diese Komponente kennt VoltPilot keine eindeutige Adresse, unter der eine Box sie liest — sie bekommt keine Datenquelle';
  return {
    fuehrende_box: box, fuehrung: 'einzige',
    vorschlaege: [{
      kennzeichen: 'DQ-5', box, protokoll: 'modbus_tcp', adresse: '192.168.10.20:502', geraete_ids: [1], kadenz_s: 60,
      steuerquelle: false, ab: '2026-10-01T06:00:00Z',
      komponenten: [{ id: 'c0000000-0000-4000-8000-0000000000a5', name: 'Zähler Druckluft', art: 'modbus-generic' },
        { id: 'c0000000-0000-4000-8000-0000000000a6', name: 'Zähler Spritzguss', art: 'modbus-generic' }],
      grund: null, text: 'Ab 01.10.2026 08:00 liest Box Halle 1', ziel: null,
    }],
    ausgelassen: [
      { komponente: { id: 'c0000000-0000-4000-8000-0000000000b1', name: null, art: 'grid-meter' }, grund: 'keine_adresse', protokoll: null, anker: null, text: ohne },
      { komponente: { id: 'c0000000-0000-4000-8000-0000000000b2', name: null, art: 'house-load' }, grund: 'keine_adresse', protokoll: null, anker: null, text: ohne },
    ],
  };
}

/** Halle 2: die Adresse trägt schon die von Hand angelegte DQ-4 — „Zu DQ-4 hinzufügen“. */
function dqHalle2(): UemsDatenquelleVorschlagsliste {
  const box = { id: C1_IDS.boxHalle2, name: 'Box Halle 2', heimat_anlage: FIXTURE_IDS.an2 };
  return {
    fuehrende_box: box, fuehrung: 'einzige',
    vorschlaege: [{
      kennzeichen: 'DQ-6', box, protokoll: 'modbus_tcp', adresse: '192.168.20.10:502', geraete_ids: [1], kadenz_s: 60,
      steuerquelle: false, ab: '2026-10-01T06:00:00Z',
      komponenten: [{ id: 'c0000000-0000-4000-8000-0000000000c1', name: 'Zähler Halle 2', art: 'modbus-generic' }],
      grund: 'adresse_an_box_vergeben', text: 'Diese Adresse liest Box Halle 2 bereits als DQ-4 — Gerät dort hinzufügen?',
      ziel: { id: 'd0000000-0000-4000-8000-000000000004', kennzeichen: 'DQ-4', name: 'WAGO-Steuerung Halle 2' },
    }],
    ausgelassen: [],
  };
}

const ohneMessen = (): Cloud => ({
  standorte: ahrenbergHeute(),
  funktionen: ahrenbergFunktionen({ messen: 'bestand' }),
});

const lindachImEntwurf = (standorte = ahrenbergHeute()): Cloud => ({
  standorte,
  funktionen: ahrenbergFunktionen({
    standorte: [funktionWerkAhrenberg('bestand'), funktionMessenEntwurf(funktionWerkLindach('bestand'))],
  }),
});

/** Verdrahtet die Cloud; das Ergebnis zählt jedes `PUT …/funktionen/messen` (Standort-Kennung). */
async function verdrahte(page: Page, cloud: Cloud) {
  const einrichten: string[] = [];
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const pfad = url.pathname.slice(url.pathname.indexOf('/api/v1'));
    const methode = r.request().method();
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/standorte' && methode === 'GET') return json(cloud.standorte);
    if (pfad === '/api/v1/unternehmen') return json(ahrenbergUnternehmen());
    if (pfad === '/api/v1/funktionen') return json(cloud.funktionen);
    if (pfad === '/api/v1/standorte/kurzzeichen-vorschlag') return json({ kurzzeichen: 'ST-3' });
    const messen = /^\/api\/v1\/standorte\/([^/]+)\/funktionen\/messen$/.exec(pfad);
    if (messen && methode === 'PUT') {
      einrichten.push(messen[1]);
      const vorher = cloud.funktionen.standorte.find((s) => s.id === messen[1])!;
      if (vorher.messen.zustand !== 'kein_objekt') {
        return json({ code: 'bereits_angelegt', message: 'Messen & Auswerten ist hier bereits angelegt', fehlt: [], wege: [] }, 409);
      }
      const danach = funktionMessenEntwurf(vorher);
      cloud.funktionen = {
        ...cloud.funktionen,
        standorte: cloud.funktionen.standorte.map((s) => (s.id === danach.id ? danach : s)),
      };
      return json({ aktion: 'einrichten', standort: danach });
    }
    if (/^\/api\/v1\/standorte\/[^/]+\/messstellen-vorschlag$/.test(pfad) && cloud.vorschlag) return json(cloud.vorschlag);
    if (/^\/api\/v1\/standorte\/[^/]+\/messstellen-vorschlag\/uebernehmen$/.test(pfad) && cloud.vorschlag && methode === 'POST') {
      const anfrage = r.request().postDataJSON() as MessstelleVorschlagUebernehmen;
      (cloud.uebernahmen ??= []).push(anfrage);
      const antwort = uebernommen(cloud.vorschlag, anfrage);
      cloud.vorschlag = {
        ...cloud.vorschlag,
        vorschlaege: [],
        leer: 'alle_zugeordnet',
        text: 'Alle Komponenten von Werk Ahrenberg sind Messstellen zugeordnet.',
      };
      return json(antwort);
    }
    if (/^\/api\/v1\/standorte\/[^/]+\/orte$/.test(pfad)) return json(ortsbaumAhrenberg());
    const ort = /^\/api\/v1\/messstellen\/([^/]+)\/ort$/.exec(pfad);
    if (ort && methode === 'PUT') {
      (cloud.orte ??= []).push({ messstelle: ort[1], anfrage: r.request().postDataJSON() as MessstelleOrtAendern });
      return json({ id: ort[1] });
    }
    if (pfad === '/api/v1/messstellen' && cloud.register) {
      return json({
        messstellen: [],
        register: cloud.register,
        stichtag: '2026-10-20',
        zeitpunkt: '2026-10-20T08:15:30Z',
        teilansicht: false,
        aggregat: { unternehmen: { erfuellt: 0, gesamt: 0, text: '' }, standorte: [] },
      });
    }
    if (pfad === '/api/v1/devices') return json(sichtbareListe(geraeteAhrenberg(new Date())));
    if (pfad === '/api/v1/edge-versions') return json(sichtbareListe([
      { deviceId: C1_IDS.boxHalle1, siteId: FIXTURE_IDS.an1, coreVersion: '2.8.0', paletteVersion: '1.14.0', reportedAt: new Date().toISOString() },
      { deviceId: C1_IDS.boxHalle2, siteId: FIXTURE_IDS.an2, coreVersion: '2.8.0', paletteVersion: '1.14.0', reportedAt: new Date().toISOString(),
        capabilities: cloud.wagoFaehig ? ['data_sources', 'events', 'wago_registerbild'] : ['data_sources', 'events'] },
    ]));
    if (pfad === '/api/v1/sites' && methode === 'POST') {
      // Der Anlege-Fluss (Knopf „Messanlage anlegen"): die neue Anlage hängt ab heute am gewählten Standort.
      const body = r.request().postDataJSON() as NonNullable<Cloud['angelegt']>[number];
      (cloud.angelegt ??= []).push(body);
      const neu = { id: 'a0000000-0000-4000-8000-00000000a0f3', name: body.name };
      cloud.standorte = {
        ...cloud.standorte,
        standorte: cloud.standorte.standorte.map((s) => (s.id !== body.standortId ? s : {
          ...s,
          anlagen: [...s.anlagen, { ...neu, gueltigAb: cloud.standorte.stichtag, gueltigBis: null }],
          anlagenZahl: s.anlagenZahl + 1,
        })),
      };
      return json({
        ...neu, biddingZone: 'DE-LU', latitude: null, longitude: null, plantKind: 'eigenverbrauch',
        anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
      }, 201);
    }
    if (pfad === '/api/v1/devices/claim' && methode === 'POST') {
      cloud.geclaimt = (cloud.geclaimt ?? 0) + 1;
      return json({
        id: 'box-neu', siteId: 'a0000000-0000-4000-8000-00000000a0f3', externalRef: 'VP-DEMO-0001', kind: 'inverter',
        name: null, status: 'active', lastSeenAt: null, createdAt: new Date().toISOString(),
      }, 201);
    }
    if (/^\/api\/v1\/sites\/[^/]+\/assets$/.test(pfad)) return json([]);
    if (pfad === '/api/v1/sites') {
      return json(sichtbareListe(cloud.standorte.standorte.flatMap((s) => s.anlagen).map((a) => ({ id: a.id, name: a.name }))));
    }
    const komponenten = /^\/api\/v1\/sites\/([^/]+)\/components$/.exec(pfad);
    if (komponenten) {
      if (methode === 'POST' && cloud.wagoFaehig) {
        const body = r.request().postDataJSON() as { label?: string };
        const zeile = { id: `wago-k-${(cloud.wagoKomponenten?.length ?? 0) + 1}`, definitionVersion: 1, label: body.label ?? 'Energiekarte' };
        (cloud.wagoKomponenten ??= []).push(zeile);
        return json({ componentAuthority: 'cloud', components: [...Array.from({ length: KOMPONENTEN[komponenten[1]] ?? 0 }, (_, i) => ({ id: `k-${i + 1}`, definitionVersion: 1 })), ...cloud.wagoKomponenten] }, 201);
      }
      const n = KOMPONENTEN[komponenten[1]] ?? 0;
      return json({ componentAuthority: 'cloud', components: [...Array.from({ length: n }, (_, i) => ({ id: `k-${i + 1}`, definitionVersion: 1 })), ...(cloud.wagoKomponenten ?? [])] });
    }
    if (/^\/api\/v1\/sites\/[^/]+\/component-test$/.test(pfad) && methode === 'POST' && cloud.wagoFaehig) {
      const body = r.request().postDataJSON() as { connection?: { slot?: number } };
      const slot = Number(body.connection?.slot ?? 1);
      return json({ requestId: `wago-wert-${slot}`, errorCode: null, message: null, results: [{
        id: 'verbindung', ok: true, errorCode: null, message: 'Werte gelesen',
        reading: { steckplatz: slot, kartentyp: 494, 'Spannung L1': 230.4, 'Wirkleistung gesamt': 18.7 + slot, 'Zählerstand Bezug': 36912.4 + slot },
      }] });
    }
    if (/^\/api\/v1\/sites\/[^/]+\/wago\/karten$/.test(pfad) && methode === 'POST' && cloud.wagoFaehig) {
      // B05: Karten-Komponenten und Controller in EINEM Aufruf, je Karte ein Teil am Steckplatz.
      const body = r.request().postDataJSON() as NonNullable<Cloud['wagoKartenAnlagen']>[number];
      (cloud.wagoKartenAnlagen ??= []).push(body);
      const karten = [...body.karten].sort((a, b) => a.steckplatz - b.steckplatz).map((k, i) => {
        const zeile = { id: `wago-k-${(cloud.wagoKomponenten?.length ?? 0) + 1}`, definitionVersion: 1, label: k.komponente.label ?? 'Energiekarte' };
        (cloud.wagoKomponenten ??= []).push(zeile);
        return { entityId: zeile.id, teilId: `teil-${k.steckplatz}`, steckplatz: k.steckplatz, typ: k.kartentyp ? `750-${k.kartentyp}` : null, index: i + 1 };
      });
      return json({ geraetId: 'geraet-c-1', kennzeichen: 'GR-7', eingebautAm: '2026-10-20T08:15:00Z', karten });
    }
    if (/^\/api\/v1\/sites\/[^/]+\/components\/[^/]+\/wago$/.test(pfad) && methode === 'PUT' && cloud.wagoFaehig) {
      const body = r.request().postDataJSON() as { expected_revision: number; anwenderskalierung: boolean | null; register35: number | null };
      return json({ slot: 1, anwenderskalierung: body.anwenderskalierung, register35: body.register35, version: body.expected_revision + 1 });
    }
    if (/^\/api\/v1\/sites\/[^/]+\/geraete$/.test(pfad) && cloud.wagoFaehig) return json({ geraete: [{
      id: 'geraet-c-1', kennzeichen: 'GR-7', einbau_kennzeichen: 'GR-7', ausgebaut_am: null,
      komponenten: (cloud.wagoKomponenten ?? []).map((k) => ({ entity_id: k.id, gueltig_ab: '2026-10-20T08:15:00Z', gueltig_bis: null })),
    }] });
    if (/^\/api\/v1\/geraete\/[^/]+\/wago$/.test(pfad) && methode === 'PUT' && cloud.wagoFaehig) return json(r.request().postDataJSON());
    if (/^\/api\/v1\/geraete\/[^/]+\/wago\/soll-lesen$/.test(pfad) && methode === 'POST' && cloud.wagoFaehig) {
      (cloud.wagoSollLesungen ??= []).push({ geraet: pfad.split('/')[4], body: r.request().postDataJSON() });
      return json({ ergebnis: 'gespeichert', satz: 'Das Soll wurde aus der Steuerung gelesen und gespeichert.',
        soll: { controllerKennung: 8212, karten: [1, 2, 3, 4].map((steckplatz) => ({ steckplatz, typ: '750-494', variante: 0 })) },
        abweichungen: [] });
    }
    if (/^\/api\/v1\/geraete\/[^/]+\/einstellungen$/.test(pfad) && methode === 'POST' && cloud.wagoFaehig) return json({ fassung: {}, beendet: null, folgen: [], messstellen: [] }, 201);
    if (pfad === '/api/v1/component-templates') return json([]);
    const dqv = /^\/api\/v1\/sites\/([^/]+)\/data-sources\/vorschlag(\/uebernehmen)?$/.exec(pfad);
    if (dqv) {
      const liste = cloud.dqVorschlag?.[dqv[1]] ?? DQ_LEER;
      if (!dqv[2] && methode === 'GET') return json(liste);
      if (dqv[2] && methode === 'POST') {
        const { vorschlaege } = r.request().postDataJSON() as { vorschlaege: UemsDatenquelleBestaetigt[] };
        (cloud.dqUebernahmen ??= []).push({ anlage: dqv[1], vorschlaege });
        if (cloud.dqGeaendertEinmal) {
          cloud.dqGeaendertEinmal = false;
          return json({ code: 'vorschlag_geaendert', message: 'Dieser Vorschlag hat sich inzwischen geändert — bitte die Vorschlagsliste neu laden' }, 409);
        }
        const bestaetigt = liste.vorschlaege.filter((v) => vorschlaege.some((b) => b.device_id === v.box.id && b.adresse === v.adresse));
        cloud.dqVorschlag = { ...cloud.dqVorschlag, [dqv[1]]: { ...liste, vorschlaege: liste.vorschlaege.filter((v) => !bestaetigt.includes(v)) } };
        const angehaengt = vorschlaege.filter((b) => b.datenquelle_id).length;
        return json({
          neu: vorschlaege.length - angehaengt, unveraendert: 0, angehaengt,
          datenquellen: bestaetigt.map((v) => ({ id: v.ziel?.id ?? 'd0000000-0000-4000-8000-000000000005', kennzeichen: v.ziel?.kennzeichen ?? v.kennzeichen })),
        });
      }
    }
    const quelle = /^\/api\/v1\/sites\/([^/]+)\/data-sources(?:\/([^/]+))?(?:\/(reachability-check|assignments))?$/.exec(pfad);
    if (quelle) {
      const body = methode === 'GET' ? {} : r.request().postDataJSON() as Record<string, unknown>;
      const boxId = String(body.device_id ?? C1_IDS.boxHalle2);
      const boxName = boxId === C1_IDS.boxHalle1 ? 'Box Halle 1' : 'Box Halle 2';
      const datenquelle = {
        id: 'd0000000-0000-4000-8000-000000000004', kennzeichen: 'DQ-4',
        name: body.name ?? 'WAGO-Steuerung Halle 2', anlage: quelle[1],
        protokoll: body.protokoll ?? 'modbus_tcp', adresse: body.adresse ?? '192.168.20.10:502',
        geraete_ids: body.geraete_ids ?? [1], netz: body.netz ?? 'VLAN 20 „Produktion“',
        mehrere_leser: false, steuerquelle: false, vergleichsquelle: false,
        kadenz_s: body.kadenz_s ?? 60, archiviert_am: null, zustaendige_box: null, zeitraeume: [],
      };
      if (!quelle[2] && methode === 'POST') return json(datenquelle, 201);
      if (quelle[2] && !quelle[3] && methode === 'PUT') return json(datenquelle);
      if (quelle[3] === 'reachability-check' && cloud.wagoFaehig) {
        // Die Bühne antwortet wie die api (DatenquelleService.pruefen): nur `op: wago_kopf` liest den
        // Kopf; ein Datentyp daneben ist eine 400, und ohne `op` wäre es ein gewöhnlicher read.
        (cloud.wagoPruefAnfragen ??= []).push(body);
        if (body.op !== 'wago_kopf' || body.data_type != null) {
          return json({ code: 'anfrage_ungueltig', feld: body.op !== 'wago_kopf' ? 'op' : 'data_type',
            message: 'Den Kopf liest die Box ohne Datentyp — sein Aufbau ist fest.' }, 400);
        }
        cloud.wagoProbeCount = (cloud.wagoProbeCount ?? 0) + 1;
        return json({
          box: { id: boxId, name: boxName, heimat_anlage: FIXTURE_IDS.an2 },
          adresse: datenquelle.adresse, ergebnis: 'ok', gewertet: true,
          text: `${boxName} erreicht ${datenquelle.adresse}.`, zeitpunkt: new Date().toISOString(), dauer_ms: 184,
          antwort: { requestId: `wago-kopf-${cloud.wagoProbeCount}`, results: [{ id: 'erreichbarkeit', ok: true,
            wago_kopf: { signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kopflaenge: 12, kartenblocklaenge: 42, kartenzahl: 4, herzschlag: 1731, controller_kennung: 8212 } }] },
          wago: {
            erkannt: true, satz: 'Registerbild v1 erkannt — Controller-Kennung 8212, 4 Energiekarten.',
            controller_kennung: 8212, kartenzahl: 4,
            karten: [1, 2, 3, 4].map((karte) => ({ karte, steckplatz: karte, kartentyp: 494, variante: 0 })),
          },
        });
      }
      if (quelle[3] === 'reachability-check') return json({
        box: { id: boxId, name: boxName, heimat_anlage: FIXTURE_IDS.an2 },
        adresse: datenquelle.adresse, ergebnis: 'ok', gewertet: true,
        text: `${boxName} erreicht ${datenquelle.adresse}.`, zeitpunkt: new Date().toISOString(), dauer_ms: 184, antwort: {},
      });
      if (quelle[3] === 'assignments' && cloud.budgetAblehnung) return json({
        code: 'budget_ueberschritten', urteil: 'abgelehnt',
        message: `Diese Quelle passt nicht mehr in das Lesebudget von ${boxName} — Takt strecken oder andere Box wählen.`,
        rechnung: {
          code: 'budget_ueberschritten', kennzeichen: 'DQ-4', box: boxName,
          quelle: { protokoll: 'modbus_tcp', channels: 8, takt_s: 10,
            anfragen: [{ anfragen_je_takt: 4, kosten_ms_je_anfrage: 400 }],
            last: { channels: 8, samples_per_minute: 48, requests_per_minute: 24, duty_cycle_percent: 16 } },
          box_nachher: { channels: 74, samples_per_minute: 114, requests_per_minute: 46, duty_cycle_percent: 30.667 },
          grenzen: { samples_per_minute: 600, requests_per_minute: 30, duty_cycle_percent: 20 },
          freie_kapazitaet: [
            { id: C1_IDS.boxHalle1, name: 'Box Halle 1', belegt: { channels: 66, samples_per_minute: 66, requests_per_minute: 22, duty_cycle_percent: 14.7 }, frei: { channels: 0, samples_per_minute: 534, requests_per_minute: 8, duty_cycle_percent: 5.3 }, quelle_passt: false },
            { id: C1_IDS.boxHalle2, name: 'Box Halle 2', belegt: { channels: 55, samples_per_minute: 55, requests_per_minute: 1, duty_cycle_percent: 0.7 }, frei: { channels: 0, samples_per_minute: 545, requests_per_minute: 29, duty_cycle_percent: 19.3 }, quelle_passt: true },
          ],
          auswege: { takt_s: 60, takt: 'Takt 60 s wählen', boxen: [{ id: C1_IDS.boxHalle2, name: 'Box Halle 2', belegt: { channels: 55, samples_per_minute: 55, requests_per_minute: 1, duty_cycle_percent: 0.7 }, frei: { channels: 0, samples_per_minute: 545, requests_per_minute: 29, duty_cycle_percent: 19.3 }, quelle_passt: true }], andere_box: 'Box Halle 2 wählen (29 Anfragen/min frei)' },
          gruende: ['Mehr als 30 Leseanfragen pro Minute.'],
        },
      }, 422);
      if (quelle[3] === 'assignments') return json({ urteil: 'erlaubt', text: `Ab jetzt liest ${boxName}`, hinweis: null, vergleichsquelle: false, datenquelle }, 201);
    }
    return json({ code: 'nicht_gefunden', message: 'Nicht gefunden.' }, 404);
  });
  return einrichten;
}

async function oeffne(page: Page, breite: number, suche = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/messen-assistent.html${suche}`);
  // Am Telefon heißt die Schale nur „Messen & Auswerten" (neben Pfeil und Kreuz würde „… einrichten" gekürzt).
  await expect(page.getByRole('dialog', { name: breite < 720 ? 'Messen & Auswerten' : 'Messen & Auswerten einrichten', exact: true })).toBeVisible();
}

const schritt1 = (page: Page) => expect(page.getByRole('heading', { name: 'Wo wird gemessen?' })).toBeVisible();
const schritt2 = (page: Page) => expect(page.getByRole('heading', { name: 'Womit wird gemessen?' })).toBeVisible();

/** „Schritt n von 5": am Telefon sichtbar im Kopf, am Rechner als benannter Schritt der Leiste; immer in der Ansage. */
async function zaehlerIst(page: Page, breite: number, n: number, name: string) {
  if (breite < 720) {
    await expect(page.locator('.vp-anlegen-zaehler').first()).toHaveText(`Schritt ${n} von 5`);
  } else {
    await expect(page.locator('.vp-anlegen-steps li[aria-current="step"]').first()).toContainText(name);
  }
  await expect(page.locator('.vp-anlegen-sr').first()).toHaveText(`Schritt ${n} von 5: ${name}`);
}

/** Querlauf in px: Dokument, Rumpf der Dialoge und jedes Element eines Dialogs über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-anlegen-dialog *, .vp-modal *')]
      // Die unsichtbare Ansage der Schale (`.vp-anlegen-sr`, 1 px, `clip: rect(0 0 0 0)`) ist kein Querlauf.
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)')
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Kacheln der Karte im Anlege-Fluss liegen über den Rand, die Karte schneidet sie ab (wie `anlage-umziehen.spec.ts`).
      .filter(({ el }) => !el.closest('.leaflet-container'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const rumpf = [...document.querySelectorAll('.vp-anlegen-rumpf, .vp-modal .dbody')] as HTMLElement[];
    // Gekürzt oder zu eng: ein Titel mit Auslassung, ein Knopf, dessen Text über seinen Rand ragt.
    const gekuerzt = [...document.querySelectorAll('.vp-anlegen-titel h2, .vp-anlegen-dialog button, .vp-modal button')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    return {
      dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rumpf: rumpf.length ? Math.max(...rumpf.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
      gekuerzt,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.rumpf, `${name} ${breite}: Rumpf`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(m.gekuerzt, `${name} ${breite}: gekürzt`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  if (await page.locator('.vp-modal').count()) return;
  // Der ganze Rumpf des obersten Schritt-Dialogs, nicht nur der erste Bildschirm.
  const hoehe = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.vp-anlegen-dialog')].at(-1) as HTMLElement | undefined;
    const rumpf = d?.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
    return d && rumpf ? d.offsetHeight - rumpf.clientHeight + rumpf.scrollHeight + 24 : 0;
  });
  const vorher = page.viewportSize()!;
  if (hoehe > vorher.height) {
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

for (const breite of BREITEN) {
  test.describe(`Messen & Auswerten einrichten · ${breite} px`, () => {
    test('Schritt 1 → 2 → 1 → 2: genau ein Einrichten, „Schritt n von 5", Abbruch und Wiedereinstieg', async ({ page }) => {
      const cloud = ohneMessen();
      const einrichten = await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt1(page);
      await zaehlerIst(page, breite, 1, 'Standort');
      await expect(page.getByText('Messen & Auswerten — noch nicht eingerichtet')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt1');

      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await schritt2(page);
      await zaehlerIst(page, breite, 2, 'Datenquelle');
      await expect(page.getByText('3 Komponenten angebunden')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt2');

      await page.getByRole('button', { name: 'Zurück', exact: true }).click();
      await schritt1(page);
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await schritt2(page);
      expect(einrichten).toEqual([LINDACH]);

      // Abbruch: der Assistent geht zu, der Entwurf bleibt …
      await page.getByRole('button', { name: 'Schließen', exact: true }).click();
      await expect(page.getByTestId('assistent-geschlossen')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('vp.uems.messen-assistent.entwurf.v1'))).toBe(
        JSON.stringify({ standortId: LINDACH, schritt: 2 }),
      );
      // … und nach einem Neuladen OHNE Vorwahl steht er wieder auf Schritt 2 — ohne zweites Einrichten.
      await oeffne(page, breite);
      await schritt2(page);
      await zaehlerIst(page, breite, 2, 'Datenquelle');
      await expect(page.getByText('Werk Lindach (ST-2)')).toBeVisible();
      await messeUndFotografiere(page, breite, 'wiedereinstieg');
      expect(einrichten).toEqual([LINDACH]);
    });

    test('Standort ohne Anlage: „Messanlage anlegen" öffnet den Anlege-Fluss still und kehrt zu Schritt 2 zurück', async ({ page }) => {
      const cloud = lindachImEntwurf({ ...ahrenbergHeute(), standorte: [werkAhrenberg(), werkLindach({ anlagen: [], anlagenZahl: 0 })] });
      await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt2(page);
      const leer = page.getByTestId('messen-keine-anlage');
      await expect(leer).toContainText('An Werk Lindach hängt noch keine Anlage.');
      await expect(leer).toContainText('Legen Sie hier eine Messanlage an. Sie gehört dann zu Werk Lindach');
      await expect(leer.getByRole('button')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Anderen Standort wählen', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Später fortsetzen', exact: true })).toBeVisible();
      await messeUndFotografiere(page, breite, 'ohne-anlage');

      // Derselbe Anlege-Fluss, Werk Lindach vorbelegt; die Schale des Assistenten macht Platz.
      await leer.getByRole('button', { name: 'Messanlage anlegen', exact: true }).click();
      const fluss = page.getByRole('dialog', { name: 'Anlage anlegen' });
      await expect(fluss).toBeVisible();
      await expect(page.locator('.vp-anlegen-dialog')).toHaveCount(0);
      await expect(fluss.getByRole('combobox', { name: 'Standort *' })).toContainText('Werk Lindach (ST-2)');
      await expect(fluss.locator('.vp-step-label')).toHaveText(['Anlage', 'Register', 'Gerät']);
      const woerter = () => page.evaluate(() => (window as unknown as { steuerGeldWoerterDerSeite: () => string[] }).steuerGeldWoerterDerSeite());
      expect(await woerter(), 'Schritt 1').toEqual([]);
      await messeUndFotografiere(page, breite, 'messanlage-schritt1');
      await fluss.getByLabel('Name der Anlage').fill('Halle 3');
      await fluss.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(fluss.getByText('PV & Speicher aus dem Register')).toBeVisible();
      expect(await woerter(), 'Register').toEqual([]);
      await fluss.getByRole('button', { name: 'Überspringen - später nachtragen', exact: true }).click();
      await expect(fluss.getByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeVisible();
      expect(await woerter(), 'Gerät').toEqual([]);
      await fluss.getByLabel('Geräte-ID').fill('vp-demo-0001');
      await fluss.getByRole('button', { name: 'Anlage anlegen', exact: true }).click();
      const zurueck = fluss.getByRole('button', { name: 'Weiter mit „Messen & Auswerten“', exact: true });
      await expect(zurueck).toBeVisible();
      await expect(fluss.getByRole('button', { name: 'Zu den Messstellen' })).toHaveCount(0);
      expect(await woerter(), 'Fertig').toEqual([]);
      await messeUndFotografiere(page, breite, 'messanlage-fertig');
      expect(cloud.angelegt).toEqual([expect.objectContaining({ name: 'Halle 3', standortId: LINDACH, netzladenErlaubt: false, maxFeedInKw: null })]);
      expect(cloud.geclaimt).toBe(1);

      // Zurück im Assistenten: Schritt 2 mit der neuen Anlage, die Adresse bleibt.
      const vorher = page.url();
      await zurueck.click();
      await schritt2(page);
      await zaehlerIst(page, breite, 2, 'Datenquelle');
      await expect(page.getByRole('button', { name: 'Datenquelle anlegen für Halle 3', exact: true })).toBeVisible();
      await expect(page.getByTestId('messen-keine-anlage')).toHaveCount(0);
      expect(page.url()).toBe(vorher);
      await messeUndFotografiere(page, breite, 'messanlage-zurueck');
    });

    test('die bestehenden Dialoge liegen über dem Assistenten — ohne Querlauf', async ({ page }) => {
      await verdrahte(page, lindachImEntwurf());
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt2(page);

      await page.getByRole('button', { name: 'Gerät verbinden für Werk Lindach', exact: true }).click();
      const geraet = page.getByRole('dialog', { name: /Gerät hinzufügen/ });
      await expect(geraet).toBeVisible();
      // Der Unterablauf ersetzt die Schale — nichts liegt über ihm (das Haus-Modal läge sonst darunter).
      await expect(page.getByRole('dialog', { name: /^Messen & Auswerten/ })).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'geraet-verbinden');
      await geraet.getByRole('button', { name: 'Abbrechen', exact: true }).click();
      await expect(geraet).toHaveCount(0);
      await zaehlerIst(page, breite, 2, 'Datenquelle');

      await page.getByRole('button', { name: 'Gerät anbinden für Werk Lindach', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Gerät anbinden' })).toBeVisible();
      await messeUndFotografiere(page, breite, 'geraet-anbinden');
    });

    test('Datenquelle anlegen: Box-Wahl, Prüfung und Budget-Ablehnung mit zwei Auswegen', async ({ page }) => {
      const cloud: Cloud = {
        standorte: ahrenbergHeute(),
        funktionen: ahrenbergFunktionen({
          standorte: [funktionMessenEntwurf(funktionWerkAhrenberg('bestand')), funktionWerkLindach('bestand')],
        }),
        budgetAblehnung: true,
      };
      await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${FIXTURE_IDS.st1}`);
      await schritt2(page);
      await page.getByRole('button', { name: 'Datenquelle anlegen für Werk Ahrenberg – Halle 2', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Datenquelle anlegen' });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('dialog', { name: /^Messen & Auswerten/ })).toHaveCount(0);
      await dialog.getByLabel('Name').fill('WAGO-Steuerung Halle 2');
      await dialog.getByLabel('Adresse').fill('192.168.20.10:502');
      await dialog.getByLabel('Netzlage').fill('VLAN 20 „Produktion“');
      await dialog.getByLabel('Takt in Sekunden').fill('10');
      await dialog.getByRole('radio', { name: /Box Halle 1/ }).check();
      await expect(dialog.getByText('Box Halle 2').first()).toBeVisible();
      await expect(dialog.getByText('Software 2.8.0')).toHaveCount(2);
      await expect(dialog.getByText('Freies Lesebudget: wird beim Einrichten geprüft')).toHaveCount(2);
      await dialog.getByRole('button', { name: 'Entwurf anlegen' }).click();
      await expect(dialog.getByText(/DQ-4 ist als Entwurf angelegt/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Von Box Halle 1 prüfen' }).click();
      await expect(dialog.getByText(/Erreichbar · 184 ms/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Einrichtung abschließen' }).click();
      const ablehnung = dialog.getByRole('alert');
      await expect(ablehnung).toContainText('Takt strecken oder andere Box wählen');
      await expect(dialog.getByRole('button', { name: 'Takt 60 s wählen' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Box Halle 2 wählen (29 Anfragen/min frei)' })).toBeVisible();
      await expect(dialog.getByText('Frei: 545 Messwerte/min · 29 Anfragen/min · 19,3 % Buszeit')).toBeVisible();
      await ablehnung.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'datenquelle-budget');
    });

    test('WAGO: Kopf → ausgelesene Karten → drei Angaben → Komponenten → Messstellen-Vorschläge', async ({ page }) => {
      const cloud: Cloud = {
        standorte: ahrenbergHeute(),
        funktionen: ahrenbergFunktionen({
          standorte: [funktionMessenEntwurf(funktionWerkAhrenberg('bestand')), funktionWerkLindach('bestand')],
        }),
        vorschlag: vorschlagHalle2(),
        wagoFaehig: true,
      };
      await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${FIXTURE_IDS.st1}`);
      await schritt2(page);
      await page.getByRole('button', { name: 'WAGO-Steuerung anbinden für Werk Ahrenberg – Halle 2', exact: true }).click();

      await expect(page.getByRole('heading', { name: 'Verbindung zur WAGO-Steuerung prüfen' })).toBeVisible();
      await page.getByLabel('Adresse', { exact: true }).fill('192.168.20.10');
      await page.getByLabel('Netzlage').fill('VLAN 20 „Produktion“');
      await page.getByRole('button', { name: 'Kopf prüfen', exact: true }).click();
      await expect(page.getByText('Registerbild v1.0')).toBeVisible();
      await expect(page.getByText('4 Energiekarten')).toBeVisible();
      await expect(page.getByText(/Herzschlag 1\.731/)).toBeVisible();
      // Die echte Kopf-Antwort: Kennung und je Karte Steckplatz/Typ/Variante — gelesen, nicht angenommen.
      await expect(page.getByText('Controller-Kennung 8212', { exact: true })).toBeVisible();
      const gelesen = page.getByRole('list', { name: 'Gelesene Energiekarten' });
      await expect(gelesen.getByRole('listitem')).toHaveCount(4);
      await expect(gelesen.getByText('Karte 1: Steckplatz 1 · 750-494 · Variante 0', { exact: true })).toBeVisible();
      expect(cloud.wagoPruefAnfragen).toEqual([{ device_id: expect.any(String), op: 'wago_kopf', unit_id: 1,
        register: expect.any(Number), register_kind: expect.stringMatching(/^(holding|input)$/), word_order: expect.stringMatching(/^(big|little)$/) }]);
      await page.getByRole('button', { name: 'Kopf erneut prüfen', exact: true }).click();
      await expect(page.getByText('Herzschlag steht bei 1.731')).toBeVisible();
      await messeUndFotografiere(page, breite, 'wago-kopf');

      await page.getByRole('button', { name: breite < 720 ? 'Karten lesen' : 'Karten auslesen und weiter', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ausgelesene Energiekarten ergänzen' })).toBeVisible();
      await expect(page.getByText('Steckplatz 1 · 750-494')).toBeVisible();
      await expect(page.getByText('In Prüfung — Einsatz noch nicht bestätigt', { exact: true })).toBeVisible();
      const karten = page.locator('.vp-wago-karten > li');
      await expect(karten).toHaveCount(4);
      for (let index = 0; index < 4; index += 1) {
        await karten.nth(index).getByLabel('Was misst die Karte?').fill(['Zuleitung Halle 2', 'Abgang Produktion', 'Maschine M1', 'Maschine M2'][index]);
        await karten.nth(index).getByLabel('Wandler Primärwert in A').fill('400');
        await karten.nth(index).getByLabel('Wandler Sekundärwert in A').fill('5');
      }
      await expect(page.getByText(/Messwert-Tabelle und Skalierungsfaktor nicht belegt/)).toBeVisible();
      await messeUndFotografiere(page, breite, 'wago-karten');

      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Werte prüfen und Komponenten anlegen' })).toBeVisible();
      await page.getByRole('button', { name: 'Echte Werte lesen', exact: true }).click();
      await expect(page.getByText('Wirkleistung gesamt: 19,7')).toBeVisible();
      await expect(page.getByText('Zählerstand Bezug: 36.913,4')).toBeVisible();
      await messeUndFotografiere(page, breite, 'wago-werte');
      await page.getByRole('button', { name: 'Komponenten anlegen', exact: true }).click();
      await expect(page.getByText('Komponenten angelegt', { exact: true })).toBeVisible();
      // Das Soll liest die Box selbst — der Assistent fragt nichts, er zeigt nur, was gelesen wurde.
      const soll = page.getByTestId('wago-soll');
      await expect(soll.getByText('Soll aus der Steuerung gespeichert', { exact: true })).toBeVisible();
      await expect(soll.getByText('Controller-Kennung 8212', { exact: true })).toBeVisible();
      await expect(soll.getByRole('listitem')).toHaveCount(5);
      expect(cloud.wagoSollLesungen).toEqual([{ geraet: 'geraet-c-1', body: { deviceId: expect.any(String) } }]);
      // EIN Anlege-Aufruf mit je Karte Steckplatz und gelesenem Kartentyp — keine Komponente einzeln.
      expect(cloud.wagoKartenAnlagen?.map((a) => a.karten.map((k) => [k.steckplatz, k.kartentyp, k.komponente.templateRef])))
        .toEqual([[1, 2, 3, 4].map((steckplatz) => [steckplatz, 494, 'certified:wago:pm494_pm495_registerbild_v1'])]);
      await messeUndFotografiere(page, breite, 'wago-komponenten');
      await page.getByRole('button', { name: breite < 720 ? 'Zu den Messstellen' : 'Zur Messstellen-Vorschlagsliste', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Was bedeutet jeder Messkanal?' })).toBeVisible();
    });

    test('Schritt 2 zeigt die Vorschlagsliste und sendet vorschlag/uebernehmen', async ({ page }) => {
      const cloud: Cloud = {
        standorte: ahrenbergHeute(),
        funktionen: ahrenbergFunktionen({
          standorte: [funktionMessenEntwurf(funktionWerkAhrenberg('bestand')), funktionWerkLindach('bestand')],
        }),
        dqVorschlag: { [FIXTURE_IDS.an1]: dqHalle1(), [FIXTURE_IDS.an2]: dqHalle2() },
        dqGeaendertEinmal: true,
      };
      await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${FIXTURE_IDS.st1}`);
      await schritt2(page);
      const halle1 = page.locator(`[data-testid="dq-vorschlag"][data-anlage="${FIXTURE_IDS.an1}"]`);
      const halle2 = page.locator(`[data-testid="dq-vorschlag"][data-anlage="${FIXTURE_IDS.an2}"]`);
      // Nichts ändert sich vor der Bestätigung: die Liste ist gelesen, nichts gesendet.
      await expect(halle1.getByText('Box Halle 1 · Modbus TCP · 192.168.10.20:502 (Geräte-ID 1)')).toBeVisible();
      await expect(halle1.getByText('Dahinter: Zähler Druckluft, Zähler Spritzguss')).toBeVisible();
      await expect(halle1.getByText('Ab 01.10.2026 08:00 liest Box Halle 1')).toBeVisible();
      // Die Komponenten des Claims ohne Adresse: eingeklappt, mit Namen und Grund.
      await expect(halle1.getByText('Ohne Datenquelle (2)')).toBeVisible();
      await expect(halle1.getByText(/^Netzanschlusszähler: /)).toBeHidden();
      await expect(halle2.getByText('Diese Adresse liest Box Halle 2 bereits als DQ-4 — Gerät dort hinzufügen?')).toBeVisible();
      await expect(halle2.getByRole('button', { name: 'Datenquellen übernehmen für Werk Ahrenberg – Halle 2' })).toHaveCount(0);
      expect(cloud.dqUebernahmen ?? []).toEqual([]);
      await messeUndFotografiere(page, breite, 'dq-vorschlag');

      // Übernehmen: genau die gezeigte Zeile; die erste Antwort ist 409 → Liste neu mit Hinweis, dann gelingt es.
      const uebernehmen = page.getByRole('button', { name: 'Datenquellen übernehmen für Werk Ahrenberg – Halle 1', exact: true });
      await uebernehmen.click();
      await expect(halle1.getByText(/Die Vorschläge haben sich inzwischen geändert/)).toBeVisible();
      await uebernehmen.click();
      await expect(halle1.getByText('Datenquelle DQ-5 angelegt.')).toBeVisible();
      await expect(halle1.getByTestId('dq-vorschlag-leer')).toBeVisible();
      const gezeigt = {
        device_id: C1_IDS.boxHalle1, protokoll: 'modbus_tcp', adresse: '192.168.10.20:502',
        komponenten: ['c0000000-0000-4000-8000-0000000000a5', 'c0000000-0000-4000-8000-0000000000a6'],
      };
      expect(cloud.dqUebernahmen).toEqual([
        { anlage: FIXTURE_IDS.an1, vorschlaege: [gezeigt] },
        { anlage: FIXTURE_IDS.an1, vorschlaege: [gezeigt] },
      ]);
      await halle1.getByText('Ohne Datenquelle (2)').click();
      await expect(halle1.getByText(/^Netzanschlusszähler: /)).toBeVisible();
      await halle1.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'dq-uebernommen');

      // Quelle schon von Hand angelegt: „Zu DQ-4 hinzufügen“ hängt die Geräte an die vorhandene Quelle.
      await halle2.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'dq-schon-angelegt');
      await halle2.getByRole('button', { name: 'Zu DQ-4 hinzufügen', exact: true }).click();
      await expect(halle2.getByText('Die Geräte gehören jetzt zu DQ-4.')).toBeVisible();
      expect(cloud.dqUebernahmen?.at(-1)).toEqual({
        anlage: FIXTURE_IDS.an2,
        vorschlaege: [{ device_id: C1_IDS.boxHalle2, protokoll: 'modbus_tcp', adresse: '192.168.20.10:502',
          komponenten: ['c0000000-0000-4000-8000-0000000000c1'], datenquelle_id: 'd0000000-0000-4000-8000-000000000004' }],
      });
      await halle2.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'dq-hinzugefuegt');
    });

    test('ohne Standort legt Schritt 1 ihn im Standort-Dialog aus AP-02 an', async ({ page }) => {
      await verdrahte(page, { standorte: { ...ahrenbergHeute(), standorte: [] }, funktionen: ahrenbergFunktionen({ standorte: [] }) });
      await oeffne(page, breite);
      await schritt1(page);
      await expect(page.getByText('Es gibt noch keinen Standort. Legen Sie ihn zuerst an.')).toBeVisible();
      await page.getByRole('button', { name: 'Neuen Standort anlegen', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Standort anlegen' })).toBeVisible();
      await messeUndFotografiere(page, breite, 'standort-anlegen');
    });

    test('Schritt 3 schlägt den Baukasten-Zähler MIT Angabe vor, den ohne lässt er aus (Schnitt 2)', async ({ page }) => {
      // Zeilen wie PortalwegMesskundeAbnahmeTest sie vom Server bekommt: der eigene Messwert mit
      // „Energie-Zählerstand – Bezug“ trägt eine Messstelle, der ohne Angabe ist keine_messgroesse.
      const basis = vorschlagHalle2();
      const zeile = basis.vorschlaege[0];
      const vorschlag: MessstelleVorschlagsliste = {
        ...basis,
        vorschlaege: [{
          ...zeile, kennzeichen: 'MS-0001', name: 'Zähler Druckluft', komponente_name: 'Zähler Druckluft',
          stellung: null, unterzaehler_von: null, nebengroessen: [], hinweise: [],
          hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
          quelle: { kanal: 'custom.ea22355295944f859ec7f555c883134c', anzeigename: 'Zählerstand Bezug',
            kanal_wertart: 'counter', herleitung: 'zaehlerstand' },
        }],
        ausgelassen: [{
          anlage: zeile.anlage, komponente: 'c0000000-0000-4000-8000-0000000000a6', komponente_name: 'Zähler Spritzguss',
          kanal: 'custom.9c3d25820f31463babfdacbe74549f51', grund: 'keine_messgroesse', zu: null,
          text: '„Zähler Spritzguss“ misst keine Größe, die eine Messstelle trägt.',
        }],
      };
      const wartet = registerNachUebernahme({ wartet: ['MS-0003'] });
      await verdrahte(page, {
        standorte: ahrenbergHeute(),
        funktionen: ahrenbergFunktionen({ standorte: [ahrenbergMessen(wartet), funktionWerkLindach('bestand')] }),
        vorschlag,
        register: wartet,
      });
      await oeffne(page, breite, `?standort=${FIXTURE_IDS.st1}`);
      await schritt2(page);
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Was bedeutet jeder Messkanal?' })).toBeVisible();
      await expect(page.getByText('1 von 1 Vorschlag gewählt')).toBeVisible();
      await expect(page.locator('.vp-ma-vorschlag')).toHaveCount(1);
      await expect(page.locator('.vp-ma-vorschlag').first()).toContainText('Zähler Druckluft');
      await page.getByText('Nicht vorgeschlagen (1)').click();
      await expect(page.getByText('„Zähler Spritzguss“ misst keine Größe, die eine Messstelle trägt.')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt3-baukasten');
    });

    test('Schritt 3 → 4 → 5 für Halle 2 (WAGO C-1): vier Vorschläge, Hauptzähler-Regel, Prüfliste aus Fakten, Fertig', async ({ page }) => {
      const wartet = registerNachUebernahme({ wartet: ['MS-0003'] });
      const cloud: Cloud = {
        standorte: ahrenbergHeute(),
        funktionen: ahrenbergFunktionen({ standorte: [ahrenbergMessen(wartet), funktionWerkLindach('bestand')] }),
        vorschlag: vorschlagHalle2(),
        register: wartet,
      };
      await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${FIXTURE_IDS.st1}`);
      await schritt2(page);
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();

      // 3 · Messstellen: die Liste des Servers für C-1.
      await expect(page.getByRole('heading', { name: 'Was bedeutet jeder Messkanal?' })).toBeVisible();
      await zaehlerIst(page, breite, 3, 'Messstellen');
      await expect(page.getByText('4 von 4 Vorschlägen gewählt')).toBeVisible();
      const karten = page.locator('.vp-ma-vorschlag');
      await expect(karten).toHaveCount(4);
      await expect(karten.nth(0)).toContainText('MS-0001');
      await expect(karten.nth(0)).toContainText('Hauptzähler');
      await expect(karten.nth(3)).toContainText('Unterzähler von MS-0001');
      await messeUndFotografiere(page, breite, 'schritt3');

      // Umbenannt nach der Referenzdatei, MS-0001 ins Gebäude Halle 2.
      for (const [i, k] of ENERGIEKARTEN.entries()) await karten.nth(i).getByLabel('Name').fill(k.messstelleName);
      const ort = karten.nth(0).getByRole('combobox', { name: 'Ort' });
      await ort.click();
      const ortId = await ort.getAttribute('id');
      await page.locator(`[id="${ortId}-liste"]`).getByRole('option', { name: /^Halle 2\s*Gebäude/ }).click();
      await expect(ort).toContainText('Halle 2');

      // Hauptzähler-Regel: ohne MS-0001 geht keiner seiner Unterzähler.
      await karten.nth(0).getByRole('checkbox').uncheck();
      await expect(page.getByText(/übernehmen Sie diesen Hauptzähler mit\.$/)).toHaveCount(3);
      await messeUndFotografiere(page, breite, 'schritt3-regel');
      await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('ist als Unterzähler von MS-0001 vorgeschlagen');
      expect(cloud.uebernahmen ?? []).toHaveLength(0);
      await karten.nth(0).getByRole('checkbox').check();

      await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ist alles da?' })).toBeVisible();
      expect(cloud.uebernahmen?.[0].vorschlaege.map((b) => b.name)).toEqual(ENERGIEKARTEN.map((k) => k.messstelleName));
      expect(cloud.orte).toEqual([{ messstelle: 'ms-ms-0001', anfrage: { kennzeichen: 'G-2', gueltig_ab: '2026-10-01', korrektur: true } }]);

      // 4 · Prüfen: EK-3 meldet noch nichts — kein „Weiter".
      await zaehlerIst(page, breite, 4, 'Prüfen');
      await expect(page.getByText('MS-0003 Montage Linie M1: Wartet auf erste Daten · Zähler Energiekarte EK-3 (Montage M1)')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'schritt4-offen');

      const alle = registerNachUebernahme();
      cloud.register = alle;
      cloud.funktionen = ahrenbergFunktionen({ standorte: [ahrenbergMessen(alle), funktionWerkLindach('bestand')] });
      await page.getByRole('button', { name: 'Erneut prüfen', exact: true }).click();
      await expect(page.getByText('5 von 5 Messstellen liefern Daten')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt4-erfuellt');

      // 5 · Fertig: kein Start-Knopf, der Entwurf ist gelöscht.
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Messen & Auswerten ist für Werk Ahrenberg eingerichtet und aktiv.' })).toBeVisible();
      await zaehlerIst(page, breite, 5, 'Fertig');
      await messeUndFotografiere(page, breite, 'schritt5');
      expect(await page.evaluate(() => localStorage.getItem('vp.uems.messen-assistent.entwurf.v1'))).toBeNull();
      await page.getByRole('button', { name: 'Fertig', exact: true }).click();
      await expect(page.getByTestId('assistent-geschlossen')).toBeVisible();
    });
  });
}
