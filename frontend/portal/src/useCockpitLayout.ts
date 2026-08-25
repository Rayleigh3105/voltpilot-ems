import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CockpitLayoutResponse } from './api';
import {
  CANONICAL_DESKTOP,
  CANONICAL_PHONE,
  anpassenDokument,
  anpassenZeilen,
  eigeneAusSchichten,
  layoutResolve,
  mitEigenen,
  resetZiel,
  verschiebe,
  vorgabeBand,
  type AnpassenZeile,
  type BausteinId,
  type CockpitLayoutLayer,
  type Flaeche,
  type LayoutDocument,
  type ResolvedLayout,
} from './cockpitLayout';
import { neuerSchluessel, type EigeneAuswertungDef } from './eigeneAuswertung';
import type { CockpitBlock, CockpitBlockId } from './surface';

/**
 * Der Zustand des Cockpit-Layouts (Anwendungs-Programm Stufe 3): das Laden der
 * Schichten, die Auflösung und der Anpassen-Modus — an EINER Stelle, damit
 * `AnlagenPage` nur noch rendert.
 *
 * **Alles Rechnende liegt in `cockpitLayout.ts`** (rein, Docker-frei getestet);
 * dieser Haken hält Zustand und ruft die zwei Routen.
 *
 * ## Fail-soft ist hier tragend
 *
 * Ein älteres Backend (die Route gibt es nicht) und ein Netzfehler führen zu
 * `layers = null` — und damit zur Auflösung OHNE gespeicherte Schicht, also
 * zum deterministischen Katalog-Standard. Das ist Zeichen für Zeichen das
 * Verhalten vor dieser Stufe: das Cockpit darf an seinem Layout-Speicher nie
 * scheitern.
 */
export interface CockpitLayoutState<T extends string = BausteinId> {
  /** Die wirksame Anordnung — was gerendert wird. */
  resolved: ResolvedLayout<T>;
  /** Läuft der Anpassen-Modus gerade? */
  anpassen: boolean;
  /** Die Zeilen des Anpassen-Modus (leer, solange er nicht läuft). */
  zeilen: AnpassenZeile<T>[];
  /** Der Satz, den der Reset-Knopf ansagt (E2). */
  resetSatz: string;
  /** Das Admin-Band „Sie gestalten die Vorgabe für …"; null = Kunde. */
  band: string | null;
  /** Der Vorgabe-Schalter (nur Portal-Admin), sonst null. */
  alsVorgabe: boolean | null;
  dirty: boolean;
  saving: boolean;
  fehler: string | null;
  start: () => void;
  abbrechen: () => void;
  fertig: () => void;
  zuruecksetzen: () => void;
  setAlsVorgabe: (value: boolean) => void;
  verschieben: (id: T, richtung: 'hoch' | 'runter') => void;
  setSichtbar: (id: T, sichtbar: boolean) => void;
  setLead: (block: CockpitBlockId) => void;
  /**
   * Die eigenen Auswertungen (Stufe 5) — im Anpassen-Modus der ENTWURF, sonst
   * das Gespeicherte. Die Fläche rendert daraus ihre Kacheln.
   */
  eigene: EigeneAuswertungDef[];
  /** Legt eine an bzw. ersetzt sie (ohne Schlüssel = neu). */
  setzeEigene: (def: Omit<EigeneAuswertungDef, 'id'> & { id?: string | null }) => void;
  /** Entfernt eine — samt ihrer Spur in Reihenfolge und Ausgeblendet. */
  entferneEigene: (id: string) => void;
  /**
   * Die GESPEICHERTEN eigenen Auswertungen — im Anpassen-Modus kann `eigene`
   * bereits eine neue enthalten, die der Server noch nicht kennt. Die Fläche
   * braucht den Unterschied, um „noch nicht gespeichert" von „keine Messwerte"
   * zu unterscheiden.
   */
  eigeneGespeichert: EigeneAuswertungDef[];
}

/**
 * Die drei Aufrufe EINER Fläche. Sie sind ein Parameter, damit es genau EINEN
 * Anpassen-Modus gibt: das Anlagen-Cockpit hängt an `/sites/{id}/cockpit-layout`,
 * das Portfolio-Cockpit an `/tenant/cockpit-layout?surface=portfolio` — die
 * Zustandsführung, die Auflösung und die Bedienung sind dieselben.
 */
export interface LayoutQuelleApi {
  laden: () => Promise<CockpitLayoutResponse>;
  speichern: (
    layer: CockpitLayoutLayer,
    document: LayoutDocument,
  ) => Promise<CockpitLayoutResponse>;
  zuruecksetzen: (layer: CockpitLayoutLayer) => Promise<CockpitLayoutResponse>;
}

