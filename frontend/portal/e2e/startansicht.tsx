import { netzanschlussBuehne } from './netzanschluss-buehne';
import { StandortNetzanschluessePage } from '../src/pages/StandortNetzanschluessePage';
import App from '../src/App';
import { darf, RechteStandort, teilansichtKopf } from '../src/rollen';
import { rollenMoment } from './rollen-fixture';
import { sichtbareListe } from '../src/test/rollenFixtures';
import { C1_IDS, geraeteAhrenberg } from '../src/test/messenAssistentFixtures';
import './rollen-fixture';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  api,
  type FunktionStandort,
  type AnlageUmzug,
  type BezugsdatenZuordnung,
  type MessstellenRegisterAnfrage,
  type MessstelleWerte,
  type MessstelleWerteRaster,
  type Overview,
  type OverviewSite,
  type Site,
  type StandortAusfall,
  type UemsDatenquelle,
} from '../src/api';
import { keycloak } from '../src/auth';
import { showAddAnlageButton } from '../src/addAnlage';
import { ohneGeld } from '../src/anlageGeld';
import {
  activeAreaKey,
  anlageSidebar,
  ebenenAktiv,
  ebenenBereiche,
  ebenenLeiste,
  ebenenOrt,
  ebenenReiter,
  ebenenTitel,
  type EbenenLesemodell,
  type EbenenSeiten,
  standortEinstiege,
  standortBereichFuer,
} from '../src/ebenenNav';
import { anlagenOptionen } from '../src/anlagenWahl';
import {
  canonicalShellRoute,
  flottenLandung,
  kopfPfad,
  orteAus,
  pfadWert,
  pfadZeile,
  showOverviewNav,
  showPortfolioNav,
  startEbene,
  type PfadGlied,
  type ShellInput,
} from '../src/betriebsart';
import { EbenenTabs } from '../src/components/EbenenTabs';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { consumersApi } from '../src/consumers/consumersApi';
import { healthBadge } from '../src/health';
import {
  anlageRoute,
  berichtRoute,
  hashForRoute,
  kennzahlRoute,
  messstelleRoute,
  pageRoute,
  standortBereichRoute,
  standortMessstellenRoute,
  standortRoute,
  type PageId,
  type Route,
} from '../src/nav';
import {
  ApiError,
  type Kennzahl,
  type KennzahlAnfrage,
  type KennzahlEingang,
  type KennzahlFassung,
  type KennzahlPeriodeArt,
  type KennzahlWerte,
} from '../src/api';
import { iso } from '../src/bezugsPeriode';
import { ABLEHNUNG_SATZ, fassungEintrag, naechsteNummer, wirksame } from '../src/kennzahlAendern';
import { AnlagenPage } from '../src/pages/AnlagenPage';
import { BerichtePage } from '../src/pages/BerichtePage';
import { BezugsgroessenPage } from '../src/pages/BezugsgroessenPage';
import type { BezugsgroesseAnfrage } from '../src/api';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { MessstellenPage } from '../src/pages/MessstellenPage';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { ahrenbergDatenquellen, ahrenbergUemsGeraete } from '../src/test/datenquellenFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { quellenDerMessstellenBuehne } from '../src/test/messstelleQuellenFixtures';
import { ahrenbergKostenstelleEnergie, ahrenbergMessstelleProzesse, ahrenbergProzessSummeWerte } from '../src/test/kostenstellenFixtures';
import {
  kostenstellenAhrenberg,
  ms06,
  ms10,
  MS_IDS,
  ohneVerteilung,
  protokollMs06,
  protokollMs10,
  prozesseAhrenberg,
} from '../src/test/messstelleSeiteFixtures';
import { f16Monat, f16Tage, f8Viertelstunden, MS_06, MS_10 } from '../src/test/werteKarteFixtures';
import { f21Historie, f21Stunden, f21Tag, f21TagWert } from '../src/test/wertVersionenFixtures';
import { monatKarte, monatOhneQuelle, monatTage, MS_11 } from '../src/test/vergleichFixtures';
import { mitEnergiebilanz } from '../src/anlageEnergiebilanz';
import { ahrenbergBilanz } from '../src/test/bilanzFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach, ortsbaumLindachOhneGebaeude } from '../src/test/ortsbaumFixtures';
import { StandortUebersichtPage } from '../src/pages/StandortUebersichtPage';
import { StandortAnlagenPage } from '../src/pages/StandortAnlagenPage';
import { StandortGebaeudePage } from '../src/pages/StandortGebaeudePage';
import { StandortePage } from '../src/pages/StandortePage';
import { StandortBoxenPage } from '../src/pages/StandortBoxenPage';
import { AppShell } from '../src/shell/AppShell';
import { anlageSurface } from '../src/surface';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from '../src/test/standorteFixtures';
import { versorgungAhrenberg, versorgungLindach } from '../src/test/versorgungFixtures';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from '../src/test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
import {
  ahrenbergBezugsgroessen,
  ahrenbergKostenstellen,
  ahrenbergProzesse,
  angelegteKennzahl,
  kennzahlVorschauAntwort,
  naechstesKennzeichen,
} from '../src/test/kennzahlAnlegenFixtures';
import {
  fassungenVon,
  kennzahlenDerWelt,
  kennzahlWerteAntwort,
  kennzahlWertVersionenAntwort,
} from '../src/test/kennzahlWerteFixtures';
import {
  anlegenAm,
  detailAm,
  entwurfAm,
  freigabeAm,
  heutigeWerteAm,
  mitVerworfen,
  nameHeuteAm,
  standAm,
  vergleichAm,
  type Verworfen,
} from '../src/test/berichtFixtures';
import { fassungenK17, k17Stand, k17VorschauAntwort, k17WerteAntwort, KZ4_ID, kz0004, mitMs24 } from '../src/test/kennzahlAendernFixtures';
import type { UebersichtEbene } from '../src/uebersicht';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * E2E-Bühne „Startansicht" (UEMS AP-01 IP-5): die ECHTE Schale mit dem ECHTEN
 * Pfad und den ECHTEN Seiten der Flotten-Ebene, entschieden von denselben reinen
 * Funktionen, die `App.tsx` ruft (`startEbene` → `canonicalShellRoute` →
 * `kopfPfad`). Die Cloud ist in der Bühne gestellt, nicht verdrahtet.
 *
 * Alle Namen und Werte aus dem Referenzunternehmen Ahrenberg
 * (`docs/contracts/v2/uems-referenzunternehmen.json`, Momentaufnahme 20.10.2026
 * 10:15): Netzbezug Halle 1 312,4 kW, PV 168,2 kW, Speicher 62 %; Halle 2
 * 96,5 kW; Werk Lindach 38,7 kW. Was die Datei nicht trägt (Verbrauch, Geld),
 * bleibt leer — nie eine erfundene Zahl.
 *
 * `?bild=einzel|standort|unternehmen|messkunde|korrektur` — die drei Startbilder plus
 * Peter Hollerbach (nur Werk Lindach, AP-03-Teilansicht); `&ansicht=anlage`
 * öffnet Halle 1, `&ansicht=werk` die Standort-Übersicht Werk Ahrenberg,
 * `&ansicht=lindach` die Standort-Übersicht Werk Lindach. `&messen=bestand`
 * zeigt „Messen & Auswerten" wie nach dem Umstieg (A11: noch nicht eingerichtet).
 *
 * AP-01 IP-8: `&ansicht=steuerung-halle2` / `&ansicht=steuerung-lindach` öffnen
 * die ECHTE Steuerungsseite der zwei Anlagen, die nur messen (Halle 2 mit dem
 * Ladepunkt K-9, Werk Lindach ohne steuerbare Komponente); `bild=vor-lindach`
 * ist Ahrenberg mit angelegtem Werk Lindach, aber noch ohne Anlage AN-3.
 */

const { an1, an2, an3, st2 } = FIXTURE_IDS;
const STAND = '2026-10-20T08:15:00Z';
const params = new URLSearchParams(location.search);
const bild = params.get('bild') ?? 'einzel';
const ansicht = params.get('ansicht');
const AUSFALL = params.get('ausfall') === '1';
const KORREKTUR = bild === 'korrektur';
const messenArt = params.get('messen') === 'bestand' ? 'bestand' : 'eingerichtet';
/**
 * AP-01 E5 = A (Einstieg Messen-Assistent): `&messen=entwurf` stellt „Messen & Auswerten“ an jedem Standort in den
 * Entwurf (Wiedereinstieg), `&zuordnung=offen` lässt die Werte-Route „nicht_zugeordnet“ sagen (Satz „Daten kommen
 * an“). Ohne diese Parameter bleibt die Bühne zeichengleich.
 */
const MESSEN_ENTWURF = params.get('messen') === 'entwurf';
const ZUORDNUNG_OFFEN = params.get('zuordnung') === 'offen';
/**
 * AP-13 IP-9: `&ansicht=kostenstellen` / `&ansicht=prozesse` öffnen „Unternehmen › Messstellen“ im Reiter (die Adresse
 * trägt `?reiter=`, dazu `&periode=&am=` aus der Bühnen-Adresse); die Kostenstellen tragen dort ihre echte Gültigkeit
 * (9000 bis 31.12.2026, 9010/9020 ab 01.01.2027 — die Kennzahl-Bühne behält ihre sieben). `&organisation=leer`: keine
 * Kostenstelle, kein Prozess — die Welt ohne Reiter (Bestand).
 */
const ORGANISATION_REITER = ansicht === 'kostenstellen' || ansicht === 'prozesse';
const ORGANISATION_LEER = params.get('organisation') === 'leer';
if (ORGANISATION_REITER) {
  const zeit = params.get('periode') && params.get('am') ? `&periode=${params.get('periode')}&am=${params.get('am')}` : '';
  window.history.replaceState(null, '', `#/portfolio/messstellen?reiter=${ansicht}${zeit}`);
}
/**
 * AP-13 IP-8: `&ansicht=bilanz&an=AN-2` öffnet Anlage › Verlauf › Energiebilanz (Vorgabe AN-2); `&bilanz=ohne-hz`
 * antwortet ohne Hauptzähler (Leerzustand, kein Reiter), `&rest=vorschlag` ohne Rest-Messstelle (Vorschlag „Rest
 * anlegen“ — der Klick legt sie in der Bühne an, `window.__restAnlegen` zählt ihn), `&live=veraltet` lässt MS-14 veralten
 * (O8). Die Werte gelten zur Uhr der Bühne (`page.clock`); die Momentaufnahme O8 steht eine Minute vor ihr.
 */
const ANLAGE_KZ: Record<string, string> = { 'AN-1': an1, 'AN-2': an2, 'AN-3': an3 };
const bilanzAn = ANLAGE_KZ[params.get('an') ?? ''] ?? an2;
let restVorschlag = params.get('rest') === 'vorschlag';
const restAnlegenAufrufe: unknown[] = [];
(window as unknown as Record<string, unknown>).__restAnlegen = restAnlegenAufrufe;
const bilanzDerBuehne = (siteId: string, periode?: 'tag' | 'monat' | 'jahr', am?: string) =>
  ahrenbergBilanz(siteId, periode, am, {
    jetzt: Date.now(),
    live: params.get('live') === 'veraltet' ? 'veraltet' : 'frisch',
    ohneHauptzaehler: messenArt === 'bestand' || params.get('bilanz') === 'ohne-hz',
    restVorschlag,
  });

/**
 * AP-13 IP-13 (E14, M1–M4): die Stationen des GEMESSENEN Wegs — Ebene → Welt → Zahl → Nachweis in EINEM Lauf.
 *
 * `&ansicht=werte&ms=MS-10&tag=2026-11-03` öffnet die Messstellen-Seite im Abschnitt „Werte“ für diesen Tag (F21 —
 * die Zahl, die drei Versionen hat, also den Nachweis trägt); `&ansicht=verlauf` denselben Abschnitt im Monat (der
 * Verlauf in Tagen), `&ansicht=vergleich` dazu den Umschalter (`&v=vorperiode`, O11). `&mon=` wählt den Monat,
 * `&version=` die Fassung der Karte.
 *
 * `&stand=2026-11-21` ist der Stichtag, den das Register als „heute“ ausgibt; ohne Angabe bleibt es auf seinem
 * eigenen Stand (20.10.2026). Er entscheidet, wohin der Einstieg „Werte“ des Registers führt: auf den Vortag, oder —
 * sobald „Stand am …“ einen früheren Tag zeigt — auf diesen Stichtag selbst (AP-13 IP-3). So erreicht der Weg den
 * 03.11.2026, ohne sich durch die Zeit-Leiste zu blättern.
 */
