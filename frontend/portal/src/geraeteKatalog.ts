/**
 * Der GERÄTEKATALOG: Hinzufügen beginnt mit dem GERÄT, nicht mit einer Art.
 *
 * Konzept „Aufbau und Gerätekatalog" (Runde 2, K1–K6 = A vom 25.09.2026). Die
 * sieben Typ-Kacheln des alten Einstiegs fragten nach etwas, das ein Kunde über
 * sein Gerät oft gar nicht weiß („Wallbox" oder „Ladesäule (OCPP)"? „Eigene
 * Batterie" oder „Eigenbau"?). Der Katalog fragt stattdessen, was auf dem
 * Typenschild steht - Marke oder Modell -, und die Art ergibt sich aus dem
 * Treffer. Die drei Wege ohne Vorlage (Ladesäule mit OCPP, Batterie mit eigenem
 * BMS, Modbus-Gerät) sind gewöhnliche Einträge; eigene Vorlagen und was die Box
 * schon meldet ebenso.
 *
 * - **K1 · Ohne Suche: Art → Marke → Modell.** 115 Wechselrichter-Modelle stehen
 *   unter ihren Marken, nicht als eine lange Liste.
 * - **K2 · Zähler ehrlich.** Der Katalog kennt (noch) keine Zähler-Vorlage; der
 *   Weg dorthin sagt das und führt über das Gerät, das am Hausanschluss misst -
 *   dieselbe Regel wie bisher (`keineVorlageHinweis`).
 * - **Suche = die vorhandene Modell-Suche** (`modellSuche`: Rang, Typenschild-
 *   Aliase, ehrlicher Deckel) - eine zweite Suche liefe auseinander.
 *
 * Rein + deterministisch: kein React, kein Netz. Die Fläche
 * (`components/GeraeteKatalog.tsx`) rendert nur, was hier entschieden wird.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { SiteComponentTemplate } from './api';
import { keineVorlageHinweis } from './anlegenFlow';
import type { AufbauBaum, AufbauGeraet, AufbauKategorie } from './aufbauBaum';
import { kommunikationsWort } from './geraetSeite';
import { modellSuche, modellZusatz, type ComponentTemplate } from './komponentenAssistent';
import { normalisiereSuche, passt, suchBegriffe } from './picker/suche';
import type { AdoptableSource } from './rollen';

export type KatalogKategorie = 'wr' | 'laden' | 'schalten' | 'batterie' | 'zaehler' | 'selbst' | 'weitere';
export type KatalogChip = 'alle' | KatalogKategorie;
export type KatalogWeg = 'ocpp' | 'bms' | 'modbus';

export const KATEGORIE_LABEL: Record<KatalogKategorie, string> = {
  wr: 'Wechselrichter',
  laden: 'Laden',
  schalten: 'Schalten',
  batterie: 'Batterie',
  zaehler: 'Zähler',
  selbst: 'Selbst beschreiben',
  weitere: 'Weitere Geräte',
};

/** Das Symbol je Art - dieselben Farben wie in der Aufbau-Tabelle. */
export const KATEGORIE_SYMBOL: Record<KatalogKategorie, { kategorie: AufbauKategorie; icon: IconName }> = {
  wr: { kategorie: 'solar', icon: 'sun' },
  laden: { kategorie: 'ev', icon: 'battery-charging' },
  schalten: { kategorie: 'home', icon: 'sliders' },
  batterie: { kategorie: 'battery', icon: 'battery' },
  zaehler: { kategorie: 'grid', icon: 'activity' },
  selbst: { kategorie: 'grid', icon: 'cpu' },
  weitere: { kategorie: 'grid', icon: 'cpu' },
};

/** Die drei Wege ohne Vorlage - im Katalog gewöhnliche Einträge. */
export const WEGE: Record<
  KatalogWeg,
  { titel: string; zusatz: string; kategorie: KatalogKategorie; stichworte: string }