interface UseCockpitLayoutInput<T extends string = BausteinId> {
  /** Der Schlüssel, bei dessen Wechsel neu geladen wird (Anlage bzw. Fläche). */
  schluessel: string;
  /** Welche Fläche aufgelöst wird — sie wählt die Preset-Schicht. */
  flaeche?: Flaeche;
  /** Die Bausteine, die diese Fläche GERADE hat. */
  verfuegbar: readonly T[];
  /** Die kanonische Reihenfolge; ohne sie entscheidet `isPhone` am Cockpit. */
  canonical?: readonly T[];
  /** Die Blöcke der Projektion (M0) — sie entscheiden über den Lead. */
  blocks?: CockpitBlock[] | null;
  isPhone?: boolean;
  /** Der Kundenname für das Admin-Band; null = Kunde selbst. */
  kunde?: string | null;
  /** Woher die Schichten kommen; ohne Angabe die Anlagen-Route. */
  quelle?: LayoutQuelleApi;
  /** Die Anlage — nur für die Vorgabe-Route der Anlagen-Fläche. */
  siteId?: string;
  /**
   * Ist die Anwendung „Eigene Auswertung" auf dieser Anlage eingeschaltet?
   * Vorgabe `true`, damit jeder bestehende Aufrufer zeichengleich bleibt.
   *
   * ⚠ Sie steuert nur die SICHTBARKEIT. Die Definitionen reisen auch bei
   * `false` in jedes gespeicherte Dokument mit — sonst löschte ein Speichern
   * bei abgeschalteter Anwendung genau das, was ein Wiedereinschalten
   * zurückbringen soll (die tragende Regel der Stufe 3: „seine Präferenz
   * bleibt gespeichert").
   */
  eigeneAktiv?: boolean;
}

function docOf(layer: { document: LayoutDocument } | null | undefined): LayoutDocument | null {
  return layer?.document ?? null;
}