const WEG_ANSICHT = ansicht === 'werte' || ansicht === 'verlauf' || ansicht === 'vergleich';
const WEG_MS = params.get('ms') ?? 'MS-10';
/** Vorgabe: der Tag des Box-Ausfalls für `werte`, sonst der Monat, in dem er liegt. */
const WEG_PERIODE = params.get('tag') ?? params.get('mon') ?? (ansicht === 'werte' ? '2026-11-03' : '2026-11');
const WEG_VERSION = /^[1-9]\d{0,5}$/.test(params.get('version') ?? '') ? Number(params.get('version')) : null;
const WEG_V = params.get('v') ?? (ansicht === 'vergleich' ? 'vorperiode' : null);
const REGISTER_STAND = params.get('stand');
/**
 * Nur im Weg-Bild antwortet die Werte-Route der Bühne. In jedem anderen Bild fragt allein der Bericht-Nachweis
 * nach einem Wert („heutigen Wert zeigen“, AP-12 IP-13) — der bekommt weiter seine eigene Antwort.
 */
const WEG_BUEHNE = WEG_ANSICHT || REGISTER_STAND !== null;
/** Die Zeile des Registers, die `&ms=` meint — die Seite lebt unter der ID des Registers, nicht unter dem Kennzeichen. */
const wegMessstelleId = () =>
  ahrenbergRegister({ stichtag: REGISTER_STAND ?? undefined }).register.find((z) => z.kennzeichen === WEG_MS)?.id ?? MS_IDS.ms10;

/**
 * Die Werte-Route der Bühne. Gestellt ist nur, was der Weg braucht — alles andere antwortet 404, damit eine
 * stillschweigend falsche Zahl gar nicht erst entstehen kann. Jede Zahl steht in den Referenzfällen
 * (`oberflaechenFaelle.json` über die Fixtures): MS-10 am 03.11.2026 ist F21 (Karte je Version, Stunden als Liste),
 * seine VIERTELSTUNDEN sind die gemessenen des Box-Ausfalls (F8/O1 — die Referenzdatei trägt keine ersetzten
 * Viertelstunden); die Monate sind O11 (MS-10 November 35 800 gegen Oktober 36 900) und die zweite passende Reihe
 * MS-11 (22 400 · 21 500); MS-06 trägt den Oktober F16.
 */
function werteDerBuehne(
  kennzeichen: string,
  raster: MessstelleWerteRaster,
  von: string,
  bis: string,
  version?: number | null,
): MessstelleWerte | null {
  if (kennzeichen === 'MS-10' && von === '2026-11-03' && bis === von) {
    if (raster === 'tag') {
      const v = version ?? 3;
      return v === 1 || v === 2 || v === 3 ? { ...f21Tag(), version: version ?? null, werte: [f21TagWert(v)] } : null;
    }
    if (raster === 'stunde') return f21Stunden();
    if (raster === 'viertelstunde') return f8Viertelstunden();
    return null;
  }
  if (kennzeichen === 'MS-06' && von === '2026-10-01' && bis === '2026-10-31') {
    return raster === 'monat' ? f16Monat() : raster === 'tag' ? f16Tage() : null;
  }
  return monatDerBuehne(kennzeichen, raster, von, bis);
}

/** Die Monate, die Karte, Verlauf und Vergleich lesen (O11/O12) — `null` heißt „nicht gestellt“. */
function monatDerBuehne(kennzeichen: string, raster: MessstelleWerteRaster, von: string, bis: string): MessstelleWerte | null {
  const mengen: Record<string, Record<string, number>> = {
    'MS-10': { '2026-11': 35800, '2026-10': 36900 },
    'MS-11': { '2026-11': 21500, '2026-10': 22400 },
  };
  const messstelle = kennzeichen === 'MS-10' ? MS_10 : kennzeichen === 'MS-11' ? MS_11 : kennzeichen === 'MS-06' ? MS_06 : null;
  if (!messstelle) return null;
  const monat = von.slice(0, 7);
  if (von !== `${monat}-01` || bis.slice(0, 7) !== monat) return null;
  // Vor dem Beginn des Energiemanagements (01.10.2026) antwortet die Route ohne Bindung — nie mit einer 0.
  if (monat < '2026-10') return raster === 'monat' ? monatOhneQuelle(messstelle, monat) : null;
  const menge = mengen[kennzeichen]?.[monat];
  if (menge === undefined) return null;
  const wochenende = kennzeichen === 'MS-11' ? 0.3 : monat === '2026-10' ? 0.5 : 0.65;
  return raster === 'monat'
    ? monatKarte(messstelle, monat, menge)
    : raster === 'tag'
      ? monatTage(messstelle, monat, menge, wochenende)
      : null;
}
/**
 * AP-11 IP-13: `&ansicht=kennzahlen` öffnet „Unternehmen › Kennzahlen“, `&ansicht=kennzahl&kz=KZ-0001` eine
 * Kennzahl-Seite; `&ausserhalb=KZ-0003` lässt die Werte-Route für diese Kennzahl mit 404 antworten (R-A7). Die
 * Werte (K1, K7, K8, K10, K11 aus den Vektoren) gelten zur Uhr der Bühne (`page.clock`).
 */
const kennzahlId = (kennzeichen: string | null) =>
  [...kennzahlenDerWelt(), ...(k17Stand(params.get('welt')) ? [kz0004('vorher')] : [])].find((k) => k.kennzeichen === kennzeichen)?.id ?? null;
const kzOffen = kennzahlId(params.get('kz'));
const kzAusserhalb = kennzahlId(params.get('ausserhalb'));
/**
 * AP-11 IP-14: `&person=IK` meldet Ines Kaltenbach an (sie ist „Verantwortlich“ im Assistenten, §5.1), `&person=PH`
 * Peter Hollerbach; `&welt=leer` beginnt ohne Kennzahl (Neukunde). Was der Assistent anlegt, bleibt in der Bühne;
 * `window.__kennzahlAufrufe` zählt jede Vorschau und jedes Anlegen — der Nachweis „vor Anlegen nichts gespeichert“.
 */
const PERSONEN: Record<string, string> = { IK: 'Ines Kaltenbach', PH: 'Peter Hollerbach', CB: 'Claudia Berger', MD: 'Murat Demirci' };
const person = PERSONEN[params.get('person') ?? ''] ?? null;
const weltLeer = params.get('welt') === 'leer';
/**
 * AP-12 IP-14: `&berichte=leer` beginnt ohne Bericht — „Bericht anlegen“ legt BR-2026-0001 an; `&person=CB` ist Claudia
 * Berger (Leser, B13). Anlegen, Freigeben und Verwerfen ändern die Bühne; `window.__berichtAufrufe` zählt sie.
 */