> = {
  ocpp: {
    titel: 'Ladesäule mit OCPP 1.6',
    // ⚠ Die Säule meldet sich bei der Box - VoltPilot wählt sie NICHT an (die
    // alte Kachel sagte es umgekehrt).
    zusatz: 'Jede Säule, die OCPP 1.6 spricht · sie meldet sich selbst bei Ihrer Box',
    kategorie: 'laden',
    stichworte: 'ladesäule ladestation ladepunkt ocpp wallbox säule',
  },
  bms: {
    titel: 'Batterie mit eigenem BMS',
    zusatz: 'Über MQTT oder HTTP/JSON · z. B. DIYBMS, Seplos, JK',
    kategorie: 'batterie',
    stichworte: 'batterie speicher akku bms diybms seplos jk mqtt http json shunt',
  },
  modbus: {
    titel: 'Modbus-TCP-Gerät',
    zusatz: 'Selbst beschreiben: Adresse, Register, Messwerte',
    kategorie: 'selbst',
    stichworte: 'modbus tcp register eigenbau selbst sensor gerät',
  },
};

/** Was die Box meldet und noch niemand übernommen hat - für den Katalog aufbereitet. */
export interface KatalogFund {
  quelle: AdoptableSource;
  titel: string;
  unterzeile: string;
  boxName: string | null;
}

/**
 * Die Funde der GEÖFFNETEN Anlage für den Katalog - dieselben Zeilen, die die
 * Aufbau-Tabelle gestrichelt zeigt, mit der Box, die sie meldet.
 */
export function katalogFunde(baum: AufbauBaum): KatalogFund[] {
  const anlage = baum.anlagen.find((a) => a.aktuell);
  if (!anlage) return [];
  const fund = (g: AufbauGeraet, boxName: string | null): KatalogFund[] =>
    g.art === 'neu' && g.karte.quelle ? [{ quelle: g.karte.quelle, titel: g.titel, unterzeile: g.unterzeile, boxName }] : [];
  return [
    ...anlage.boxen.flatMap((b) => b.geraete.flatMap((g) => fund(g, b.name))),
    ...anlage.ohneBox.flatMap((g) => fund(g, null)),
  ];
}

export type KatalogEintrag =
  | { art: 'fund'; key: string; titel: string; zusatz: string; fund: KatalogFund }
  | { art: 'modell'; key: string; titel: string; zusatz: string; template: ComponentTemplate }
  | { art: 'marke'; key: string; titel: string; zusatz: string; marke: string; anzahl: number }
  | { art: 'weg'; key: string; titel: string; zusatz: string; weg: KatalogWeg }
  | { art: 'vorlage'; key: string; titel: string; zusatz: string; vorlage: SiteComponentTemplate };

export interface KatalogGruppe {
  key: string;
  titel: string;
  /** Eine leise Angabe rechts in der Gruppenzeile („115 Modelle"). */
  rechts: string | null;
  eintraege: KatalogEintrag[];
}

export interface KatalogAnsicht {
  gruppen: KatalogGruppe[];
  /** Ein ehrlicher Satz zur Auswahl (Zähler ohne Vorlage, Ausgänge des I/O-Moduls …). */
  hinweis: string | null;
  /** Kein Treffer: der Satz dazu; die Wege stehen dann als Vorschlag in `gruppen`. */
  leer: string | null;
  /** „12 von 47 Treffern - …" - der Deckel wird nie verschwiegen. */
  zaehler: string | null;
  /** Aus einer Marke zurück: die Beschriftung des Rückwegs; null = keiner. */
  zurueck: string | null;
  /** Zeigt der Katalog die Verwaltung eigener Vorlagen (Art „Selbst beschreiben")? */
  vorlagenVerwalten: boolean;
}

/** Was aus dem Katalog gewählt wurde - der Wirt öffnet daraufhin den passenden Weg. */
export type KatalogWahl =
  | { art: 'fund'; quelle: AdoptableSource }
  /** `rolle: 'grid-meter'` = über „Zähler" gewählt: das Gerät misst den Hausanschluss. */
  | { art: 'modell'; template: ComponentTemplate; rolle: 'grid-meter' | null }
  | { art: 'weg'; weg: KatalogWeg }
  | { art: 'vorlage'; vorlage: SiteComponentTemplate };