export function useCockpitLayout<T extends string = BausteinId>(
  input: UseCockpitLayoutInput<T>,
): CockpitLayoutState<T> {
  const { schluessel, verfuegbar, blocks, isPhone } = input;
  const flaeche: Flaeche = input.flaeche ?? 'cockpit';
  const [layers, setLayers] = useState<CockpitLayoutResponse | null>(null);
  const [anpassen, setAnpassen] = useState(false);
  const [entwurf, setEntwurf] = useState<{
    arrangement: T[];
    hidden: T[];
    lead: CockpitBlockId | null;
    eigene: EigeneAuswertungDef[];
  } | null>(null);
  const [alsVorgabe, setAlsVorgabe] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  // Die Aufrufe wandern über eine Referenz in den Effekt: sie sind bei jedem
  // Rendern neu, der Nachlade-Effekt hängt aber am SCHLÜSSEL — sonst lüde die
  // Fläche in einer Schleife.
  const siteId = input.siteId;
  const quelle: LayoutQuelleApi = input.quelle ?? {
    laden: () => api.cockpitLayout(siteId as string),
    speichern: (layer, document) => api.saveCockpitLayout(siteId as string, layer, document),
    zuruecksetzen: (layer) => api.resetCockpitLayout(siteId as string, layer),
  };
  const quelleRef = useRef(quelle);
  quelleRef.current = quelle;

  useEffect(() => {
    let active = true;
    quelleRef.current.laden().then(
      (r) => {
        if (active) setLayers(r);
      },
      () => {
        // Fail-soft: ohne Antwort gilt der Katalog-Standard (siehe Kopf).
        if (active) setLayers(null);
      },
    );
    return () => {
      active = false;
    };
  }, [schluessel]);

  /**
   * Die eigenen Auswertungen ALLER Schichten (Stufe 5), `eigen` gewinnt — die
   * Definitionen sind das, was eine Kachel überhaupt erst zu einem Baustein
   * macht.
   */
  const gespeicherteEigene = useMemo(
    () =>
      eigeneAusSchichten({
        tenantVorgabe: docOf(layers?.tenantVorgabe),
        siteVorgabe: docOf(layers?.siteVorgabe),
        eigen: docOf(layers?.eigen),
      }),
    [layers],
  );
  /** ALLE Definitionen — sie wandern immer mit ins gespeicherte Dokument. */
  const alleEigene = anpassen && entwurf ? entwurf.eigene : gespeicherteEigene;
  /** Nur die SICHTBAREN — ist die Anwendung aus, rendert keine. */
  const eigene = input.eigeneAktiv === false ? [] : alleEigene;

  /**
   * ⚠ Die kanonische Liste UND die verfügbare Menge tragen die eigenen
   * Auswertungen mit: ohne sie fielen sie beim Auflösen als „hat diese Anlage
   * nicht" heraus und wären unsichtbar, obwohl der Kunde sie angelegt hat.
   */
  const canonical: readonly T[] = useMemo(() => {
    const basis =
      input.canonical ??
      ((isPhone ? CANONICAL_PHONE : CANONICAL_DESKTOP) as unknown as readonly T[]);
    return mitEigenen<T>(basis, eigene);
  }, [input.canonical, isPhone, eigene]);
  const verfuegbarMitEigenen = useMemo<readonly T[]>(
    () => [...verfuegbar, ...eigene.map((d) => d.id as T)],
    [verfuegbar, eigene],
  );
  const gespeichert = useMemo(
    () =>
      layoutResolve<T>({
        canonical,
        verfuegbar: verfuegbarMitEigenen,
        blocks,
        flaeche,
        profil: layers?.profil ?? null,
        tenantVorgabe: docOf(layers?.tenantVorgabe),
        siteVorgabe: docOf(layers?.siteVorgabe),
        eigen: docOf(layers?.eigen),
      }),
    [canonical, verfuegbarMitEigenen, blocks, layers, flaeche],
  );

  /**
   * Was die Schichten UNTER „eigen" ausblenden würden — der Kunde muss eine
   * Vorgabe seines Betreibers zurücknehmen können (`shown`), sonst wäre sie
   * eine Sperre, und genau die gibt es in V1 nicht (E2).
   */
  const geerbtVersteckt = useMemo(
    () =>
      layoutResolve<T>({
        canonical,
        verfuegbar: verfuegbarMitEigenen,
        blocks,
        flaeche,
        profil: layers?.profil ?? null,
        tenantVorgabe: docOf(layers?.tenantVorgabe),
        siteVorgabe: docOf(layers?.siteVorgabe),
      }).hidden,
    [canonical, verfuegbarMitEigenen, blocks, layers, flaeche],
  );

  // Im Anpassen-Modus gilt der Entwurf, sonst das Gespeicherte.
  const resolved: ResolvedLayout<T> = useMemo(() => {
    if (!anpassen || !entwurf) return gespeichert;
    const hidden = new Set<string>(entwurf.hidden);
    return {
      order: entwurf.arrangement.filter((id) => !hidden.has(id)),
      arrangement: entwurf.arrangement,
      hidden: entwurf.arrangement.filter((id) => hidden.has(id)),
      lead: entwurf.lead,
      quelle: gespeichert.quelle,
    };
  }, [anpassen, entwurf, gespeichert]);

  const start = useCallback(() => {
    setEntwurf({
      arrangement: [...gespeichert.arrangement],
      hidden: [...gespeichert.hidden],
      lead: gespeichert.lead,
      eigene: [...gespeicherteEigene],
    });
    setAlsVorgabe(layers?.darfVorgabe === true);
    setFehler(null);
    setAnpassen(true);
  }, [gespeichert, gespeicherteEigene, layers]);

  const abbrechen = useCallback(() => {
    setAnpassen(false);
    setEntwurf(null);
    setFehler(null);
  }, []);

  const verschieben = useCallback((id: T, richtung: 'hoch' | 'runter') => {
    setEntwurf((e) => (e ? { ...e, arrangement: verschiebe<T>(e.arrangement, id, richtung) } : e));
  }, []);

  const setSichtbar = useCallback((id: T, sichtbar: boolean) => {
    setEntwurf((e) => {
      if (!e) return e;
      const hidden = sichtbar ? e.hidden.filter((h) => h !== id) : [...e.hidden, id];
      return { ...e, hidden };
    });
  }, []);

  /**
   * Der Stern ist ein SCHALTER: ein zweiter Klick nimmt die Hervorhebung
   * zurück und überlässt sie wieder der M0-Regel (peak → Geld → Fluss). Ohne
   * den Rückweg käme ein Kunde, der einmal umgestellt hat, nur über
   * „Zurücksetzen" zurück — und das verwürfe auch seine Reihenfolge.
   */
  const setLead = useCallback((block: CockpitBlockId) => {
    setEntwurf((e) => (e ? { ...e, lead: e.lead === block ? null : block } : e));
  }, []);

  /**
   * Legt eine eigene Auswertung an oder ersetzt sie. Eine NEUE erscheint sofort
   * an ihrer kanonischen Stelle (hinter den Kennzahlen) — sie hinten anzuhängen
   * wäre dieselbe Unart, die die Auflösung für jeden anderen Baustein vermeidet.
   */
  const setzeEigene = useCallback(
    (def: Omit<EigeneAuswertungDef, 'id'> & { id?: string | null }) => {
      setEntwurf((e) => {
        if (!e) return e;
        // ⚠ Der Schlüssel entsteht IM Updater, nicht in der Closure: sonst
        // vergäbe ein zweites Anlegen im selben Render denselben — und zwei
        // Kacheln unter einem Schlüssel sind zwei Wahrheiten über eine.
        const id = def.id ?? neuerSchluessel(e.eigene.map((d) => d.id));
        const vorhanden = e.eigene.some((d) => d.id === id);
        const eigeneNeu = vorhanden
          ? e.eigene.map((d) => (d.id === id ? { ...def, id } : d))
          : [...e.eigene, { ...def, id }];
        if (vorhanden) return { ...e, eigene: eigeneNeu };
        // Neu: an ihre kanonische Stelle, nicht ans Ende.
        const arrangement = mitEigenen<T>(
          e.arrangement.filter((b) => !eigeneNeu.some((d) => d.id === b)),
          eigeneNeu,
        );
        return { ...e, eigene: eigeneNeu, arrangement };
      });
    },
    [],
  );

  /**
   * Entfernt eine eigene Auswertung SAMT ihrer Spur: bliebe ihr Schlüssel in
   * `order` oder `hidden` stehen, lehnte der Server das ganze Dokument ab — zu
   * Recht, denn niemand könnte ihn rendern.
   */
  const entferneEigene = useCallback((id: string) => {
    setEntwurf((e) =>
      e
        ? {
            ...e,
            eigene: e.eigene.filter((d) => d.id !== id),
            arrangement: e.arrangement.filter((b) => b !== (id as T)),
            hidden: e.hidden.filter((b) => b !== (id as T)),
          }
        : e,
    );
  }, []);

  const speichern = useCallback(
    async (document: LayoutDocument | null) => {
      setSaving(true);
      setFehler(null);
      const layer = alsVorgabe && layers?.darfVorgabe ? 'vorgabe' : 'eigen';
      try {
        const next =
          document == null
            ? await quelleRef.current.zuruecksetzen(layer)
            : await quelleRef.current.speichern(layer, document);
        setLayers(next);
        setAnpassen(false);
        setEntwurf(null);
      } catch (e) {
        // Der deutsche Grund des Servers gewinnt; er benennt genau, was an dem
        // Dokument nicht ging (unbekannter Baustein, Pflicht-Baustein, Recht).
        setFehler(
          e instanceof Error && e.message
            ? e.message
            : 'Ihre Anordnung konnte gerade nicht gespeichert werden.',
        );
      } finally {
        setSaving(false);
      }
    },
    [alsVorgabe, layers],
  );

  const fertig = useCallback(() => {
    if (!entwurf) {
      setAnpassen(false);
      return;
    }
    void speichern(
      anpassenDokument({
        arrangement: entwurf.arrangement,
        hidden: entwurf.hidden,
        lead: entwurf.lead,
        geerbtVersteckt,
        // ⚠ ALLE, nicht nur die sichtbaren: ein Speichern bei abgeschalteter
        // Anwendung darf die Definitionen nicht verlieren.
        eigene: entwurf.eigene,
      }),
    );
  }, [entwurf, geerbtVersteckt, speichern]);

  const zuruecksetzen = useCallback(() => {
    void speichern(null);
  }, [speichern]);

  const dirty = useMemo(() => {
    if (!entwurf) return false;
    return (
      entwurf.arrangement.join('|') !== gespeichert.arrangement.join('|') ||
      [...entwurf.hidden].sort().join('|') !== [...gespeichert.hidden].sort().join('|') ||
      entwurf.lead !== gespeichert.lead ||
      JSON.stringify(entwurf.eigene) !== JSON.stringify(gespeicherteEigene)
    );
  }, [entwurf, gespeichert, gespeicherteEigene]);

  const ziel = resetZiel({
    tenantVorgabe: docOf(layers?.tenantVorgabe),
    siteVorgabe: docOf(layers?.siteVorgabe),
    profil: layers?.profil ?? null,
    flaeche,
  });

  return {
    resolved,
    anpassen,
    zeilen: anpassen ? anpassenZeilen<T>({ ...resolved, eigene }) : [],
    resetSatz: ziel.satz,
    band: layers?.darfVorgabe && alsVorgabe ? vorgabeBand(input.kunde) : null,
    alsVorgabe: layers?.darfVorgabe ? alsVorgabe : null,
    dirty,
    saving,
    fehler,
    start,
    abbrechen,
    fertig,
    zuruecksetzen,
    setAlsVorgabe,
    verschieben,
    setSichtbar,
    setLead,
    eigene,
    setzeEigene,
    entferneEigene,
    eigeneGespeichert: gespeicherteEigene,
  };
}