let berichtDa = params.get('berichte') !== 'leer';
let verworfen: Verworfen | null = null;
const berichtAufrufe = { anlegen: [] as unknown[], freigeben: [] as string[], verwerfen: [] as string[] };
(window as unknown as Record<string, unknown>).__berichtAufrufe = berichtAufrufe;
const angelegt: Kennzahl[] = [];
// AP-11 IP-15: `&frisch=1` beginnt mit einer eben angelegten Kennzahl OHNE einen Wert (KZ-0009, MS-12 je BZ-6) — die
// Bühne fürs Löschen; sie hat noch keine Fassung in der Bühne, also auch kein „Berechnung ändern“.
if (params.get('frisch') === '1') {
  const bz6 = ahrenbergBezugsgroessen().bezugsgroessen.find((b) => b.kennzeichen === 'BZ-6')!;
  const frisch: KennzahlAnfrage = {
    kennzeichen: null,
    name: 'Stromeinsatz je Stück — Halle 2',
    rechenform: 'quotient',
    geltung_art: 'gebaeude',
    geltung_id: bz6.geltung_id,
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: null,
    periode_art: null,
    komplement: null,
    eingaenge: [
      { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-12' },
      { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-6' },
    ],
  };
  angelegt.push(angelegteKennzahl(frisch, 'KZ-0009', 'Halle 2', Date.now(), 'Ines Kaltenbach'));
}
/**
 * AP-11 IP-15: `&welt=k17` stellt KZ-0004 „Stromeinsatz Spritzguss je kg“ mit Fassung 1 dazu (und MS-24 ins Register) —
 * die Bühne für „Berechnung ändern ab …“; `&welt=k17-fassung2` den Stand nach dem Eintrag vom 20.03.2027 (K17). Was
 * Ändern, Stammdaten, Archivieren und Löschen tun, bleibt in der Bühne; `__kennzahlAufrufe` zählt auch diese vier Wege.
 */
const k17 = k17Stand(params.get('welt'));
const buehnenStand = new Map<string, Kennzahl>();
const buehnenFassungen = new Map<string, KennzahlFassung[]>();
const geloescht = new Set<string>();
const kennzahlAufrufe = {
  vorschau: [] as KennzahlAnfrage[],
  anlegen: [] as KennzahlAnfrage[],
  fassung: [] as unknown[],
  stammdaten: [] as unknown[],
  archivieren: [] as string[],
  loeschen: [] as string[],
};
(window as unknown as Record<string, unknown>).__kennzahlAufrufe = kennzahlAufrufe;
const kennzahlenDerBuehne = (): Kennzahl[] =>
  [...(weltLeer ? [] : kennzahlenDerWelt()), ...(k17 ? [kz0004(k17)] : []), ...angelegt]
    .filter((k) => !geloescht.has(k.id))
    .map((k) => buehnenStand.get(k.id) ?? k);
const istAngelegt = (id: string) => angelegt.some((k) => k.id === id);
const fassungenDerBuehne = (id: string): KennzahlFassung[] =>
  buehnenFassungen.get(id) ?? (istAngelegt(id) ? [] : k17 && id === KZ4_ID ? fassungenK17(k17) : fassungenVon(id));
const kennzahlDerBuehne = (id: string): Kennzahl => {
  const k = kennzahlenDerBuehne().find((x) => x.id === id);
  if (!k) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
  return k;
};
const eingangMitName = (e: KennzahlEingang): KennzahlFassung['eingaenge'][number] => {
  const register = k17 ? mitMs24(ahrenbergRegister()) : ahrenbergRegister();
  const o =
    e.art === 'messstelle'
      ? register.register.find((z) => z.kennzeichen === e.kennzeichen)
      : e.art === 'bezugsgroesse'
        ? ahrenbergBezugsgroessen().bezugsgroessen.find((b) => b.kennzeichen === e.kennzeichen)
        : kennzahlenDerBuehne().find((k) => k.kennzeichen === e.kennzeichen);
  return { ...e, id: o?.id ?? e.kennzeichen, name: o?.name ?? null };
};
const ohneWerte = (id: string, periode: KennzahlPeriodeArt, von: string, bis: string): KennzahlWerte => {
  const k = angelegt.find((x) => x.id === id)!;
  const kopf = { id: k.id, kennzeichen: k.kennzeichen, name: k.name, rechenform: k.rechenform, einheit: k.einheit, einheit_anzeige: k.einheit_anzeige };
  return { kennzahl: kopf, periode, von, bis, zeitzone: 'Europe/Berlin', version: null, werte: [] };
};
const geltungName = (art: string, id: string): string | null => {
  if (art === 'unternehmen') return ahrenbergUnternehmen().name;
  for (const baum of [ortsbaumAhrenberg(), ortsbaumLindach()]) {
    if (baum.standort.id === id) return baum.standort.name;
    for (const g of baum.gebaeude) {
      if (g.id === id) return g.name;
      const b = g.bereiche.find((x) => x.id === id);
      if (b) return b.name;
    }
  }
  return (
    [...ahrenbergProzesse(), ...ahrenbergKostenstellen()].find((x) => x.id === id)?.name ??
    ahrenbergRegister().register.find((z) => z.id === id)?.name ??
    null
  );
};
/**
 * AP-12 IP-13: `&ansicht=berichte` öffnet „Unternehmen › Berichte“, `&ansicht=bericht&br=BR-2026-0001` die
 * Berichtsseite. Die Antworten folgen der Zeitachse des Referenzunternehmens zur Uhr der Bühne (`page.clock`,
 * `src/test/berichtFixtures.ts`); `&heute=b10` nennt im Register die Umbenennung von MS-12 ab 01.12.2026 (B10).
 */
const heuteB10 = params.get('heute') === 'b10';
const tagesverlaufGefuellt = params.get('tagesverlauf') === 'gefuellt';

/** Nur die E2E-Bühne ergänzt echte gespeicherte Tageszeilen; die Vektor-Abzüge selbst bleiben byte-gleich. */
const mitTagesverlauf = <T extends { abzug: Record<string, unknown> }>(antwort: T): T => {
  if (!tagesverlaufGefuellt) return antwort;
  const aus = structuredClone(antwort) as T;
  const abzug = aus.abzug as { tagesverlauf?: Array<{ quelle: string; menge_art?: string; tage: unknown[] }> };
  const tage = [
    { tag: '2026-10-01', menge: 196, zustand: 'vollständig' },
    { tag: '2026-10-02', menge: 204, zustand: 'vollständig' },
    { tag: '2026-10-03', menge: null, zustand: 'keine Werte' },
    { tag: '2026-10-04', menge: 188, zustand: 'mit Ersatzwert' },
    { tag: '2026-10-05', menge: 211, zustand: 'vollständig' },
  ];
  const ms12 = abzug.tagesverlauf?.find((r) => r.quelle === 'MS-12' && r.menge_art === undefined);
  if (ms12) ms12.tage = tage;
  return aus;
};
/**
 * AP-01 IP-7: `&seiten=kuenftig` stellt das Bild, sobald JEDER Bereich der Ebene
 * eine Seite hat (AP-04 IP-5, AP-13) — nur für die Vorschau; die Kacheln führen
 * in der Bühne auf die Übersicht der Ebene. Ohne den Schalter gilt der heutige
 * Stand (`EBENEN_SEITEN`).
 */
const KUENFTIG = params.get('seiten') === 'kuenftig';
const ALLE_SEITEN_KUENFTIG: EbenenSeiten = (ort) => {
  const hier = ort.art === 'unternehmen' ? pageRoute('portfolio') : standortRoute(ort.standortId);
  return {
    uebersicht: hier,
    standorte: pageRoute('portfolio-standorte'),
    netzanschluesse: hier,
    gebaeude: hier,
    anlagen: hier,
    messstellen: hier,
    bezugsgroessen: hier,
    kennzahlen: hier,
    berichte: hier,
  };
};

Object.assign(keycloak, {
  token: 'e2e-token',
  authenticated: true,
  updateToken: async () => false,
  tokenParsed: { name: person ?? 'Jonas Wendlinger', email: person ? undefined : 'jonas.wendlinger@example.test', realm_access: { roles: ['operator'] } },
});

const halle1 = { id: an1, name: 'Werk Ahrenberg – Halle 1', biddingZone: 'DE-LU' };
const halle2 = { id: an2, name: 'Werk Ahrenberg – Halle 2', biddingZone: 'DE-LU' };
const lindach = { id: an3, name: 'Werk Lindach', biddingZone: 'DE-LU' };

function zeile(
  site: { id: string; name: string },
  live: Partial<OverviewSite['live']>,
  roleCounts: OverviewSite['roleCounts'],
): OverviewSite {
  return {
    id: site.id,
    name: site.name,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: null,
    lastSeenAt: STAND,
    live: { ts: STAND, pvKw: null, loadKw: null, gridKw: null, socPct: null, ...live },
    plannedSavingsTodayEur: null,
    roleCounts,
  } as OverviewSite;
}

const ZEILEN: Record<string, OverviewSite> = {
  [an1]: zeile(halle1, { gridKw: 312.4, pvKw: 168.2, socPct: 62 }, { pv: 1, storage: 1, consumer: 0, grid: 1 }),
  [an2]: zeile(halle2, { gridKw: 96.5 }, { pv: 0, storage: 0, consumer: 1, grid: 1 }),
  [an3]: zeile(lindach, { gridKw: 38.7 }, { pv: 0, storage: 0, consumer: 0, grid: 1 }),
};

const SZENEN = {
  /** Ahrenberg bis 30.09.2026: der Standort aus der Bestandsübernahme, eine Anlage. */
  einzel: {
    sites: [halle1],
    liste: bestandEineAnlage(),
    unternehmen: ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, sitz: null }),
  },
  /** Ahrenberg 01.10.–14.10.2026: Werk Ahrenberg mit Halle 1 und Halle 2. */
  standort: {
    sites: [halle1, halle2],
    liste: { ...ahrenbergHeute(), standorte: [werkAhrenberg()] },
    unternehmen: ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 2 }),
  },
  /** Ahrenberg am 20.10.2026: zwei Standorte, drei Anlagen. */
  unternehmen: {
    sites: [halle1, halle2, lindach],
    liste: ahrenbergHeute(),
    unternehmen: ahrenbergUnternehmen(),
  },
  /** AP-14 IP-14: gestern Portfolio — drei Bestandsanlagen, noch ohne Standort. */
  'bestand-mehrere': {
    sites: [halle1, halle2, lindach],
    liste: {
      stichtag: '2026-10-20',
      standorte: [],
      nichtGezeigt: [],
      nochNichtZugeordnet: {
        anlagenZahl: 3,
        anlagen: [halle1, halle2, lindach].map((a) => ({ id: a.id, name: a.name })),
      },
    },
    unternehmen: ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 3, sitz: null }),
  },
  /** Peter Hollerbach am 20.10.2026: Zugriff nur auf Werk Lindach — der reine Messkunde (A13). */
  messkunde: {
    sites: [lindach],
    liste: { ...ahrenbergHeute(), standorte: [werkLindach()] },
    unternehmen: ahrenbergUnternehmen(),
  },
  /** AP-14 IP-15/U7a: AN-3 wurde seit ihrem ersten Tag dem falschen, sonst leeren Standort zugeordnet. */
  korrektur: {
    sites: [lindach],
    liste: {
      ...ahrenbergHeute(),
      stichtag: '2026-11-20',
      standorte: [
        werkAhrenberg({
          name: 'Werk Irrtum',
          kurzzeichen: 'ST-1',
          anlagen: [{ id: an3, name: lindach.name, gueltigAb: '2026-10-15', gueltigBis: null }],
          anlagenZahl: 1,
          gebaeudeZahl: 0,
          bereichZahl: 0,
        }),
        werkLindach({ anlagen: [], anlagenZahl: 0, gebaeudeZahl: 0, bereichZahl: 0 }),
      ],
      nochNichtZugeordnet: null,
    },
    unternehmen: ahrenbergUnternehmen({ anlagenZahl: 1, standortZahl: 2 }),
  },
  /** IP-8: Werk Lindach ist angelegt, AN-3 noch nicht — der Leerzustand der Standort-Übersicht. */
  'vor-lindach': {
    sites: [halle1, halle2],
    liste: { ...ahrenbergHeute(), standorte: [werkAhrenberg(), werkLindach({ anlagen: [], anlagenZahl: 0 })] },
    unternehmen: ahrenbergUnternehmen({ anlagenZahl: 2 }),
  },
};

const szene = SZENEN[bild as keyof typeof SZENEN] ?? SZENEN.einzel;
/**
 * AP-13 IP-2: `&orte=leer` — Werk Lindach ohne Gebäude und Bereiche (Z4): der Ortsbaum zeigt L1 aus AP-02, und
 * „Gebäude“ ist kein Bereich (keine Kachel, kein Reiter); die Adresse `…/gebaeude` gilt trotzdem.
 */
const ORTE_LEER = params.get('orte') === 'leer';
if (ORTE_LEER) {
  const liste = szene.liste as { standorte: { id: string; gebaeudeZahl: number | null }[] };
  liste.standorte = liste.standorte.map((s) => (s.id === werkLindach().id ? { ...s, gebaeudeZahl: 0 } : s));
}
const rechteAnsicht = params.has('rechte');
if (rechteAnsicht) {
  szene.liste.standorte = szene.liste.standorte.filter(s => rollenMoment.standorte.some(r => r.id === s.id));
  const sichtbar = new Set(szene.liste.standorte.flatMap(s => s.anlagen.map(a => a.id)));
  szene.sites = szene.sites.filter(s => sichtbar.has(s.id));
}
const vorschauArt = params.get('vorschauart');
const sites = szene.sites.map((site) => vorschauArt ? {
  ...site,
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: vorschauArt === 'messkunde' ? 'ohne' : 'fest',
  tarifParamCtKwh: vorschauArt === 'messkunde' ? null : 31.4,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  leistungspreisEurKw: vorschauArt === 'steuerkunde' ? 120 : null,
} : site) as Site[];
const siteIds = sites.map((s) => s.id);
let standortVorschlagOffen = params.get('vorschlag') === 'offen';
const standortVorschlagU2 = params.get('vorschlagfall') === 'u2';
const standortVorschlag = {
  anlagenZahl: standortVorschlagU2 ? 3 : 2,
  gruppen: [
    { name: 'Werk Ahrenberg – Halle 1', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'aa020000-0000-4000-8000-000000000001', anlageId: an1, anlageName: 'Werk Ahrenberg – Halle 1', gueltigAb: '2026-09-12' }] },
    { name: 'Werk Ahrenberg – Halle 2', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'aa020000-0000-4000-8000-000000000002', anlageId: an2, anlageName: 'Werk Ahrenberg – Halle 2', gueltigAb: '2026-09-14' }] },
    ...(standortVorschlagU2 ? [{ name: 'Werk Lindach', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'aa020000-0000-4000-8000-000000000003', anlageId: an3, anlageName: 'Werk Lindach', gueltigAb: '2026-10-15' }] }] : []),
  ],
};
const standortVorschlagAnfragen: unknown[] = [];
Object.assign(window, { standortVorschlagAnfragen });