/**
 * Die Art einer Vorlage im Katalog - aus ihrer Gerätetyp-Dimension.
 *
 * ⚠ Eine Vorlage OHNE Typ (älterer Stand, eine von Hand eingetragene geprüfte
 * Vorlage) wird nicht einsortiert, sondern steht unter „Weitere Geräte": aus
 * „unbekannt" wird nie ein geratener Typ.
 */
export function kategorieVon(t: ComponentTemplate): KatalogKategorie {
  switch ((t.deviceType ?? '').trim()) {
    case 'inverter':
      return 'wr';
    case 'wallbox':
    case 'charge_point':
      return 'laden';
    case 'switch':
    case 'io_module':
      return 'schalten';
    case 'meter':
      return 'zaehler';
    case 'battery':
      return 'batterie';
    default:
      return 'weitere';
  }
}

/** „Deye SUN-12K-SG04LP3-EU" - die Marke nur, wenn das Modell sie nicht schon trägt. */
export function modellTitel(t: ComponentTemplate): string {
  const marke = t.brandLabel.trim();
  const modell = t.modelLabel.trim();
  if (!marke || normalisiereSuche(modell).includes(normalisiereSuche(marke))) return modell;
  return `${marke} ${modell}`;
}

/**
 * Die Unterzeile im Kopf der Einrichten-Seite: Leistung, Bauart und die
 * Anbindung in Kundenworten - gelesen, nie geraten (fehlt etwas, fehlt es).
 */
export function einrichtenUnterzeile(t: ComponentTemplate): string {
  const teile: string[] = [];
  if (typeof t.ratedKw === 'number' && Number.isFinite(t.ratedKw) && t.ratedKw > 0) {
    teile.push(`${t.ratedKw.toLocaleString('de-DE')} kW`);
  }
  const familie = (t.familyLabel ?? '').trim();
  if (familie) teile.push(familie);
  const weg = kommunikationsWort(t.communication) ?? (t.communicationLabel ?? '').trim();
  if (weg) teile.push(weg);
  return teile.join(' · ');
}

function modellEintrag(t: ComponentTemplate): KatalogEintrag {
  return { art: 'modell', key: t.templateRef, titel: modellTitel(t), zusatz: modellZusatz(t), template: t };
}

function wegEintrag(weg: KatalogWeg): KatalogEintrag {
  return { art: 'weg', key: `weg:${weg}`, titel: WEGE[weg].titel, zusatz: WEGE[weg].zusatz, weg };
}

function vorlageEintrag(v: SiteComponentTemplate): KatalogEintrag {
  const n = Array.isArray(v.channels) ? v.channels.length : null;
  return {
    art: 'vorlage',
    key: `vorlage:${v.templateRef}`,
    titel: v.label,
    zusatz: ['Eigene Vorlage · Modbus-TCP', n != null ? `${n} ${n === 1 ? 'Messwert' : 'Messwerte'}` : null]
      .filter(Boolean)
      .join(' · '),
    vorlage: v,
  };
}

function fundEintrag(f: KatalogFund): KatalogEintrag {
  return {
    art: 'fund',
    key: `fund:${f.quelle.id}`,
    titel: f.titel,
    zusatz: [f.boxName ? `${f.boxName} meldet es` : 'Von Ihrer Box gemeldet', f.unterzeile].filter(Boolean).join(' · '),
    fund: f,
  };
}

const deutsch = (a: string, b: string) => a.localeCompare(b, 'de');

/** Die Marken einer Auswahl, je mit Zahl und Anbindung in Kundenworten. */
export function markenEintraege(templates: ComponentTemplate[]): KatalogEintrag[] {
  const jeMarke = new Map<string, ComponentTemplate[]>();
  for (const t of templates) {
    const liste = jeMarke.get(t.brand) ?? [];
    liste.push(t);
    jeMarke.set(t.brand, liste);
  }
  return [...jeMarke.entries()]
    .map(([marke, liste]) => {
      const wege = [...new Set(liste.map((t) => kommunikationsWort(t.communication) ?? t.communicationLabel))];
      const n = liste.length;
      return {
        art: 'marke' as const,
        key: `marke:${marke}`,
        titel: liste[0].brandLabel,
        zusatz: `${n} ${n === 1 ? 'Modell' : 'Modelle'} · ${wege.length === 1 ? wege[0] : 'verschiedene Anschlüsse'}`,
        marke,
        anzahl: n,
      };
    })
    .sort((a, b) => deutsch(a.titel, b.titel));
}

export interface KatalogChipInfo {
  id: KatalogChip;
  label: string;
  /** Wie viele Einträge dahinter stehen; null = keine Zahl (Alle, Zähler ohne Vorlage). */
  anzahl: number | null;
}

/** Die Arten als Filter über dem Katalog - mit ihrer Zahl, „Weitere" nur, wenn es welche gibt. */
export function katalogChips(templates: ComponentTemplate[], vorlagen: SiteComponentTemplate[]): KatalogChipInfo[] {
  const zahl = (k: KatalogKategorie) => templates.filter((t) => kategorieVon(t) === k).length;
  const zaehler = zahl('zaehler');
  const chips: KatalogChipInfo[] = [
    { id: 'alle', label: 'Alle', anzahl: null },
    { id: 'wr', label: KATEGORIE_LABEL.wr, anzahl: zahl('wr') },
    { id: 'laden', label: KATEGORIE_LABEL.laden, anzahl: zahl('laden') + 1 },
    { id: 'schalten', label: KATEGORIE_LABEL.schalten, anzahl: zahl('schalten') },
    { id: 'batterie', label: KATEGORIE_LABEL.batterie, anzahl: zahl('batterie') + 1 },
    { id: 'zaehler', label: KATEGORIE_LABEL.zaehler, anzahl: zaehler > 0 ? zaehler : null },
    { id: 'selbst', label: KATEGORIE_LABEL.selbst, anzahl: 1 + vorlagen.length },
  ];
  const weitere = zahl('weitere');
  if (weitere > 0) chips.push({ id: 'weitere', label: KATEGORIE_LABEL.weitere, anzahl: weitere });
  return chips;
}

export interface KatalogEingabe {
  templates: ComponentTemplate[];
  vorlagen: SiteComponentTemplate[];
  funde: KatalogFund[];
  q: string;
  chip: KatalogChip;
  /** Die aufgeklappte Marke (Art → Marke → Modell); null = keine. */
  marke: string | null;
}

const ORDNUNG: KatalogKategorie[] = ['wr', 'laden', 'schalten', 'batterie', 'zaehler', 'selbst', 'weitere'];

/** Die Wege einer Art (Laden → Ladesäule mit OCPP …). */
function wegeFuer(k: KatalogKategorie): KatalogWeg[] {
  return (Object.keys(WEGE) as KatalogWeg[]).filter((w) => WEGE[w].kategorie === k);
}

function gruppe(key: string, titel: string, eintraege: KatalogEintrag[], rechts: string | null = null): KatalogGruppe[] {
  return eintraege.length > 0 ? [{ key, titel, rechts, eintraege }] : [];
}

function leereAnsicht(): KatalogAnsicht {
  return { gruppen: [], hinweis: null, leer: null, zaehler: null, zurueck: null, vorlagenVerwalten: false };
}