const korrekturUmzug = (): AnlageUmzug => ({
  anlageId: an3,
  anlageName: lindach.name,
  bisher: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Irrtum' },
  neu: { id: st2, kurzzeichen: 'ST-2', name: 'Werk Lindach' },
  gueltigAb: '2026-10-15',
  gueltigBis: null,
  danach: null,
  rueckwirkung: { art: 'rueckwirkend' as const, tage: 36, abzeichen: 'rückwirkend (36 Tage)' },
  zuordnungen: [
    { standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Irrtum' }, gueltigAb: '2026-10-15', gueltigBis: null, zustand: 'aufgehoben' as const },
    { standort: { id: st2, kurzzeichen: 'ST-2', name: 'Werk Lindach' }, gueltigAb: '2026-10-15', gueltigBis: null, zustand: 'gueltig' as const },
  ],
  bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'fahrplaene', 'messstellen'],
  boxen: 1,
  netzanschluss: { id: 'na-3', kennzeichen: 'NA-3' },
  steuern: { funktion: 'steuern' as const, zustand: 'aktiv', standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Irrtum' } },
  befehle: 0,
  begruendung: null,
  protokoll: [],
});
let korrekturArchiviert = false;

// Die gestellte Cloud: nur, was die Flotten-Fläche liest.
const overview: Overview = {
  sites: siteIds.map((id) => vorschauArt
    ? {
        ...ZEILEN[id],
        roleCounts: vorschauArt === 'steuerkunde' && id === an1
          ? ZEILEN[id].roleCounts
          : { pv: 0, storage: 0, consumer: 1, grid: 1 },
        live: vorschauArt === 'steuerkunde'
          ? ZEILEN[id].live
          : { ...ZEILEN[id].live, pvKw: null, socPct: null },
        anwendungen: vorschauArt === 'steuerkunde' && id === an1
          ? ['monitoring', 'lastspitzenkappung']
          : ['monitoring'],
      }
    : ZEILEN[id]),
  totals: {
    sites: siteIds.length,
    devices: siteIds.length,
    online: siteIds.length,
    plannedSavingsTodayEur: null,
    liveSitesCovered: siteIds.length,
  },
  dailySavings: [],
};
const bzListe = params.get('bezugs') === 'leer' ? { bezugsgroessen: [], bezugsflaechen: [] } : ahrenbergBezugsgroessen();
const bzAufrufe = { anlegen: [] as BezugsgroesseAnfrage[], archivieren: [] as string[], vorschau: [] as string[], importe: [] as string[], vorlagen: [] as string[], ruecknahmen: [] as string[] };
const importZuordnung: BezugsdatenZuordnung = { csv: null, spalten: { periode: 1, bis: null, wert: 3, einheit: 4, bezug: 2, bemerkung: null }, deutung: 'periode', zahlformat: 'auto', einheit: null, bezugsgroesse: null, bezug_tabelle: { 'Spritzguss gesamt': 'BZ-1', 'Spritzguss Export': 'BZ-1', Montage: 'BZ-2' }, synonyme: {} };
const importVorlagen = [{ vorlage_id: 'c0de0000-0000-4000-8000-00000000f001', fassung: 1, name: 'ERP-Export Spritzguss', zuordnung: importZuordnung, urheber: { name: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'konto' }, erstellt_am: '2026-10-01T09:00:00+02:00' }];
const importVorschau = () => {
  const basis: any = ({
  vorschau: { kennung: 'VS1.1792484000.0123456789abcdef0123456789abcdef', status: 'vorschau' as const, ausgestellt_am: '2026-10-20T12:00:00+02:00', gueltig_bis: '2026-10-20T12:30:00+02:00', ergebnis_fingerabdruck: 'abcdef' },
  vorlage: null, datei: { name: 'produktion-oktober.csv', bytes: 155, sha256: '012345', befund: null, zusatz: null, zusatz_satz: null, zeile: null, kodierung: 'utf-8', bom: false, trennzeichen: ';', kopfzeile: true, kopf: ['Periode', 'Artikelgruppe', 'Menge', 'Einheit'], spalten: 4, datenzeilen: 3 }, frueherer_import: null,
  zeilen: [
    { nr: 2, felder: ['2026-10', 'Spritzguss gesamt', '312.400,0', 'kg'], bezugsgroesse: 'BZ-1', bezugsgroesse_id: bzListe.bezugsgroessen[0]?.id ?? null, schluessel: 'BZ-1 · 2026-10', periode_von: '2026-10-01', periode_bis: '2026-10-31', zeitpunkt: null, betrag: '312400.0', einheit: 'kg', geliefert: { wert: '312.400,0', einheit: 'kg' }, urteil: 'neu', befunde: [], fingerabdruck: 'a', bestand: null },
    { nr: 3, felder: ['2026-10', 'Spritzguss Export', '688.720', 'lbs'], bezugsgroesse: 'BZ-1', bezugsgroesse_id: bzListe.bezugsgroessen[0]?.id ?? null, schluessel: null, periode_von: null, periode_bis: null, zeitpunkt: null, betrag: null, einheit: null, geliefert: { wert: '688.720', einheit: 'lbs' }, urteil: 'abgelehnt', befunde: [{ befund: 'einheit_unbekannt', satz: 'Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.', hinweis: false }], fingerabdruck: null, bestand: null },
    { nr: 4, felder: ['2026-10', 'Montage', '96', 'Paletten'], bezugsgroesse: 'BZ-2', bezugsgroesse_id: bzListe.bezugsgroessen[1]?.id ?? null, schluessel: null, periode_von: null, periode_bis: null, zeitpunkt: null, betrag: null, einheit: null, geliefert: { wert: '96', einheit: 'Paletten' }, urteil: 'abgelehnt', befunde: [{ befund: 'einheit_unbekannt', satz: 'Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.', hinweis: false }], fingerabdruck: null, bestand: null },
  ],
  import: { status: 'teilweise_uebernommen', zaehler: { zeilen: 3, neu: 1, wiederholung: 0, konflikt: 0, berichtigung: 0, uebersprungen: 0, abgelehnt: 2, mit_hinweis: 0 }, uebernahme_moeglich: true, import_datensatz: true, bestaetigung: '1 von 3 Zeilen übernehmen', aenderungen: 1, befunde: [] },
  });
  if (params.get('importfall') === 'B2') {
    basis.datei.befund = { befund: 'datei_bekannt', satz: 'Diese Datei wurde schon übernommen.', hinweis: true };
    basis.frueherer_import = { kennung: 'I-2026-0001', status: 'uebernommen', am: '2026-11-03T09:12:00+01:00' };
    basis.zeilen = [{ ...basis.zeilen[0], urteil: 'wiederholung', befunde: [] }];
    basis.import = { status: 'wiederholt', zaehler: { zeilen: 1, neu: 0, wiederholung: 1, konflikt: 0, berichtigung: 0, uebersprungen: 0, abgelehnt: 0, mit_hinweis: 1 }, uebernahme_moeglich: false, import_datensatz: true, bestaetigung: null, aenderungen: 0, befunde: [basis.datei.befund] };
  }
  if (params.get('importfall') === 'B3') {
    basis.datei.name = 'ERP_Spritzguss_Produktion_2026-10_korr.csv';
    basis.zeilen = [{ ...basis.zeilen[0], felder: ['2026-10', 'Spritzguss gesamt', '312.900,0', 'kg'], betrag: '312900', geliefert: { wert: '312.900,0', einheit: 'kg' }, urteil: 'konflikt', befunde: [{ befund: 'konflikt_anderer_wert', satz: 'Für diesen Zeitraum gibt es schon einen anderen Wert.', hinweis: false }], bestand: { betrag: '312400', fassung: 1, import_kennung: 'I-2026-0001' } }];
    basis.import = { status: 'verworfen', zaehler: { zeilen: 1, neu: 0, wiederholung: 0, konflikt: 1, berichtigung: 0, uebersprungen: 0, abgelehnt: 0, mit_hinweis: 0 }, uebernahme_moeglich: false, import_datensatz: true, bestaetigung: null, aenderungen: 0, befunde: [] };
  }
  return basis;
};
let importStatus = 'uebernommen';
const importProtokoll = () => ({
  kennung: 'I-2026-0001', status: importStatus, datei_name: 'ERP_Spritzguss_Produktion_2026-10.csv', datei_bytes: 96,
  erstellt_am: '2026-11-03T09:12:00+01:00', geaendert_am: '2026-11-03T09:12:00+01:00', aenderungen: 1, vorschlaege: 0, vorlage: null,
  zaehler: { zeilen: 1, neu: 1, wiederholung: 0, konflikt: 0, berichtigung: 0, uebersprungen: 0, abgelehnt: 0, mit_hinweis: 0 },
  begruendung: importStatus === 'zurueckgenommen' ? 'Falsche Artikelgruppe exportiert — Datei war ein Testexport' : null,
  urheber: { name: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'konto' },
  zeilen: [{ nr: 2, urteil: 'neu', befunde: [], bezugsgroesse: 'BZ-1', periode_von: '2026-10-01', periode_bis: '2026-10-31', zeitpunkt: null, betrag: '312400', einheit: 'kg', geliefert_wert: '312.400,0', geliefert_einheit: 'kg' }],
});
Object.assign(window, { bzAufrufe });
Object.assign(api, {
  listSites: async () => sichtbareListe(sites),
  listDevices: async () => sichtbareListe(geraeteAhrenberg(new Date()).filter(d => siteIds.includes(d.siteId))),
  edgeVersions: async () => sichtbareListe([
    { deviceId: C1_IDS.boxHalle1, siteId: FIXTURE_IDS.an1, coreVersion: '2.7.1', paletteVersion: '1.14.0', reportedAt: new Date().toISOString() },
    { deviceId: C1_IDS.boxHalle2, siteId: FIXTURE_IDS.an2, coreVersion: '2.5.0', paletteVersion: '1.12.0', reportedAt: new Date().toISOString() },
  ]),
  tenantContext: async () => ({ tenantId: FIXTURE_IDS.u, name: 'Kunststoffwerk Ahrenberg GmbH', betriebsart: 'endkunde' }),
  overview: async () => structuredClone(overview),
  standortZuordnungVorschlag: async () => standortVorschlagOffen
    ? structuredClone(standortVorschlag)
    : { gruppen: [], anlagenZahl: 0 },
  standortZuordnungBestaetigen: async (body: unknown) => {
    standortVorschlagAnfragen.push(structuredClone(body));
    standortVorschlagOffen = false;
    if (bild === 'bestand-mehrere') {
      szene.liste = ahrenbergHeute();
      szene.unternehmen = ahrenbergUnternehmen();
    }
    return { standortIds: ['aa020000-0000-4000-8000-000000000010', 'aa020000-0000-4000-8000-000000000011'], zuordnungen: standortVorschlag.anlagenZahl };
  },
  earnings: async () => {
    throw new Error('Das Referenzunternehmen trägt keine Geldwerte.');
  },
  tenantCockpitLayout: async () => ({ vorgabe: null, eigen: null }),
  cockpitLayout: async () => ({ vorgabe: null, eigen: null }),
  // AP-04 IP-5: das Messstellen-Register des Referenzunternehmens (heute = 20.10.2026, mit Stichtag und Filtern).
  // AP-11 IP-15: `welt=k17` stellt MS-24 dazu.
  messstellenRegister: async (a: MessstellenRegisterAnfrage = {}) => {
    // AP-13 IP-13: `&stand=` verschiebt den Stand des Registers — und mit ihm den Tag, auf dem der Einstieg „Werte“ landet.
    const anfrage = REGISTER_STAND && !a.stichtag ? { ...a, stichtag: REGISTER_STAND } : a;
    let r = k17 ? mitMs24(ahrenbergRegister(anfrage)) : ahrenbergRegister(anfrage);
    if (AUSFALL) {
      r = {
        ...r,
        zeitpunkt: '2026-11-03T14:05:00+01:00',
        register: r.register.map((z) => z.kennzeichen === 'MS-15'
          ? { ...z, berechnung: { zustand: 'unvollstaendig', fehlend: ['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14'], seit: '2026-11-03T14:00:00+01:00', text: 'Unvollständig · fehlt: MS-10, MS-11, MS-12, MS-13, MS-14' } }
          : z),
      };
    }
    if (messenArt === 'bestand') {
      const leer = { erfuellt: 0, gesamt: 0, text: 'Noch keine Messstellen' };
      return { ...r, register: [], aggregat: { ...r.aggregat, unternehmen: leer, standorte: r.aggregat.standorte.map((st) => ({ ...st, ...leer })) } };
    }
    if (rechteAnsicht && !rollenMoment.unternehmensweit) {
      const ids = new Set(rollenMoment.standorte.map(st => st.id));
      const register = r.register.filter(z => z.ort.standort_id !== null && ids.has(z.ort.standort_id));
      const sichtbar = new Set(register.map(z => z.id));
      const standorte = r.aggregat.standorte.filter(st => st.id !== null && ids.has(st.id));
      const erfuellt = standorte.reduce((summe, st) => summe + st.erfuellt, 0);
      const gesamt = standorte.reduce((summe, st) => summe + st.gesamt, 0);
      return { ...r, register, messstellen: r.messstellen.filter(m => sichtbar.has(m.id)), teilansicht: true,
        aggregat: { standorte, unternehmen: { erfuellt, gesamt, text: `${erfuellt} von ${gesamt} Messstellen liefern Daten` } } };
    }
    if (!heuteB10) return r;
    return { ...r, register: r.register.map((z) => ({ ...z, name: nameHeuteAm(Date.now(), z.kennzeichen, z.name) })) };
  },
  // AP-13 IP-12 (L6): die Zuständigkeiten der Datenquellen und der Weg Gerät → Quelle. ZWEI Aufrufe je
  // Anlage, weil `…/data-sources` ihre Geräte nicht nennt (Befund an AP-06, `boxAnQuelle.ts`).
  datenquellen: async (siteId: string) => {
    const antwort = ahrenbergDatenquellen(siteId, new Date(Date.now()).toISOString());
    const boxId = siteId === FIXTURE_IDS.an1 ? C1_IDS.boxHalle1
      : siteId === FIXTURE_IDS.an2 ? C1_IDS.boxHalle2 : null;
    return {
      datenquellen: antwort.datenquellen.map((q) => ({
        ...q,
        zeitraeume: q.zeitraeume.map((z, i) => ({ ...z, id: `${q.id}-z${i + 1}` })),
        zustaendige_box: q.zustaendige_box && boxId ? { ...q.zustaendige_box, id: boxId } : q.zustaendige_box,
      })),
    };
  },
  datenquellePruefen: async (_siteId: string, id: string, body: { device_id: string }) => {
    const device = geraeteAhrenberg(new Date(Date.now())).find((d) => d.id === body.device_id)!;
    return { box: { id: device.id, name: device.name, heimat_anlage: device.siteId }, adresse: '192.168.10.31:502',
      ergebnis: 'ok', gewertet: true, text: `${device.name} erreicht die Quelle`, zeitpunkt: new Date().toISOString(), dauer_ms: 38, antwort: {} };
  },
  datenquelleZuweisen: async (siteId: string, id: string, body: { device_id: string; effective_from?: string }) => {
    const q = (await (api.datenquellen as (siteId: string) => Promise<{ datenquellen: UemsDatenquelle[] }>)(siteId)).datenquellen.find((x) => x.id === id)!;
    const device = geraeteAhrenberg(new Date(Date.now())).find((d) => d.id === body.device_id)!;
    const ab = body.effective_from ?? new Date().toISOString();
    const neu = { ...q, zeitraeume: [
      ...q.zeitraeume.slice(0, -1),
      { ...q.zeitraeume.at(-1)!, effective_to: ab },
      { id: `${q.id}-plan`, box: { id: device.id, name: device.name, heimat_anlage: device.siteId }, effective_from: ab, effective_to: null },
    ] };
    return { urteil: 'erlaubt' as const, text: `Ab dann liest ${device.name}`, hinweis: null, vergleichsquelle: false, datenquelle: neu };
  },
  datenquelleZuweisungZuruecknehmen: async (siteId: string, id: string) => {
    const q = (await (api.datenquellen as (siteId: string) => Promise<{ datenquellen: UemsDatenquelle[] }>)(siteId)).datenquellen.find((x) => x.id === id)!;
    return { ...q, zeitraeume: [{ ...q.zeitraeume[0], effective_to: null }] };
  },
  claimDevice: async (siteId: string, externalRef: string) => ({ id: 'e0000000-0000-4000-8000-000000000099', siteId,
    externalRef, kind: 'edge', name: 'Box Halle 1 (neu)', status: 'claimed', lastSeenAt: null, createdAt: new Date().toISOString() }),
  boxTauschen: async (newId: string, oldId: string) => ({ tausch: { oldDeviceId: oldId, newDeviceId: newId,
    siteId: FIXTURE_IDS.an1, effectiveAt: new Date().toISOString(), transferred: { datenquellen: 3 } }, zugestellt: false }),
  uemsGeraete: async (siteId: string) => ahrenbergUemsGeraete(siteId),
  // AP-13 IP-7: die Energiebilanz je Anlage (O2 Oktober 2026, O4 Halle 2, O3 Lindach am 18.10.2026) — sonst ohne Werte.
  anlageBilanz: async (siteId: string, periode?: 'tag' | 'monat' | 'jahr', am?: string) => bilanzDerBuehne(siteId, periode, am),
  // AP-13 IP-8: „Rest anlegen“ — nie zweimal: nach dem ersten Klick hat der Hauptzähler seinen Rest (`neu` = false).
  anlageRestAnlegen: async (siteId: string, body: { hauptzaehler_id: string; name?: string }) => {
    restAnlegenAufrufe.push({ siteId, ...body });
    const neu = restVorschlag;
    restVorschlag = false;
    const h = bilanzDerBuehne(siteId, 'tag').hauptzaehler[0];
    return { neu, hauptzaehler: h.messstelle, messstelle: { ...h.rest_messstelle, name: body.name ?? h.rest_messstelle?.name ?? null } as never };
  },
  // AP-04 IP-6: was der Messstellen-Dialog beim Öffnen liest (Vorschlag, Standorte, Ortsbäume).
  kennzeichenVorschlag: async () => ({ kennzeichen: 'MS-0023' }),
  standortOrte: async (id: string) => {
    if (KORREKTUR && id === FIXTURE_IDS.st1) {
      const standort = szene.liste.standorte.find((s) => s.id === id)!;
      return ortsbaumAhrenberg({
        standort: { ...standort, zustand: korrekturArchiviert ? 'archiviert' : standort.zustand },
        summeGebaeudeM2: null,
        gebaeude: [],
        direktAmStandort: { bereiche: [], messstellenZahl: 0 },
        aktionen: {
          archivieren: { erlaubt: !korrekturArchiviert, text: null, gruende: [], letzterTag: '2026-11-19', mitarchiviert: [] },
          wiederherstellen: null,
          loeschen: null,
        },
      });
    }
    return id === werkLindach().id ? (ORTE_LEER ? ortsbaumLindachOhneGebaeude() : ortsbaumLindach()) : ortsbaumAhrenberg();
  },
  versorgung: async (id: string) => id === werkLindach().id ? versorgungLindach() : versorgungAhrenberg(),
  // AP-11 IP-13: die Kennzahlen der Welt — gelesen zur Uhr der Bühne.
  kennzahlen: async () => ({ kennzahlen: (messenArt === 'bestand' ? [] : kennzahlenDerBuehne()).filter(k => !rechteAnsicht || rollenMoment.unternehmensweit
    || (k.standort_id !== null && rollenMoment.standorte.some(st => st.id === k.standort_id))) }),
  kennzahl: async (id: string) => kennzahlDerBuehne(id),
  kennzahlFassungen: async (id: string) => ({
    kennzahl_id: id,
    kennzeichen: kennzahlenDerBuehne().find((x) => x.id === id)?.kennzeichen ?? '',
    fassungen: fassungenDerBuehne(id),
  }),
  kennzahlWerte: async (id: string, periode: KennzahlPeriodeArt, von: string, bis: string) => {
    if (id === kzAusserhalb) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    if (istAngelegt(id)) return ohneWerte(id, periode, von, bis);
    if (k17 && id === KZ4_ID) return k17WerteAntwort(k17, periode, von, bis, Date.now());
    return kennzahlWerteAntwort(id, periode, von, bis, Date.now());
  },
  kennzahlWertVersionen: async (id: string, periode: KennzahlPeriodeArt, von: string) =>
    kennzahlWertVersionenAntwort(id, periode, von, Date.now()),
  // AP-11 IP-14: was der Assistent „Kennzahl anlegen“ liest — und seine zwei Aufrufe, gezählt.
  kanalbindungen: async () => [],
  bezugsgroessen: async () => {
    if (params.get('bezugs') === 'fehler') throw new ApiError(503, 'Nicht erreichbar');
    return structuredClone(bzListe);
  },
  bezugsgroesseAnlegen: async (body: BezugsgroesseAnfrage) => {
    bzAufrufe.anlegen.push(body);
    if (params.get('bezugs') === 'konflikt') throw new ApiError(409, 'Belegt', { code: 'kennzeichen_belegt' });
    const b = { ...body, id: `c0de0000-0000-4000-8000-00000000b0${bzAufrufe.anlegen.length}1`, kennzeichen: body.kennzeichen || 'BZ-0008', periode_art: body.periode_art ?? null, geltung_name: body.geltung_art === 'prozess' ? 'Spritzguss' : 'Werk Lindach', hat_werte: false, archiviert_am: null, angelegt_am: new Date().toISOString() };
    bzListe.bezugsgroessen.push(b);
    return structuredClone(b);
  },
  bezugsgroesseArchivieren: async (id: string) => {
    bzAufrufe.archivieren.push(id);
    const b = bzListe.bezugsgroessen.find(x => x.id === id)!;
    b.archiviert_am = new Date().toISOString();
    return structuredClone(b);
  },
  bezugsdatenVorlagen: async () => ({ vorlagen: structuredClone(importVorlagen) }),
  bezugsdatenVorlageSpeichern: async (body: { name: string; zuordnung: BezugsdatenZuordnung }) => {
    bzAufrufe.vorlagen.push(body.name);
    const v = { ...importVorlagen[0], vorlage_id: `c0de0000-0000-4000-8000-00000000f00${importVorlagen.length + 1}`, name: body.name, zuordnung: body.zuordnung };
    importVorlagen.push(v); return structuredClone(v);
  },
  bezugsdatenVorschau: async (datei: File) => { bzAufrufe.vorschau.push(datei.name); return structuredClone(importVorschau()); },
  bezugsdatenImportieren: async (datei: File) => { bzAufrufe.importe.push(datei.name); return { kennung: 'I-2026-0015', status: 'teilweise_uebernommen', aenderungen: 1, vorschlaege: 0, zaehler: importVorschau().import.zaehler, vorlage: null }; },
  bezugsdatenImporte: async () => ({ importe: [structuredClone(importProtokoll())] }),
  bezugsdatenImport: async () => structuredClone(importProtokoll()),
  bezugsdatenRuecknahmeVorschau: async () => ({ kennung: 'I-2026-0001', aenderungen: 1, vieraugen: false, werte: [{ bezugsgroesse_id: bzListe.bezugsgroessen[0]?.id ?? '', kennzeichen: 'BZ-1', name: 'Produktionsmenge', periode_von: '2026-10-01', periode_bis: '2026-10-31', zeitpunkt: null, bisheriger_betrag: '312400', neuer_betrag: null, einheit: 'kg', vorgang: 'zurueckgenommen' as const }] }),
  bezugsdatenImportZuruecknehmen: async (_kennung: string, begruendung: string) => { bzAufrufe.ruecknahmen.push(begruendung); importStatus = 'zurueckgenommen'; return { kennung: 'I-2026-0001', status: importStatus, aenderungen: 1, vorschlaege: 0, zaehler: null, vorlage: null }; },
  unternehmen: async () => ahrenbergUnternehmen(),
  standorte: async () => structuredClone(szene.liste),
  // Nach dem allgemeinen Standort-Leser: die Netzanschluss-Bühne ergänzt den
  // echten API-Vertrag `anlagen[].netzanschluss` und hält ihn nach Schreibwegen aktuell.
  ...netzanschlussBuehne(szene.liste),
  anlageStandortVorschau: async () => korrekturUmzug(),
  anlageStandortSetzen: async () => {
    if (KORREKTUR) {
      const alt = szene.liste.standorte.find((s) => s.id === FIXTURE_IDS.st1)!;
      const ziel = szene.liste.standorte.find((s) => s.id === st2)!;
      alt.anlagen = [];
      alt.anlagenZahl = 0;
      ziel.anlagen = [{ id: an3, name: lindach.name, gueltigAb: '2026-10-15', gueltigBis: null }];
      ziel.anlagenZahl = 1;
    }
    return korrekturUmzug();
  },
  berichteBetroffen: async () => ({
    anlass: 'anlage_umzug_rueckwirkend', gilt_ab: '2026-10-15', berichte_vorhanden: false, betroffen: [], zitieren: [],
  }),
  standortArchivieren: async (id: string) => {
    korrekturArchiviert = true;
    const standort = szene.liste.standorte.find((s) => s.id === id)!;
    return { ...standort, zustand: 'archiviert' as const, archiviertAm: '2026-11-20T09:00:00+01:00' };
  },
  standortAusfall: async (standortId: string): Promise<StandortAusfall> => {
    if (!AUSFALL || standortId !== FIXTURE_IDS.st1) {
      return { standort_id: standortId, boxen_gesamt: standortId === FIXTURE_IDS.st1 ? 2 : 1, boxen_ausgefallen: 0, messstellen_unvollstaendig: 0, boxen: [], messstellen: [] };
    }
    const register = ahrenbergRegister().register;
    const betroffen = ['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14', 'MS-15'];
    return {
      standort_id: standortId,
      boxen_gesamt: 2,
      boxen_ausgefallen: 1,
      messstellen_unvollstaendig: 6,
      boxen: [{ id: 'e0000000-0000-4000-8000-000000000002', name: 'Box Halle 2', seit: '2026-11-03T14:00:00+01:00', anlagen: [FIXTURE_IDS.an2] }],
      messstellen: register.filter((z) => betroffen.includes(z.kennzeichen)).map((z) => ({
        id: z.id,
        kennzeichen: z.kennzeichen,
        name: z.name,
        art: z.art,
        seit: '2026-11-03T14:00:00+01:00',
        box_id: z.art === 'gemessen' ? 'e0000000-0000-4000-8000-000000000002' : null,
        box: z.art === 'gemessen' ? 'Box Halle 2' : null,
        fehlt: z.art === 'berechnet' ? ['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14'] : [],
      })),
    };
  },
  // AP-13 IP-9: in den Reitern gelten die Prozesse der Messstellen-Fixtures — dieselben Kennungen wie ihre Zuordnungen.
  prozesse: async () => ({
    stichtag: null,
    prozesse: ORGANISATION_LEER ? [] : ORGANISATION_REITER ? prozesseAhrenberg() : ahrenbergProzesse(),
  }),
  kostenstellen: async () => ({
    stichtag: null,
    kostenstellen: ORGANISATION_LEER ? [] : ORGANISATION_REITER ? kostenstellenAhrenberg() : ahrenbergKostenstellen(),
  }),
  // AP-13 IP-9: die Kostenstellen-Sicht je Kostenstelle (O9 Oktober 2026, F12 am 15.01.2027) und die Prozesse der
  // berechneten Messstellen (MS-20 → P-1).
  // Wie die api (Kostenstelle B): ohne `messwerte.ansehen` am Unternehmen gibt es diese Kostenstelle nicht (404);
  // `window.__energieAufrufe` zählt jeden Aufruf — der Nachweis, dass ein Bearbeiter gar nicht erst fragt.
  kostenstelleEnergie: async (id: string, periode: 'tag' | 'monat' | 'jahr', am: string) => {
    const w = window as unknown as { __energieAufrufe?: number };
    w.__energieAufrufe = (w.__energieAufrufe ?? 0) + 1;
    if (!darf('messwerte.ansehen', null, rollenMoment)) throw new ApiError(404, 'Kostenstelle nicht gefunden.');
    return ahrenbergKostenstelleEnergie(id, periode, am);
  },
  messstelleProzesse: async (id: string) => ahrenbergMessstelleProzesse(id),
  kennzahlVorschau: async (a: KennzahlAnfrage) => {
    kennzahlAufrufe.vorschau.push(structuredClone(a));
    return (k17 ? k17VorschauAntwort(a, Date.now()) : null) ?? kennzahlVorschauAntwort(a, Date.now());
  },
  kennzahlAnlegen: async (a: KennzahlAnfrage) => {
    kennzahlAufrufe.anlegen.push(structuredClone(a));
    const kennzeichen = naechstesKennzeichen(kennzahlenDerBuehne().map((k) => k.kennzeichen));
    const k = angelegteKennzahl(a, kennzeichen, geltungName(a.geltung_art, a.geltung_id), Date.now(), person ?? 'Jonas Wendlinger');
    angelegt.push(k);
    return k;
  },
  // AP-12 IP-13: die Berichte der Referenzdatei (BR-2026-0001) — gelesen zur Uhr der Bühne.
  // AP-12 IP-14: dazu die Selbstauskunft (B13 je Person) und die schreibenden Wege Anlegen, Freigeben, Verwerfen.
  selbstauskunft: async () => structuredClone(rollenMoment),
  berichte: async () => ({ berichte: berichtDa ? [mitVerworfen(detailAm(Date.now()), verworfen).bericht] : [] }),
  bericht: async (kennung: string) => {
    if (kennung !== 'BR-2026-0001' || !berichtDa) throw new ApiError(404, 'Diesen Bericht gibt es nicht.');
    return mitVerworfen(detailAm(Date.now()), verworfen);
  },
  berichtAnlegen: async (a: Parameters<typeof api.berichtAnlegen>[0]) => {
    berichtAufrufe.anlegen.push(structuredClone(a));
    const b = anlegenAm(a, berichtDa, Date.now());
    berichtDa = true;
    return b;
  },
  berichtEntwurf: async () => mitTagesverlauf(entwurfAm(Date.now())),
  berichtVergleich: async (_kennung: string, gegen: number) => vergleichAm(gegen, Date.now()),
  berichtFreigeben: async (_kennung: string, datenstand: string) => {
    berichtAufrufe.freigeben.push(datenstand);
    return freigabeAm(datenstand, Date.now());
  },
  berichtStand: async (_kennung: string, nr: number) => mitTagesverlauf(standAm(nr, Date.now())),
  berichtAnstossVerwerfen: async (_kennung: string, id: string, begruendung: string) => {
    berichtAufrufe.verwerfen.push(begruendung);
    verworfen = { begruendung, am: new Date(Date.now()).toISOString(), von: person ?? 'Jonas Wendlinger' };
    const anstoss = mitVerworfen(detailAm(Date.now()), verworfen).anstoesse.find((x) => x.id === id);
    if (!anstoss) throw new ApiError(404, 'Diesen Anstoß gibt es nicht.');
    return anstoss;
  },
  // AP-13 IP-9: im Reiter „Prozesse“ fragt die Fläche den Wert der Prozess-Summe für ihren Zeitraum.
  // AP-13 IP-13: im Weg-Bild antwortet die Werte-Route der Bühne (Karte, Liste, Verlauf, Vergleich); was sie nicht
  // gestellt hat, ist ein 404 — nie eine erfundene Zahl.
  messstelleWerte: async (
    kennzeichen: string,
    raster?: MessstelleWerteRaster,
    von?: string,
    bis?: string,
    version?: number | null,
  ) => {
    if (ORGANISATION_REITER && raster && von && bis) return ahrenbergProzessSummeWerte(kennzeichen, raster, von, bis);
    if (WEG_BUEHNE && raster && von && bis) {
      const antwort = werteDerBuehne(kennzeichen, raster, von, bis, version);
      if (antwort) return antwort;
      throw new ApiError(404, 'Diese Messstelle gibt es nicht.');
    }
    const heute = await heutigeWerteAm(kennzeichen, Date.now());
    return ZUORDNUNG_OFFEN ? { ...heute, zuordnung: 'nicht_zugeordnet' as const } : heute;
  },
  // AP-13 IP-13: was die Messstellen-Seite selbst liest — Stammdaten, Verteilung, Protokoll und die Versionen der Zahl.
  messstelle: async (id: string) => (id === MS_IDS.ms06 ? ms06() : ms10()),
  messstelleQuellen: async (id: string, stichtag?: string | null) =>
    quellenDerMessstellenBuehne(id, stichtag ?? iso(Date.now(), 'Europe/Berlin')),
  messstelleVerteilung: async (id: string) => ohneVerteilung(id === MS_IDS.ms06 ? ms06() : ms10()),
  messstelleAenderungen: async (id: string) => (id === MS_IDS.ms06 ? protokollMs06() : protokollMs10()),
  messstelleWerteVersionen: async () => f21Historie(),
  // AP-11 IP-15: die vier schreibenden Wege der Kennzahl-Seite — sie ändern die Bühne und werden gezählt.
  kennzahlFassungEintragen: async (
    id: string,
    body: { gueltig_ab: string; begruendung: string; periode_art?: KennzahlPeriodeArt | null; komplement?: boolean | null; eingaenge: KennzahlEingang[] },
  ) => {
    kennzahlAufrufe.fassung.push(structuredClone({ id, ...body }));
    const k = kennzahlDerBuehne(id);
    const alle = fassungenDerBuehne(id);
    const vorlage = alle.find((f) => f.nummer === k.fassung);
    if (!vorlage) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    const jetzt = iso(Date.now(), 'Europe/Berlin');
    const u = fassungEintrag(wirksame(alle), body.gueltig_ab, jetzt, 'Europe/Berlin');
    if (u.fehler) throw new ApiError(422, u.kundensatz ?? '');
    const nummer = naechsteNummer(alle);
    const neu: KennzahlFassung[] = [
      ...alle.map((f) => (f.nummer === u.beenden ? { ...f, gueltig_bis: u.beenden_am } : f)),
      {
        ...vorlage,
        nummer,
        gueltig_ab: body.gueltig_ab,
        gueltig_bis: null,
        aufgehoben_am: null,
        herkunft: 'eintrag',
        rueckwirkend: u.rueckwirkend,
        abzeichen: u.abzeichen,
        begruendung: body.begruendung,
        eingetragen_von: { name: person ?? 'Jonas Wendlinger', rolle: 'Energiemanager', art: 'kunde' },
        eingetragen_am: jetzt,
        komplement: body.komplement ?? false,
        eingaenge: body.eingaenge.map(eingangMitName),
      },
    ];
    buehnenFassungen.set(id, neu);
    buehnenStand.set(id, { ...k, fassung: nummer });
    return { kennzahl_id: id, kennzeichen: k.kennzeichen, fassungen: neu };
  },
  kennzahlAendern: async (id: string, body: { kennzeichen: string; name: string; verantwortlich_name: string; zweck?: string | null }) => {
    kennzahlAufrufe.stammdaten.push(structuredClone({ id, ...body }));
    const neu = { ...kennzahlDerBuehne(id), name: body.name, verantwortlich_name: body.verantwortlich_name, zweck: body.zweck ?? null };
    buehnenStand.set(id, neu);
    return neu;
  },
  kennzahlArchivieren: async (id: string) => {
    kennzahlAufrufe.archivieren.push(id);
    const neu = { ...kennzahlDerBuehne(id), archiviert_am: iso(Date.now(), 'Europe/Berlin') };
    buehnenStand.set(id, neu);
    return neu;
  },
  kennzahlLoeschen: async (id: string) => {
    kennzahlAufrufe.loeschen.push(id);
    const k = kennzahlDerBuehne(id);
    if (k.hat_werte) throw new ApiError(409, ABLEHNUNG_SATZ.hat_werte.replace('{kennzahl}', k.kennzeichen));
    geloescht.add(id);
  },
  // IP-6: beide Funktionen je sichtbarem Standort (A7; `messen=bestand` = A11).
  funktionen: async () => funktionenDerSzene(),
  // IP-8: die Steuerungsseite einer Anlage, die nur misst. Gestellt ist, was
  // die Zonen lesen (seit der Steuern-Regel ohne Hinweis); der Rest antwortet wie ein älteres Backend.
  summenwertQuellen: async () => [], // Diese Bühne stellt keine lesbaren Geräte-Register.
  siteEntities: async (id: string) => ({ registry: null, localSetup: [], staleOnDevice: [], entities: komponentenVon(id) }),
  siteVerbraucher: async (id: string) => verbraucherVon(id),
  chargingConfig: async () => ({ gridLimitKw: null, priorityChargePointIds: [], chargePoints: [], frame: null }),
  entityStrategies: async () => ({}),
  // Der Einstieg mit nur einer Anlage kann deren Cockpit vor der E1-Weiche laden.
  // Die Standort-Bühne liefert diese Zusatzdaten nicht; auch dieser Pfad bleibt isoliert.
  topology: nichtGestellt,
  siteEarnings: nichtGestellt,
  controlStatus: nichtGestellt,
  siteSources: nichtGestellt,
  weather: nichtGestellt,
  schedule: nichtGestellt,
  rollenWert: nichtGestellt,
  usageProfile: nichtGestellt,
  siteProfiles: nichtGestellt,
  siteAssets: nichtGestellt,
  siteChargers: nichtGestellt,
  siteFahrzeuge: nichtGestellt,
  curtailmentStatus: nichtGestellt,
  siteInterventions: nichtGestellt,
  siteRuleEvents: nichtGestellt,
  suggestionStates: nichtGestellt,
});
Object.assign(consumersApi, {
  options: async () => ({ types: [], signals: [], intents: [], hasStorage: false, reportedSources: [] }),
  list: async () => [],
  status: async () => [],
  overrides: async () => [],
  fulfillment: async () => ({ tasks: [] }),
});
// IP-12: die echte Anwendung mit den drei Rechte-Momentaufnahmen R1/T1/T3.
// Steuerungs-Schnappschuss zur Referenz-Momentaufnahme MS-04: −40 kW, Entladen.
if (rechteAnsicht && params.get('person') === 'MD') {
  Object.assign(api, {
    schedule: async () => ({ deviceId: 'E-1', slots: [] }),
    controlStatus: async () => ({ deviceId: 'E-1', certified: true, controlEnabled: true,
      commandedKw: -40, confirmedKw: -40, allMatch: true, checkedAt: STAND, mismatchRoles: null }),
    siteInterventions: async () => ({ automationPaused: false, pausedUntil: null, interventions: [] }),
  });
  window.history.replaceState(null, '', hashForRoute(anlageRoute(an1, 'steuerung')));
}
const beendeZugriff = () => {
  rollenMoment.standorte = [];
  rollenMoment.unternehmensweit = false;
  rollenMoment.unternehmen_rechte = [];
  rollenMoment.text = 'Ihnen ist derzeit kein Standort zugewiesen. Ihr Kundenadministrator Jonas Wendlinger kann das ändern.';
  rollenMoment.teilansicht = null;
};
if (params.get('rechte') === 'leer') beendeZugriff();
(window as unknown as Record<string, unknown>).__beendeZugriff = () => {
  beendeZugriff();
  window.dispatchEvent(new CustomEvent('vp-zugriff-beendet', { detail: 'Ihr Zugriff auf Werk Lindach wurde beendet.' }));
};

// Die Regeln der Anlage: keine. Die Flow-Routen gehen über `fetch`.
const echtesFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (/^\/api\/v1\/sites\/[^/]+\/flows$/.test(url.pathname)) return Response.json([]);
  if (url.pathname.endsWith('/flow-node-status')) return Response.json({ acks: [], nodes: [] });
  if (url.pathname.endsWith('/flow-node-governance')) return Response.json({ gatedNodes: [] });
  return echtesFetch(input, init);
};