/** Die Ansicht des Katalogs für Suche, Art und Marke. */
export function katalogAnsicht(e: KatalogEingabe): KatalogAnsicht {
  const out = leereAnsicht();
  const begriffe = suchBegriffe(e.q);
  const inArt = (k: KatalogKategorie) => e.chip === 'alle' || e.chip === k;
  const zaehlerVorlagen = e.templates.filter((t) => kategorieVon(t) === 'zaehler');

  if (begriffe.length > 0) {
    // --- Suche: über alles, was die gewählte Art zulässt -------------------
    if (e.chip === 'alle') {
      out.gruppen.push(
        ...gruppe(
          'gemeldet',
          'Von Ihrer Box gemeldet',
          e.funde
            .filter((f) =>
              passt(normalisiereSuche(`${f.titel} ${f.unterzeile} ${f.quelle.brand ?? ''} ${f.quelle.model ?? ''}`), begriffe),
            )
            .map(fundEintrag),
        ),
      );
    }
    if (inArt('selbst')) {
      out.gruppen.push(
        ...gruppe(
          'vorlagen',
          'Eigene Vorlagen',
          e.vorlagen.filter((v) => passt(normalisiereSuche(`${v.label} ${v.note ?? ''}`), begriffe)).map(vorlageEintrag),
        ),
      );
    }
    // Über „Zähler" sucht man das Gerät, ÜBER das gemessen wird - also in allem.
    const suchraum =
      e.chip === 'alle' || (e.chip === 'zaehler' && zaehlerVorlagen.length === 0)
        ? e.templates
        : e.templates.filter((t) => kategorieVon(t) === e.chip);
    const suche = modellSuche(suchraum, e.q);
    const wegTreffer = (Object.keys(WEGE) as KatalogWeg[]).filter(
      (w) => inArt(WEGE[w].kategorie) && passt(normalisiereSuche(`${WEGE[w].titel} ${WEGE[w].zusatz} ${WEGE[w].stichworte}`), begriffe),
    );
    if (e.chip === 'zaehler' && zaehlerVorlagen.length === 0) {
      // Ohne Zähler-Vorlage sucht man das Gerät, das am Hausanschluss misst (K2).
      out.hinweis = keineVorlageHinweis('zaehler');
      out.gruppen.push(
        ...gruppe('zaehler', 'Gerät wählen, über das gemessen wird', suche.treffer.map((t) => modellEintrag(t.template))),
      );
    } else {
      for (const k of ORDNUNG) {
        const modelle = suche.treffer.map((t) => t.template).filter((t) => kategorieVon(t) === k);
        const eintraege = [...modelle.map(modellEintrag), ...wegTreffer.filter((w) => WEGE[w].kategorie === k).map(wegEintrag)];
        out.gruppen.push(...gruppe(k, KATEGORIE_LABEL[k], eintraege));
      }
    }
    if (suche.gesamt > suche.treffer.length) out.zaehler = suche.zaehler;
    if (out.gruppen.length === 0) {
      out.leer =
        `Kein Eintrag passt zu „${e.q.trim()}". Oft reicht ein Teil des Namens, zum Beispiel „12K". `
        + 'Oder ist es eines davon?';
      out.gruppen.push(...gruppe('wege', 'Passende Wege', (Object.keys(WEGE) as KatalogWeg[]).map(wegEintrag)));
    }
    return out;
  }

  // --- Eine Marke aufgeklappt: ihre Modelle ---------------------------------
  if (e.marke) {
    const raum =
      e.chip === 'zaehler' || e.chip === 'alle' ? e.templates : e.templates.filter((t) => kategorieVon(t) === e.chip);
    const modelle = raum
      .filter((t) => t.brand === e.marke)
      .sort((a, b) => deutsch(a.modelLabel, b.modelLabel));
    const titel = modelle[0]?.brandLabel ?? e.marke;
    out.gruppen.push(...gruppe(`marke:${e.marke}`, titel, modelle.map(modellEintrag), `${modelle.length} ${modelle.length === 1 ? 'Modell' : 'Modelle'}`));
    out.zurueck = e.chip === 'alle' ? 'Alle Geräte' : KATEGORIE_LABEL[e.chip];
    if (e.chip === 'zaehler' && zaehlerVorlagen.length === 0) out.hinweis = keineVorlageHinweis('zaehler');
    return out;
  }

  // --- Blättern nach Art ------------------------------------------------------
  const vonArt = (k: KatalogKategorie) => e.templates.filter((t) => kategorieVon(t) === k);
  const modelleUndWege = (k: KatalogKategorie) => [
    ...vonArt(k).sort((a, b) => deutsch(modellTitel(a), modellTitel(b))).map(modellEintrag),
    ...wegeFuer(k).map(wegEintrag),
  ];
  const wr = vonArt('wr');
  switch (e.chip) {
    case 'alle':
      out.gruppen.push(
        ...gruppe('gemeldet', 'Von Ihrer Box gemeldet', e.funde.map(fundEintrag), 'schon eingerichtet'),
        ...gruppe('wr', KATEGORIE_LABEL.wr, markenEintraege(wr), `${wr.length} ${wr.length === 1 ? 'Modell' : 'Modelle'}`),
        ...gruppe('laden', KATEGORIE_LABEL.laden, modelleUndWege('laden')),
        ...gruppe('schalten', KATEGORIE_LABEL.schalten, modelleUndWege('schalten')),
        ...gruppe('batterie', KATEGORIE_LABEL.batterie, modelleUndWege('batterie')),
        ...gruppe('zaehler', KATEGORIE_LABEL.zaehler, modelleUndWege('zaehler')),
        ...gruppe('selbst', KATEGORIE_LABEL.selbst, [wegEintrag('modbus'), ...e.vorlagen.map(vorlageEintrag)]),
        ...gruppe('weitere', KATEGORIE_LABEL.weitere, modelleUndWege('weitere')),
      );
      // Kein Hinweis-Kasten über allem: wer „Zähler" wählt, liest dort ehrlich,
      // wie es ohne eigene Zähler-Vorlage geht (K2).
      return out;
    case 'wr':
      out.gruppen.push(...gruppe('wr', 'Wechselrichter nach Marke', markenEintraege(wr), `${wr.length} ${wr.length === 1 ? 'Modell' : 'Modelle'}`));
      return out;
    case 'zaehler':
      if (zaehlerVorlagen.length > 0) {
        out.gruppen.push(...gruppe('zaehler', KATEGORIE_LABEL.zaehler, modelleUndWege('zaehler')));
        return out;
      }
      out.hinweis = keineVorlageHinweis('zaehler');
      out.gruppen.push(...gruppe('zaehler', 'Gerät wählen, über das gemessen wird', markenEintraege(e.templates)));
      return out;
    case 'laden':
      out.gruppen.push(...gruppe('laden', KATEGORIE_LABEL.laden, modelleUndWege('laden')));
      out.hinweis =
        'Eine Wallbox mit Vorlage liest VoltPilot über ihre Schnittstelle. Eine Ladesäule mit OCPP meldet '
        + 'sich selbst bei Ihrer Box; Sie geben sie nur frei.';
      return out;
    case 'schalten':
      out.gruppen.push(...gruppe('schalten', KATEGORIE_LABEL.schalten, modelleUndWege('schalten')));
      if (vonArt('schalten').some((t) => (t.deviceType ?? '') === 'io_module')) {
        out.hinweis = 'Beim I/O-Modul ordnen Sie danach jeden Ausgang einem Verbraucher zu.';
      }
      return out;
    case 'batterie':
      out.gruppen.push(...gruppe('batterie', KATEGORIE_LABEL.batterie, modelleUndWege('batterie')));
      if (vonArt('batterie').length === 0) {
        out.hinweis =
          'Fertige Batterie-Modelle gibt es im Katalog noch nicht. Einen Speicher am Hybrid-Wechselrichter '
          + 'richten Sie über den Wechselrichter ein.';
      }
      return out;
    case 'selbst':
      out.gruppen.push(...gruppe('selbst', KATEGORIE_LABEL.selbst, [wegEintrag('modbus')]));
      out.vorlagenVerwalten = true;
      return out;
    default:
      out.gruppen.push(...gruppe(e.chip, KATEGORIE_LABEL[e.chip], modelleUndWege(e.chip)));
      return out;
  }
}

/** Die Wahl eines Eintrags - `null` bei einer Marke (sie klappt nur auf). */
export function wahlFuer(eintrag: KatalogEintrag, chip: KatalogChip): KatalogWahl | null {
  switch (eintrag.art) {
    case 'fund':
      return { art: 'fund', quelle: eintrag.fund.quelle };
    case 'modell':
      return {
        art: 'modell',
        template: eintrag.template,
        // Über „Zähler" gewählt, misst das Gerät den Hausanschluss (K2) - es sei
        // denn, es IST eine Zähler-Vorlage; dann ergibt sich die Rolle ohnehin.
        rolle: chip === 'zaehler' ? 'grid-meter' : null,
      };
    case 'weg':
      return { art: 'weg', weg: eintrag.weg };
    case 'vorlage':
      return { art: 'vorlage', vorlage: eintrag.vorlage };
    default:
      return null;
  }
}