async function nichtGestellt(): Promise<never> {
  throw new Error('In der Bühne nicht gestellt.');
}

/** IP-8: ein Standort ohne Anlage misst noch nicht und hat keine Teilnahme. */
/** `GET /funktionen` der Szene: beide Funktionen je sichtbarem Standort — dieselbe Antwort für Schale und Seite. */
function funktionenDerSzene() {
  const basis = ahrenbergFunktionen({
    standorte: [funktionWerkAhrenberg(messenArt), funktionWerkLindach(messenArt)]
      .filter((f) => szene.liste.standorte.some((s) => s.id === f.id))
      .map(ohneAnlage),
  });
  if (MESSEN_ENTWURF) {
    basis.standorte = basis.standorte.map((s) => ({
      ...s,
      messen: { zustand: 'entwurf' as const, seit: null, text: 'Messen & Auswerten — Entwurf', fehlt: [], datenlage: null },
    }));
  }
  if (vorschauArt === 'steuerkunde' || !vorschauArt) return basis;
  return {
    ...basis,
    standorte: basis.standorte.map((standort) => ({
      ...standort,
      steuern: {
        ...standort.steuern,
        anlagen: standort.steuern.anlagen.map((anlage) => ({
          ...anlage,
          teilnahme: { ...anlage.teilnahme, zustand: 'kein_objekt' as const },
        })),
      },
    })),
  };
}

function ohneAnlage(f: FunktionStandort): FunktionStandort {
  const hier = szene.liste.standorte.find((s) => s.id === f.id);
  if (!hier || hier.anlagen.length > 0) return f;
  return { ...f, messen: funktionWerkLindach('bestand').messen, steuern: { ...f.steuern, anlagen: [] } };
}

/** Die Komponenten der zwei Messanlagen aus dem Referenzunternehmen (Halle 2: Netz + K-9; Lindach: Netz). */
function komponentenVon(id: string) {
  const netz = { id: `${id}-netz`, entityType: 'grid-meter', typeLabel: 'Netzanschluss', role: 'grid', label: 'Hauptzähler', capabilities: { measure: [{ channel: 'power_kw' }] } };
  if (id !== an2) return [netz];
  return [
    netz,
    { id: 'k-9', entityType: 'ev-charger', typeLabel: 'Ladepunkt', role: 'consumer', label: 'Ladepunkt Parkplatz Halle 2 (22 kW)', capabilities: { measure: [{ channel: 'power_kw' }] } },
  ];
}

/** Die Verbraucher-Zone: Halle 2 trägt K-9 („Nur messen", keine Steuerart gesetzt), Lindach nichts. */
function verbraucherVon(id: string) {
  const k9 = {
    entityId: 'k-9',
    name: 'Ladepunkt Parkplatz Halle 2 (22 kW)',
    typ: 'ev-charger',
    typLabel: 'Ladepunkt',
    ladepunkt: true,
    chargePointId: 'AHR-LP-01',
    steuerart: { quelle: 'sofort', herkunft: 'ohne' },
    regeln: 0,
  };
  const zuHalle2 = id === an2;
  return {
    verbraucher: zuHalle2 ? [k9] : [],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: zuHalle2 ? 1 : 0, rahmen: null },
    rangliste: [],
  };
}

const surface = anlageSurface({
  entities: [{ id: 'speicher', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } }],
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' },
} as Parameters<typeof anlageSurface>[0]);

/** IP-8: Halle 1 wie bisher; die zwei Messanlagen mit dem Lese-Modell OHNE Geld, wie `useAnlageSurface` es bildet. */
function surfaceVon(id: string) {
  const s =
    id === an1
      ? surface
      : ohneGeld(
          anlageSurface({ entities: komponentenVon(id), config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' } } as Parameters<
            typeof anlageSurface
          >[0]),
        );
  // AP-13 IP-8, wie `useAnlageSurface`: der Reiter „Energiebilanz“ nur mit Hauptzähler in der Stellung (heute).
  return mitEnergiebilanz(s, bilanzDerBuehne(id, 'tag'));
}

const FLOTTE = 'Meine Anlagen';

function Vorschau() {
  const [, setRevision] = useState(0);
  const rahmen = { isAdmin: false, loaded: true, tenantReady: true, betriebsart: 'endkunde' as const };
  const orte = orteAus(szene.liste, szene.unternehmen);
  const ebene = startEbene({ ...rahmen, siteIds, orte, eingeschraenkt: !rollenMoment.unternehmensweit });
  const shell: ShellInput = { ...rahmen, siteCount: siteIds.length, ebene };
  const kanonisch = (r: Route) => canonicalShellRoute({ shell, route: r, siteIds }) ?? r;
  /**
   * AP-13 IP-13: Periode, Version und Vergleich des Abschnitts „Werte“ (AP-13 IP-3/IP-5). `App.tsx` hält sie in der
   * Adresse; die Bühne führt ihre Adresse als `data-route` und hält die drei deshalb hier — dieselben Wege, dieselben
   * Regeln: ein Einstieg aus dem Register setzt die Periode, ein Zeitraum-Wechsel lässt den Vergleich stehen und
   * vergisst die Version, der Weg zurück in die Liste räumt alles ab.
   */
  const [werte, setWerte] = useState<{ periode: string | null; version: number | null; vergleich: string | null }>(() => ({
    periode: WEG_ANSICHT ? WEG_PERIODE : null,
    version: WEG_ANSICHT ? WEG_VERSION : null,
    vergleich: WEG_ANSICHT ? WEG_V : null,
  }));
  const [route, setRoute] = useState<Route>(() =>
    kanonisch(
      ansicht === 'bilanz'
        ? anlageRoute(bilanzAn, 'energiebilanz')
        : ansicht === 'box-halle1'
          ? { ...anlageRoute(an1, 'box'), geraet: { ref: 'VP-BOX-2024-0117', geraetId: null } }
        : ansicht === 'korrektur-anlage'
          ? anlageRoute(an3, 'technik')
        : ansicht === 'anlage'
        ? anlageRoute(an1)
        : ansicht === 'steuerung-halle2'
          ? anlageRoute(an2, 'steuerung')
          : ansicht === 'steuerung-lindach'
            ? anlageRoute(an3, 'steuerung')
            : ansicht === 'lindach'
          ? standortRoute(st2)
          : ansicht === 'werk'
            ? standortRoute(FIXTURE_IDS.st1)
            // AP-13 IP-2: die Seiten des Standorts.
            : ansicht === 'werk-gebaeude'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'gebaeude')
            : ansicht === 'werk-boxen'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'boxen')
            : ansicht === 'werk-netzanschluesse'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'netzanschluesse')
            : ansicht === 'werk-anlagen'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'anlagen')
            : ansicht === 'werk-kennzahlen'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'kennzahlen')
            : ansicht === 'werk-berichte'
              ? standortBereichRoute(FIXTURE_IDS.st1, 'berichte')
            : ansicht === 'lindach-gebaeude'
              ? standortBereichRoute(st2, 'gebaeude')
            : ansicht === 'lindach-anlagen'
              ? standortBereichRoute(st2, 'anlagen')
            // AP-13 IP-13: die Stationen Zahl · Verlauf · Vergleich stehen auf der Messstellen-Seite.
            : WEG_ANSICHT
              ? messstelleRoute(wegMessstelleId())
            : ansicht === 'messstellen' || ORGANISATION_REITER
              ? pageRoute('portfolio-messstellen')
              : ansicht === 'standorte'
                ? pageRoute('portfolio-standorte')
              : ansicht === 'werk-messstellen'
                ? standortMessstellenRoute(FIXTURE_IDS.st1)
                : ansicht === 'lindach-messstellen'
                  ? standortMessstellenRoute(st2)
                  : ansicht === 'bezugsgroessen' || ansicht === 'bezugsgroessen-b'
                    ? pageRoute('portfolio-bezugsgroessen')
                  : ansicht === 'kennzahlen'
                    ? pageRoute('portfolio-kennzahlen')
                    : ansicht === 'kennzahl' && kzOffen
                      ? kennzahlRoute(kzOffen)
                      : ansicht === 'berichte'
                        ? pageRoute('portfolio-berichte')
                        : ansicht === 'bericht'
                          ? berichtRoute(params.get('br') ?? 'BR-2026-0001')
                          : pageRoute('uebersicht'),
    ),
  );
  useEffect(() => {
    // Die Adresse der Bühne — mit dem, was `App.tsx` an die Messstellen-Seite hängt (AP-13 IP-3/IP-5).
    const anhang = new URLSearchParams();
    if (route.messstelleId && werte.periode) anhang.set('periode', werte.periode);
    if (route.messstelleId && werte.version != null) anhang.set('version', String(werte.version));
    if (route.messstelleId && werte.vergleich) anhang.set('v', werte.vergleich);
    const frage = anhang.toString();
    document.body.dataset.route = hashForRoute(route) + (frage ? `?${frage}` : '');
  }, [route, werte]);

  const navigate = (ziel: Route | PageId) => setRoute(kanonisch(typeof ziel === 'string' ? pageRoute(ziel) : ziel));
  const navigateSchale = (ziel: Route | PageId) => {
    if (ebene.art === 'standort' && ziel === 'portfolio') return navigate(flottenLandung(shell));
    if (ebene.art === 'standort' && ziel === 'portfolio-messstellen') return navigate(standortMessstellenRoute(ebene.standort.id));
    return navigate(ziel);
  };

  const site = route.page === 'anlagen' ? sites.find((s) => s.id === route.siteId) ?? null : null;
  const pfad = kopfPfad({ shell, route, anlageId: site?.id ?? null, fleetLabel: FLOTTE });
  const eintrag = (g: PfadGlied) => ({ wert: pfadWert(g), label: g.label, onOpen: () => navigate(g.route) });
  const rueckwege = pfad.vor.some((g) => g.ebene !== 'flotte') ? pfad.vor.map(pfadZeile) : undefined;
  const flotte = showPortfolioNav(shell) || showOverviewNav(shell);
  const standort =
    route.page === 'standort' ? szene.liste.standorte.find((s) => s.id === route.standortId) ?? null : null;
  // Wie `App.tsx`: bei mehreren Standorten ist `#/portfolio` die Unternehmens-Übersicht.
  const unternehmensEbene: UebersichtEbene | null =
    ebene.art === 'unternehmen'
      ? { art: 'unternehmen', name: szene.unternehmen.name ?? '', standorte: szene.liste.standorte }
      : null;

  // UEMS AP-01 IP-7: die Leiste der Ebene aus denselben reinen Funktionen wie `App.tsx`.
  const lesemodell: EbenenLesemodell = {
    standorte: szene.liste.standorte,
    funktionen: funktionenDerSzene(),
    kennzahlen: ahrenbergKennzahlen(),
  };
  const standortBereich = standortBereichFuer(route, lesemodell);
  const ort = site ? null : ebenenOrt(route, ebene);
  const kacheln = (ort ? ebenenLeiste(ort, lesemodell, KUENFTIG ? ALLE_SEITEN_KUENFTIG : undefined) : []).filter(k => ansicht !== 'bezugsgroessen-b' || k.key !== 'bezugsgroessen');
  const ebenenNav =
    ort && kacheln.length > 0
      ? {
          titel: ebenenTitel(ort, lesemodell, szene.unternehmen.name ?? ''),
          kacheln,
          aktiv: ansicht === 'bezugsgroessen-b' ? 'messstellen' as const : ebenenAktiv(route.page, standortBereich),
          onOpen: (ziel: Route) => navigate(ziel),
        }
      : null;
  // AP-04 IP-5, wie `App.tsx`: der Reiter „Messstellen" nur, wo gemessen wird; am Telefon
  // entfallen die Reiter, die die Leiste trägt. `&reiter=alle` = Variante A der Vorschau (alle bleiben).
  const bereiche = ort ? ebenenBereiche(ort, lesemodell).map((b) => b.key) : [];
  const leiste = params.get('reiter') === 'alle' ? [] : kacheln.map((k) => k.key);
  const standortReiter =
    route.page === 'standort' && ebene.art !== 'standort' && ort?.art === 'standort' ? ebenenReiter(ort, lesemodell) : [];
  // AP-13 IP-2, wie `App.tsx`: als oberste Ebene bringt der Standort Gebäude · Anlagen in die Reiter mit;
  // seine Übersicht bekommt die Einstiege „Kennzahlen/Berichte dieses Standorts“.
  const standortObenReiter =
    ebene.art === 'standort' && ort?.art === 'standort'
      ? ebenenReiter(ort, lesemodell)
          .filter((r) => r.key === 'boxen' || r.key === 'gebaeude' || r.key === 'anlagen')
      : [];
  const einstiege = ort?.art === 'standort' ? standortEinstiege(ort, lesemodell) : [];
  const portfolioReiter = (page: PageId) => (
    <PortfolioTabs
      page={page}
      showErloese={false}
      showMessstellen={bereiche.includes('messstellen')}
      showBezugsgroessen={ansicht !== 'bezugsgroessen-b' && ebenenBereiche({ art: 'unternehmen' }, lesemodell).some(b => b.key === 'bezugsgroessen')}
      showKennzahlen={bereiche.includes('kennzahlen')}
      showBerichte={bereiche.includes('berichte')}
      leiste={leiste}
      fleetLabel={FLOTTE}
      onNavigate={navigateSchale}
      standortBereiche={standortObenReiter}
      standortAktiv={ebenenAktiv(route.page, standortBereich)}
      onOpenBereich={navigate}
    />
  );
  const messstellenEbene =
    route.page === 'portfolio-messstellen' && ebene.art === 'unternehmen'
      ? { art: 'unternehmen' as const, name: szene.unternehmen.name ?? '' }
      : route.page === 'portfolio-messstellen' && ebene.art === 'standort'
        ? { art: 'standort' as const, id: ebene.standort.id, name: ebene.standort.name }
        : route.page === 'standort' && route.standortBereich === 'messstellen' && standort
          ? { art: 'standort' as const, id: standort.id, name: standort.name }
          : null;

  return (
    <RechteStandort.Provider value={route.standortId ?? szene.liste.standorte.find(s => s.anlagen.some(a => a.id === site?.id))?.id ?? null}><AppShell
      teilansicht={teilansichtKopf(rollenMoment)}
      ebenen={ebenenNav}
      page={route.page}
      onNavigate={navigateSchale}
      isAdmin={false}
      showOverview={showOverviewNav(shell)}
      showPortfolio={showPortfolioNav(shell)}
      fleetLabel={FLOTTE}
      showAddAnlage={showAddAnlageButton({ ...rahmen, onboarding: false, siteCount: siteIds.length })}
      onAddAnlage={() => undefined}
      counts={{ sites: siteIds.length, devices: siteIds.length }}
      tenants={[]}
      tenantOverride={null}
      onTenantChange={() => undefined}
      anlage={
        site
          ? {
              siteId: site.id,
              siteName: site.name,
              sites,
              siteOptions: anlagenOptionen({
                sites,
                devices: { devices: [], fetchedAt: null },
                mitFlotte: sites.length > 1,
                flottenLabel: FLOTTE,
                rueckwege,
              }),
              onSelectSite: (id) => navigate(anlageRoute(id)),
              sidebar: anlageSidebar(surfaceVon(site.id), 0),
              activeKey: activeAreaKey(route.sub ?? null),
              onOpenSub: (sub) => navigate(anlageRoute(site.id, sub ?? null)),
              onOpenPage: (p) => navigate(p),
              onOpenFleet: flotte ? () => navigate(flottenLandung(shell)) : null,
              health: healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } }),
              pfad: pfad.vor.map(eintrag),
            }
          : null
      }
      ortsPfad={!site && pfad.hier ? { vor: pfad.vor.map(eintrag), hier: pfad.hier } : null}
    >
      {site && route.sub && (
        <AnlagenPage
          sites={sites}
          devices={route.sub === 'box' ? geraeteAhrenberg(new Date(Date.now())) : []}
          devicesFetchedAt={route.sub === 'box' ? Date.now() : null}
          route={route}
          onNavigate={navigate}
          onReload={() => undefined}
          surface={surfaceVon(site.id)}
          standortId={szene.liste.standorte.find((s) => s.anlagen.some((a) => a.id === site.id))?.id ?? null}
        />
      )}
      {site && !route.sub && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>{site.name}</h1>
            <p>Das Cockpit dieser Anlage bleibt unverändert — die Bühne zeigt nur Kopfzeile, Pfad und Navigation.</p>
          </div>
        </div>
      )}
      {route.page === 'standort' && standort && (
        <>
          {portfolioReiter(
            ebene.art === 'standort' ? (route.standortBereich === 'messstellen' ? 'portfolio-messstellen' : 'portfolio') : route.page,
          )}
          {standortReiter.length > 0 && (
            <EbenenTabs
              reiter={standortReiter}
              aktiv={ebenenAktiv(route.page, standortBereich)}
              leiste={leiste}
              label={`Reiter des Standorts ${standort.name}`}
              onOpen={navigate}
            />
          )}
          {!standortBereich && (
            <StandortUebersichtPage
              standort={standort}
              sites={sites}
              onNavigate={navigate}
              onReload={() => undefined}
              betriebsart="endkunde"
              einstiege={einstiege}
            />
          )}
          {standortBereich === 'boxen' && (
            <StandortBoxenPage
              key={standort.id}
              standort={standort}
              sites={sites}
              devices={geraeteAhrenberg(new Date(Date.now()))}
            />
          )}
          {standortBereich === 'gebaeude' && (
            <StandortGebaeudePage
              key={standort.id}
              standort={standort}
              onNavigate={navigate}
              // AP-13 IP-10: der Sprung ins gefilterte Register trägt seinen Filter in der Adresse (`?ort=G-2`);
              // die Bühne führt die Route in ihrem Zustand, also wird der Hash zusätzlich gesetzt — das Register
              // liest ihn beim Aufbau, wie im Portal.
              springe={(s) => {
                window.location.hash = s.hash.replace(/^#/, '');
                navigate(s.route);
              }}
            />
          )}
          {standortBereich === 'netzanschluesse' && <StandortNetzanschluessePage key={standort.id} standort={standort} onGeaendert={() => undefined} />}
          {standortBereich === 'anlagen' && (
            <StandortAnlagenPage standort={standort} sites={sites} onNavigate={navigate} onReload={() => undefined} betriebsart="endkunde" />
          )}
          {standortBereich === 'kennzahlen' && (
            <KennzahlenPage
              key={standort.id}
              standort={{ id: standort.id, name: standort.name }}
              zone={standort.zeitzone}
              kennzahlId={route.kennzahlId ?? null}
              onOeffnen={(id) => navigate(kennzahlRoute(id, standort.id))}
              onListe={() => navigate(standortBereichRoute(standort.id, 'kennzahlen'))}
            />
          )}
          {standortBereich === 'berichte' && (
            <BerichtePage
              key={standort.id}
              standort={{ id: standort.id, name: standort.name }}
              kennung={route.berichtKennung ?? null}
              onOeffnen={(kennung) => navigate(berichtRoute(kennung, standort.id))}
              onListe={() => navigate(standortBereichRoute(standort.id, 'berichte'))}
            />
          )}
        </>
      )}
      {route.page === 'portfolio-messstellen' && portfolioReiter('portfolio-messstellen')}
      {route.page === 'portfolio-standorte' && <>
        {portfolioReiter('portfolio-standorte')}
        <StandortePage />
      </>}
      {route.page === 'portfolio-bezugsgroessen' && <>
        {portfolioReiter(ansicht === 'bezugsgroessen-b' ? 'portfolio-messstellen' : 'portfolio-bezugsgroessen')}
        {ansicht === 'bezugsgroessen-b' && <div className="vp-bereich-tabs vp-bereich-tabs-dicht" role="tablist" aria-label="Messstellen"><button className="vp-bereich-tab" role="tab" aria-selected={false}>Liste</button><button className="vp-bereich-tab" role="tab" aria-selected={false}>Kostenstellen</button><button className="vp-bereich-tab" role="tab" aria-selected={false}>Prozesse</button><button className="vp-bereich-tab active" role="tab" aria-selected={true}>Bezugsgrößen<span className="vp-tab-strich" /></button></div>}
        {ebenenBereiche({ art: 'unternehmen' }, lesemodell).some(b => b.key === 'bezugsgroessen') ? <BezugsgroessenPage /> : <p>Bezugsgrößen stehen zur Verfügung, sobald ein Standort misst.</p>}
      </>}
      {route.page === 'portfolio-kennzahlen' && (
        <>
          {portfolioReiter('portfolio-kennzahlen')}
          <KennzahlenPage
            kennzahlId={route.kennzahlId ?? null}
            onOeffnen={(id) => navigate(kennzahlRoute(id))}
            onListe={() => navigate(pageRoute('portfolio-kennzahlen'))}
          />
        </>
      )}
      {route.page === 'portfolio-berichte' && (
        <>
          {portfolioReiter('portfolio-berichte')}
          <BerichtePage
            kennung={route.berichtKennung ?? null}
            onOeffnen={(kennung) => navigate(berichtRoute(kennung))}
            onListe={() => navigate(pageRoute('portfolio-berichte'))}
          />
        </>
      )}
      {messstellenEbene && (
        <MessstellenPage
          key={messstellenEbene.art === 'standort' ? messstellenEbene.id : 'unternehmen'}
          ebene={messstellenEbene}
          bereichDa={bereiche.includes('messstellen')}
          // AP-13 IP-9, wie `App.tsx`: die Reiter Kostenstellen · Prozesse nur in der Welt Messstellen des Unternehmens.
          organisation={route.page === 'portfolio-messstellen' && !(ebene.art === 'standort' && ebene.teilansicht)}
          onUebersicht={() =>
            navigate(messstellenEbene.art === 'standort' ? standortRoute(messstellenEbene.id) : pageRoute('portfolio'))
          }
          // AP-13 IP-13, wie `App.tsx`: aus dem Register führt der Weg auf die Messstellen-Seite — mit Periode.
          messstelleId={route.messstelleId ?? null}
          onOeffnen={(id) => {
            setWerte({ periode: null, version: null, vergleich: null });
            navigate(messstelleRoute(id, messstellenEbene.art === 'standort' ? messstellenEbene.id : null));
          }}
          werte={werte}
          onWerte={(id, periode) => {
            setWerte({ periode, version: null, vergleich: null });
            navigate(messstelleRoute(id, messstellenEbene.art === 'standort' ? messstellenEbene.id : null));
          }}
          // AP-13 IP-5: der Vergleich überlebt einen Zeitraum-Wechsel; die Version tut es nicht.
          onWerteZeitraum={(periode) => setWerte((w) => ({ periode, version: null, vergleich: w.vergleich }))}
          onWerteVergleich={(v) => setWerte((w) => ({ ...w, vergleich: v }))}
          onListe={() => {
            setWerte({ periode: null, version: null, vergleich: null });
            navigate(
              messstellenEbene.art === 'standort'
                ? standortMessstellenRoute(messstellenEbene.id)
                : pageRoute('portfolio-messstellen'),
            );
          }}
        />
      )}
      {route.page === 'portfolio' && (
        <>
          {portfolioReiter('portfolio')}
          <PortfolioPage
            sites={sites}
            onNavigate={navigate}
            onReload={() => setRevision((revision) => revision + 1)}
            betriebsart="endkunde"
            ebene={unternehmensEbene}
          />
        </>
      )}
    </AppShell></RechteStandort.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {rechteAnsicht ? <App initialAuth /> : <Vorschau />}
  </React.StrictMode>,
);
