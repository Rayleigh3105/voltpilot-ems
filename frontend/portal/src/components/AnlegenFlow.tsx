import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpPicker } from './VpPicker';
import type { VpOption } from '../picker/optionen';
import {
  api,
  ApiError,
  type ComponentTemplate,
  type Device,
  type SiteComponents,
  type SiteComponentTemplate,
  type SiteComponentRow,
} from '../api';
import { AnlegenDialog } from './AnlegenDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { CenteredConfirmDialog } from './CenteredConfirmDialog';
import { SelbstbauAssistent } from './SelbstbauAssistent';
import { LadesaeuleAnbinden } from './LadesaeuleAnbinden';
import { HEBEL_HINWEIS, HEBEL_INTRO, SKALIERUNG_X10, hebel } from '../testHebel';
import { komponenteHash } from '../nav';
// Das Bauteil bringt sein Stylesheet SELBST mit (die RegelKarten-Lehre): sich
// auf den Import des Wirts zu verlassen liefert einem zweiten Wirt einen
// ungestylten Fluss.
import './KomponenteAssistent.css';
import './AnlegenFlow.css';
import * as socSchaetzung from '../socSchaetzung';
import {
  ABSCHLUSS_HINWEIS,
  bilanzHinweis,
  fehlendeFelder,
  felder,
  initialeVerbindung,
  modellZusatz,
  nameHilfe,
  pruefen,
  testErgebnis,
  uebernahmeHinweis,
  type ComponentMatch,
  type KomponentenRolle,
  type TemplateField,
  type TestErgebnis,
  type TestOverride,
  type TestZustand,
} from '../komponentenAssistent';
import {
  ABSPRUNG_LABEL,
  DIALOG_TITEL,
  WEITERES_LABEL,
  abschlussTitel,
  feldGruppen,
  geraeteFuerTyp,
  legtAn,
  neueKomponente,
  rollenWahl,
  schritte as schritteFuer,
  typKarten,
  vorschlagRolle,
  type TypId,
} from '../anlegenFlow';
import {
  GESPERRTE_FELDER,
  auswirkungen,
  brauchtVerbindungstest,
  delta,
  istSecret,
  kundenRolle,
  normalisiereSecretEingabe,
  verbindungFuerSpeichern,
} from '../geraeteEdit';
import { registerNavigationBlocker, type BlockedNavigation } from '../navigationBlocker';

function typFuerRolle(rolle: KomponentenRolle): TypId {
  if (rolle === 'consumer') return 'verbraucher';
  if (rolle === 'grid-meter') return 'zaehler';
  return 'wechselrichter';
}

/**
 * Der NEUE ANLEGE-FLUSS (Anlegen-Rework Stufe 2, Konzept
 * `data/vp-anlegen-rework/konzept.md`).
 *
 * Fünf Schritte im zentrierten Dialog (Rechner) bzw. als Vollbild-Schrittfolge
 * (Telefon): **Was anbinden** (Typ-Karten) → **Gerät wählen** (VpPicker-Suche)
 * → **Verbinden** (Felder je Anbindung, Experten-Angaben unter „Erweitert") →
 * **Testen** (ehrlicher Befund + Hebel + „Trotzdem fortfahren") → **Fertig**.
 *
 * <b>⚠ Die Anlege-SEMANTIK ist unverändert.</b> Dieselben Aufrufe mit denselben
 * Rümpfen (`testComponentConnection` → `matchComponent` → `createComponent`),
 * dieselbe Verbindungstest-Pflicht, dieselbe Übernahme-Entscheidung auf dem
 * SERVER. Was sich ändert, ist die Reihenfolge der Fragen und die Fläche.
 *
 * Diese Datei RENDERT nur; jede Regel kommt aus den reinen `anlegenFlow.ts`,
 * `komponentenAssistent.ts` und `testHebel.ts`.
 */
export function AnlegenFlow({
  siteId,
  box,
  vorlage,
  initialTyp,
  initialRolle,
  bearbeiten,
  inlineBearbeitung = false,
  siteName,
  geraetKennung,
  onClose,
  onSaved,
}: {
  siteId: string;
  /**
   * Die Box dieser Anlage - nur die Ladesäulen-Karte braucht sie: sie kennt
   * ihre eigene Adresse (D5), und daraus entsteht der `ws://`-Endpunkt. Ohne
   * sie nennt der Assistent ehrlich den Weg statt eine Adresse zu behaupten.
   */
  box?: Device;
  /**
   * Einheitsmodell Stufe 6: aus einer EIGENEN Vorlage ein Gerät machen. Mit
   * ihr startet der Fluss direkt im Eigenbau-Weg, vorbefüllt - die Typ-Wahl
   * wäre dann eine Frage, die der Kunde schon beantwortet hat.
   */
  vorlage?: SiteComponentTemplate | null;
  /**
   * Ein freier elektrischer Platz hat die Typfrage bereits beantwortet. Der
   * Assistent beginnt dann in Schritt 2; „Zurück" führt weiterhin in die
   * vollständige Typauswahl. Keine Anlege-Semantik ändert sich dadurch.
   */
  initialTyp?: TypId | null;
  /**
   * Elektrische Absicht eines konkreten Anlagenbild-Slots. Sie bleibt eine
   * vorhandene Backend-Rolle (z. B. `inverter` für den Speicherpfad), keine
   * neue Topologiebehauptung.
   */
  initialRolle?: KomponentenRolle | null;
  /** Bestehende stabile Komponente: derselbe Assistent, mit ihren Sollwerten. */
  bearbeiten?: SiteComponentRow | null;
  /**
   * Auf der Geräteseite wird eine bestehende Komponente direkt IM SEITENKONTEXT
   * bearbeitet. Der Anlege-Dialog bleibt ausschließlich dem Anlegen und den
   * älteren Einstiegen vorbehalten.
   */
  inlineBearbeitung?: boolean;
  /** Lesbarer Standort und stabile Gerätekennung für die Inline-Identität. */
  siteName?: string;
  geraetKennung?: string | null;
  onClose: () => void;
  onSaved: (result: SiteComponents) => void;
}) {
  const [templates, setTemplates] = useState<ComponentTemplate[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const edit = bearbeiten ?? null;
  const [typ, setTyp] = useState<TypId | null>(
    vorlage ? 'eigenbau' : (edit ? typFuerRolle(kundenRolle(edit)) : (initialTyp ?? null)),
  );
  const [schritt, setSchritt] = useState(vorlage || initialTyp || edit ? 2 : 1);
  const [rolle, setRolle] = useState<KomponentenRolle | null>(() =>
    edit ? kundenRolle(edit) : initialTyp ? vorschlagRolle(initialTyp, [], initialRolle) : null,
  );
  const [template, setTemplate] = useState<ComponentTemplate | null>(null);
  const [templateVersion, setTemplateVersion] = useState<number | null>(
    edit?.templateVersion ?? null,
  );
  const [verbindung, setVerbindung] = useState<Record<string, unknown>>(
    () => ({ ...(edit?.connection ?? {}) }),
  );
  const [erweitertOffen, setErweitertOffen] = useState(false);
  const [technikOffen, setTechnikOffen] = useState(false);
  const [testZustand, setTestZustand] = useState<TestZustand>('ungeprueft');
  const [testText, setTestText] = useState<TestErgebnis | null>(null);
  /**
   * Der abgenickte Kanal („Trotzdem fortfahren (nur Lesen)"). Er reist beim
   * Speichern mit und NENNT den Kanal - der Server prüft, dass genau dieser
   * auch der fehlende war.
   */
  const [ohneKanal, setOhneKanal] = useState<TestOverride | null>(null);
  const [fragOhneKanal, setFragOhneKanal] = useState(false);
  /**
   * Die zwei Eckpunkte des Speichers für die Ladestand-SCHÄTZUNG. Sie leben
   * bewusst HIER - im Ausweg-Bereich, der nur bei „das BMS meldet nichts"
   * erscheint - und nicht als reguläres Verbindungsfeld: eine Anlage mit
   * funktionierendem BMS soll gar nicht erst auf die Idee kommen (dieselbe
   * Zurückhaltung, aus der `allow_missing_soc` kein `:8484`-Feld hat).
   */
  const [socVolt, setSocVolt] = useState(socSchaetzung.leereEingabe());
  /**
   * ⚠ Ob die Schätzung ANGEBOTEN wird, hängt am Befund - und den entwertet jede
   * Eingabe, denn die Eckpunkte gehören zur Verbindung. Ohne dieses eigene
   * Merkmal verschwänden die Felder beim ersten Tastendruck. Es hält also die
   * FRAGE fest („diese Anlage meldet keinen Ladestand"), nicht die Antwort -
   * deshalb wird es nur mit dem Formular zurückgesetzt, nie durch einen Test.
   */
  const [socAngeboten, setSocAngeboten] = useState(false);
  const [name, setName] = useState(edit?.label ?? '');
  const [kwp, setKwp] = useState(edit?.capacityKwp == null ? '' : String(edit.capacityKwp));
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [vorhandene, setVorhandene] = useState<string[]>([]);
  const [vorherigeIds, setVorherigeIds] = useState<{ id: string }[]>([]);
  /** Die Komponente, die gerade entstanden ist - BELEGT, nie geraten. */
  const [neueId, setNeueId] = useState<string | null>(null);
  const [uebernommen, setUebernommen] = useState(false);
  const [gespeichert, setGespeichert] = useState<SiteComponents | null>(null);
  /**
   * Die vorhandene Komponente, die dieses Gerät übernimmt - VOM SERVER, nie
   * hier abgeleitet (Alias-Kontinuität). `null` = es entsteht eine neue.
   */
  const [uebernahme, setUebernahme] = useState<ComponentMatch | null>(null);
  const [fragVerwerfen, setFragVerwerfen] = useState(false);
  const [fragRollenwechsel, setFragRollenwechsel] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<BlockedNavigation | null>(null);
  /** Der Fuß-Platz, in den der Selbstbau-Assistent seine Bedienzeile rendert. */
  const [fussEl, setFussEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    api.componentTemplates().then(async (list) => {
      if (!alive) return;
      if (!edit?.templateRef || list.some((item) => item.templateRef === edit.templateRef)) {
        setTemplates(list);
        return;
      }
      try {
        const current = await api.componentTemplate(edit.templateRef);
        if (alive) setTemplates([...list, current]);
      } catch {
        if (alive) {
          setTemplates(list);
          setLadeFehler('Die bisherige Gerätevorlage konnte nicht geladen werden. Die gespeicherte Fassung bleibt aktiv.');
        }
      }
    }).catch(() => alive && setLadeFehler('Die Geräte-Auswahl konnte nicht geladen werden.'));
    api
      .siteComponents(siteId)
      .then((c) => {
        if (!alive) return;
        const rollen = c.components.filter((r) => r.id !== edit?.id).map((r) => r.role ?? '');
        setVorhandene(rollen);
        if (initialTyp) {
          setRolle((aktuell) => {
            const bleibtGueltig = rollenWahl(initialTyp, rollen).some(
              (wahl) => wahl.rolle === aktuell && wahl.verfuegbar,
            );
            return bleibtGueltig
              ? aktuell
              : vorschlagRolle(initialTyp, rollen, initialRolle);
          });
        }
        setVorherigeIds(c.components.map((r) => ({ id: r.id })));
      })
      .catch(() => {
        /* Die Rollen-Vorprüfung ist Komfort; der Server prüft ohnehin. */
      });
    return () => {
      alive = false;
    };
  }, [edit?.id, initialRolle, initialTyp, siteId]);

  useEffect(() => {
    if (!edit || !templates || template) return;
    const found = templates.find((t) => t.templateRef === edit.templateRef) ?? null;
    if (!found) {
      setLadeFehler('Die bisherige Gerätevorlage ist nicht mehr auswählbar. Die gespeicherte Fassung bleibt aktiv.');
      return;
    }
    setTemplate(found);
    setTemplateVersion(edit.templateVersion ?? found.version);
  }, [edit, template, templates]);

  const alle = useMemo(() => templates ?? [], [templates]);
  const karten = useMemo(() => typKarten(alle), [alle]);
  const auswahl = useMemo(
    () => (typ ? geraeteFuerTyp(alle, typ) : { templates: [], erweitert: false }),
    [alle, typ],
  );
  const rollen = typ ? rollenWahl(typ, vorhandene) : [];
  const schritte = schritteFuer(typ);

  /**
   * Die Picker-Zeilen: EINE Zeile je Modell, gruppiert nach Marke. Die
   * Nebenzeile ist `modellZusatz` (Leistung · Bauart · Anbindung), Familie und
   * Modellcode reisen als unsichtbare Stichwörter mit - so findet die Suche
   * „SG02" auch dort, wo es im Namen gar nicht steht.
   */
  const modellOptionen = useMemo<VpOption[]>(
    () =>
      auswahl.templates.map((t) => ({
        value: t.templateRef,
        label: t.modelLabel,
        sub: modellZusatz(t) || null,
        group: t.brand,
        disabled: Boolean(edit && t.templateRef === edit.templateRef && t.supersededBy),
        disabledHint: edit && t.templateRef === edit.templateRef && t.supersededBy
          ? 'Bisherige Vorlage – bleibt für dieses Gerät aktiv.'
          : null,
        keywords: [t.model, t.family ?? '', t.familyLabel ?? '', t.communicationLabel ?? ''].join(
          ' ',
        ),
      })),
    [auswahl.templates],
  );
  const modellGruppen = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of auswahl.templates) if (!seen.has(t.brand)) seen.set(t.brand, t.brandLabel);
    return [...seen.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }, [auswahl.templates]);

  const fields = felder(template);
  const gruppen = feldGruppen<TemplateField>(fields);
  const kwpWert = kwp.trim() === '' ? null : Number(kwp);
  const kwpUngueltig = rolle === 'pv-generation'
    && kwpWert !== null
    && (!Number.isFinite(kwpWert) || kwpWert <= 0);
  const testNoetig = edit
    ? brauchtVerbindungstest(edit, template, templateVersion, verbindung)
    : true;
  const fehlend = edit && !testNoetig ? [] : fehlendeFelder(template, verbindung);
  const aenderungen = edit && template && rolle
    ? delta(edit, template, templateVersion, rolle, name, verbindung, kwp)
    : [];
  const einfachGeaendert = Boolean(edit && (
    (edit.label?.trim() || '') !== name.trim()
    || kundenRolle(edit) !== rolle
    || (edit.capacityKwp ?? null) !== kwpWert
  ));
  const hatAenderungen = Boolean(edit && (aenderungen.length > 0 || einfachGeaendert));
  const rollenwechsel = aenderungen.some((row) => row.feld === 'Elektrische Rolle');
  const technischeAenderung = aenderungen.some((row) => ![
    'Anzeigename', 'Nennleistung', 'Elektrische Rolle',
  ].includes(row.feld));
  const editorBusy = speichern || testZustand === 'laeuft';
  // ⚠ Die HEBEL entstehen aus BELEGEN (Server-Fehlerklasse + Befund) und aus
  // dem, was die Vorlage strukturell hergibt - nie aus einer eigenen Diagnose
  // der gelesenen Zahlen. Die ganze Regel liegt rein in `testHebel.ts`.
  const hebelListe = hebel({ ergebnis: testText, template, templates, verbindung });

  /*
   * Inline heißt: dieselbe ROUTE bleibt sichtbar. Normale Link-Navigation und
   * ein echtes Neuladen dürfen geänderte Eingaben trotzdem nicht lautlos
   * verlieren. Der Link wird erst nach der bewussten Verwerfen-Bestätigung
   * ausgeführt; Browser-Schließen nutzt den nativen Schutzdialog.
   */
  useEffect(() => {
    if (!inlineBearbeitung || !hatAenderungen) return undefined;
    const vorVerlassen = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const unregister = registerNavigationBlocker((navigation) => {
      if (speichern) return;
      setPendingNavigation(navigation);
      setFragVerwerfen(true);
    });
    window.addEventListener('beforeunload', vorVerlassen);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', vorVerlassen);
    };
  }, [hatAenderungen, inlineBearbeitung, speichern]);

  /**
   * Der Test läuft beim BETRETEN des Schritts „Testen" von selbst an - der
   * Schritt heißt so, weil er testet. Ein Knopf davor wäre eine zweite Hürde
   * vor derselben Handlung; „Erneut testen" steht danebe für den zweiten Anlauf.
   */
  const laeuft = useRef(false);
  useEffect(() => {
    if (schritt !== 4 || typ === 'eigenbau' || typ === 'ladesaeule') return;
    if (!template || !testNoetig || testZustand !== 'ungeprueft' || laeuft.current) return;
    void testen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, template, testNoetig, testZustand, typ]);

  function waehleTyp(id: TypId) {
    setTyp(id);
    setRolle(vorschlagRolle(id, vorhandene));
    setTemplate(null);
    setTemplateVersion(null);
    setSchritt(2);
  }

  function waehleTemplate(ref: string) {
    const t = auswahl.templates.find((x) => x.templateRef === ref);
    if (!t) return;
    if (template?.templateRef === t.templateRef) return;
    setTemplate(t);
    setTemplateVersion(t.version);
    const istBisherige = edit?.templateRef === t.templateRef;
    setVerbindung(istBisherige ? { ...(edit.connection ?? {}) } : initialeVerbindung(t));
    setSocVolt(socSchaetzung.leereEingabe());
    setSocAngeboten(false);
    // ⚠ NICHT mit dem Modellnamen vorbefüllen (Alias-Kontinuität, Live-Fall
    // Herzogau 20.08.2026): ein vorbefülltes Feld wird mitgeschickt und
    // überschreibt beim Übernehmen den Namen, den der Kunde vergeben hat.
    if (!edit) setName('');
    setUebernahme(null);
    setTestZustand('ungeprueft');
    setTestText(null);
    setOhneKanal(null);
  }

  /**
   * Die Eckpunkte gehören IN die Verbindung: sie reisen zur Box, und der Beleg
   * des Verbindungstests keyt auf die ganze Verbindung. Deshalb entwerten sie
   * den Test wie jedes andere Feld - was hier kein Reibungspunkt ist, sondern
   * der Weg: erst der erneute Test zeigt, was aus DIESEN Werten geschätzt wird.
   */
  function setzeSocVolt(next: socSchaetzung.SocVoltageEingabe) {
    setSocVolt(next);
    const wert = socSchaetzung.verbindungsWert(next);
    setVerbindung((v) => {
      const out = { ...v };
      if (wert) out[socSchaetzung.SOC_VOLTAGE_KEY] = wert;
      else delete out[socSchaetzung.SOC_VOLTAGE_KEY];
      return out;
    });
    setTestZustand('ungeprueft');
    setTestText(null);
    setOhneKanal(null);
  }

  function setzeFeld(field: TemplateField, value: unknown) {
    const normalized = normalisiereSecretEingabe(
      field,
      value,
      edit?.connection?.[field.key],
    );
    setVerbindung((v) => ({ ...v, [field.key]: normalized }));
    // Jede Änderung entwertet den Beleg - genau das ist der Sinn der Pflicht.
    setTestZustand('ungeprueft');
    setTestText(null);
    // ... und damit auch die Ausnahme: sie galt GENAU dieser Verbindung.
    setOhneKanal(null);
    // ⚠ Und den ÜBERNAHME-Vorschlag: eine andere Adresse ist ein anderes Gerät.
    setUebernahme(null);
  }

  /**
   * Ein Hebel-Klick. ⚠ Er ÄNDERT so wenig wie möglich: die Adress-Hebel
   * springen ihr Feld nur AN (der Mensch weiß, was dort stehen muss, VoltPilot
   * nicht), und nur die Skalierung setzt wirklich einen Wert - sie hat genau
   * eine sinnvolle Alternative.
   */
  function hebelKlick(h: { id: string; feld: string | null }) {
    if (h.id === 'modell') {
      if (inlineBearbeitung) {
        setTechnikOffen(true);
        window.setTimeout(() => document.getElementById('anlegen-modell')?.focus(), 0);
        return;
      }
      // Zurück zur Modellwahl. Der Picker öffnet auf dem GEWÄHLTEN Modell,
      // seine Marken-Gruppe steht damit im Bild.
      setSchritt(2);
      return;
    }
    if (!h.feld) return;
    if (h.id === 'skalierung') {
      const f = fields.find((x) => x.key === h.feld);
      if (f) setzeFeld(f, SKALIERUNG_X10);
    }
    // ⚠ Das Feld liegt eine Ebene zurück - und womöglich unter „Erweitert".
    // Ein Sprung ins Eingeklappte wäre ein Klick ins Unsichtbare.
    if (inlineBearbeitung) setTechnikOffen(true);
    else setSchritt(3);
    if (gruppen.erweitert.some((f) => f.key === h.feld)) setErweitertOffen(true);
    window.setTimeout(() => {
      const el = document.getElementById(`anlegen-${h.feld}`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
      }
    }, 0);
  }

  async function testen() {
    if (!template) return;
    laeuft.current = true;
    setTestZustand('laeuft');
    setTestText(null);
    // Ein neuer Lauf beantwortet die Frage neu - eine Ausnahme aus dem vorigen
    // gilt nicht weiter.
    setOhneKanal(null);
    try {
      const antwort = await api.testComponentConnection(siteId, {
        templateRef: template.templateRef,
        templateVersion: templateVersion ?? undefined,
        role: rolle ?? undefined,
        connection: verbindungFuerSpeichern(template, verbindung),
        entityId: edit?.id,
      });
      const ergebnis = testErgebnis(antwort);
      setTestText(ergebnis);
      setTestZustand(ergebnis.zustand);
      if (ergebnis.override?.channel === 'soc_pct') setSocAngeboten(true);
      if (ergebnis.zustand === 'bestanden') void frageUebernahme();
    } catch (e) {
      setTestZustand('fehlgeschlagen');
      setTestText({
        zustand: 'fehlgeschlagen',
        text: e instanceof ApiError ? e.message : 'Die Prüfung ist fehlgeschlagen.',
        messwerte: [],
      });
    } finally {
      laeuft.current = false;
    }
  }

  /**
   * Fragen, ob dieses Gerät schon eine Komponente hat - sobald die Verbindung
   * BELEGT steht (nach dem bestandenen Test). Fehlschlag = kein Vorschlag
   * (fail-soft): ein älteres Backend kennt die Route nicht, und ohne Vorschlag
   * verhält sich der Fluss exakt wie vorher.
   */
  async function frageUebernahme() {
    if (!template || !rolle) return;
    try {
      const hit = await api.matchComponent(siteId, {
        templateRef: template.templateRef,
        role: rolle,
        connection: verbindungFuerSpeichern(template, verbindung),
      });
      setUebernahme(hit ?? null);
    } catch {
      setUebernahme(null);
    }
  }

  async function anlegen() {
    if (!template || !rolle || speichern) return;
    if (kwpUngueltig) {
      setFehler('Geben Sie eine gültige Leistung größer als 0 kWp ein.');
      if (inlineBearbeitung) fokussiere('anlegen-kwp');
      return;
    }
    setSpeichern(true);
    setFehler(null);
    try {
      const body = {
        templateRef: template.templateRef,
        templateVersion: templateVersion ?? undefined,
        label: edit ? name.trim() : (name.trim() || undefined),
        role: rolle,
        connection: verbindungFuerSpeichern(template, verbindung),
        capacityKwp: rolle === 'pv-generation' && kwpWert !== null ? kwpWert : undefined,
        acceptMissingChannel: ohneKanal?.channel,
        expectedRevision: edit?.definitionVersion,
        effectiveAt: edit ? new Date().toISOString() : undefined,
      };
      const result = edit
        ? await api.updateComponent(siteId, edit.id, body)
        : await api.createComponent(siteId, body);
      setNeueId(edit?.id ?? neueKomponente(vorherigeIds, result.components, uebernahme?.entityId));
      setUebernommen(Boolean(uebernahme) || Boolean(edit));
      setVorherigeIds(result.components.map((r) => ({ id: r.id })));
      setVorhandene(result.components.map((r) => r.role ?? ''));
      setSchritt(5);
      setGespeichert(result);
      onSaved(result);
    } catch (e) {
      setFehler(e instanceof ApiError
        ? e.message
        : typeof navigator !== 'undefined' && !navigator.onLine
          ? 'Keine Verbindung. Ihre Eingaben bleiben erhalten — versuchen Sie es wieder, sobald Sie online sind.'
          : 'Speichern ist fehlgeschlagen. Ihre Eingaben bleiben erhalten; versuchen Sie es erneut.');
    } finally {
      setSpeichern(false);
    }
  }

  function fokussiere(id: string) {
    window.setTimeout(() => {
      const ziel = document.getElementById(id);
      ziel?.scrollIntoView({ block: 'center' });
      ziel?.focus();
    }, 0);
  }

  /** Der Inline-Speicherweg erklärt jede Sperre an der betroffenen Stelle. */
  function inlineSpeichern() {
    if (speichern) return;
    setFehler(null);
    if (!template || !rolle) {
      setFehler('Die Gerätevorlage wird noch geladen oder ist nicht mehr verfügbar. Ihre Eingaben bleiben erhalten.');
      return;
    }
    if (kwpUngueltig) {
      setFehler('Geben Sie eine gültige Leistung größer als 0 kWp ein.');
      fokussiere('anlegen-kwp');
      return;
    }
    if (fehlend.length > 0) {
      setTechnikOffen(true);
      setFehler(`Für die Verbindung fehlt noch: ${fehlend.map((field) => field.label).join(', ')}.`);
      fokussiere(`anlegen-${fehlend[0].key}`);
      return;
    }
    if (testNoetig && testZustand !== 'bestanden' && !ohneKanal) {
      setTechnikOffen(true);
      setFehler('Prüfen Sie die geänderte Verbindung, bevor Sie speichern.');
      fokussiere('geraet-edit-test');
      return;
    }
    if (rollenwechsel) {
      setFragRollenwechsel(true);
      return;
    }
    void anlegen();
  }

  function inlineSchliessen() {
    if (speichern) return;
    setPendingNavigation(null);
    if (hatAenderungen) setFragVerwerfen(true);
    else onClose();
  }

  function verwerfen() {
    if (speichern) return;
    const navigation = pendingNavigation;
    setFragVerwerfen(false);
    setPendingNavigation(null);
    onClose();
    if (navigation) window.setTimeout(navigation.resume, 0);
  }

  /** Ein zweiter Durchlauf, ohne den Dialog zu schließen. */
  function nochEins() {
    setTyp(null);
    setSchritt(1);
    setRolle(null);
    setTemplate(null);
    setTemplateVersion(null);
    setVerbindung({});
    setSocVolt(socSchaetzung.leereEingabe());
    setSocAngeboten(false);
    setErweitertOffen(false);
    setTestZustand('ungeprueft');
    setTestText(null);
    setOhneKanal(null);
    setName('');
    setKwp('');
    setFehler(null);
    setNeueId(null);
    setUebernommen(false);
    setUebernahme(null);
  }

  function zurueck() {
    if (schritt <= 1) return;
    setSchritt(schritt - 1);
  }

  const selbstbauSchritt = Math.min(Math.max(schritt - 1, 1), 4) as 1 | 2 | 3 | 4;

  /** Die Bedienzeile am Fuß - je Schritt genau die zwei Wege, die es gibt. */
  // Die Ladesäulen-Karte legt nichts an - sie hat deshalb keinen „Fertig".
  const istFertig =
    typ !== null && legtAn(typ) && schritt === (typ === 'eigenbau' ? 6 : 5);

  function fuss() {
    if (istFertig) {
      return (
        <>
          <Button variant="ghost" onClick={nochEins}>
            {WEITERES_LABEL}
          </Button>
          {neueId ? (
            <Button
              onClick={() => {
                window.location.hash = komponenteHash(siteId, neueId);
                onClose();
              }}
            >
              {ABSPRUNG_LABEL}
            </Button>
          ) : (
            <Button onClick={onClose}>Schließen</Button>
          )}
        </>
      );
    }
    if (typ === 'eigenbau') {
      /*
        Der Selbstbau-Assistent BEHÄLT seine Bedienzeile (nur er weiß, wann
        „Weiter" freigibt) - sie wird hier nur hineingerendert, damit auch
        dieser Weg am Telefon eine klebende Fußzeile hat.
      */
      return <div className="vp-anlegen-navslot" ref={setFussEl} />;
    }
    if (typ === 'ladesaeule') {
      return (
        <>
          <Button variant="ghost" onClick={zurueck}>
            Zurück
          </Button>
          <Button onClick={onClose}>Fertig</Button>
        </>
      );
    }
    if (schritt === 2) {
      return (
        <>
          <Button variant="ghost" onClick={zurueck}>
            Zurück
          </Button>
          <Button onClick={() => setSchritt(3)} disabled={!template}>
            Weiter
          </Button>
        </>
      );
    }
    if (schritt === 3) {
      return (
        <>
          <Button variant="ghost" onClick={zurueck}>
            Zurück
          </Button>
          <Button onClick={() => setSchritt(4)} disabled={fehlend.length > 0}>
            Weiter
          </Button>
        </>
      );
    }
    if (schritt === 4) {
      return (
        <>
          <Button variant="ghost" onClick={zurueck}>
            Zurück
          </Button>
          <Button
            onClick={anlegen}
            disabled={speichern || (testNoetig && testZustand !== 'bestanden' && !ohneKanal)
              || !rolle || (Boolean(edit) && aenderungen.length === 0)}
          >
            {speichern ? 'Speichere …' : edit ? 'Änderungen speichern' : 'Komponente anlegen'}
          </Button>
        </>
      );
    }
    return null;
  }

  /*
   * BESTEHENDES Gerät auf seiner EIGENEN Seite: kein Portal, kein Scrim, keine
   * künstliche Schrittzahl. Die seltene Technik bleibt vollständig erhalten,
   * wird aber erst auf Wunsch sichtbar. Alle Zustands- und Speicherregeln oben
   * sind dieselben wie im bisherigen Assistenten.
   */
  if (edit && inlineBearbeitung) {
    const modell = template
      ? `${template.brandLabel} ${template.modelLabel}`.trim()
      : [edit.brand, edit.model].filter(Boolean).join(' ') || 'Technische Angaben werden geladen';
    const technikText = [modell, template?.communicationLabel ?? edit.communication]
      .filter(Boolean).join(' · ');
    const nurName = aenderungen.length === 1 && aenderungen[0].feld === 'Anzeigename';

    return (
      <section className="vp-geraet-edit" data-testid="geraet-bearbeiten" aria-busy={speichern}>
        <header className="vp-geraet-edit-head">
          <div>
            <p className="vp-geraet-edit-eyebrow">Bearbeitungsmodus</p>
            <h1>{edit.label?.trim() || modell || 'Gerät'} bearbeiten</h1>
            <p>Allgemeine Angaben können Sie direkt speichern. Technische Änderungen werden vorher geprüft.</p>
          </div>
          <span className="vp-pill vp-pill-info">Fassung {edit.definitionVersion}</span>
        </header>

        {ladeFehler && <p className="vp-assist-error" role="alert">{ladeFehler}</p>}

        <div className="vp-geraet-edit-grid">
          <section className="vp-geraet-edit-card" aria-labelledby="geraet-edit-allgemein">
            <div className="vp-geraet-edit-cardhead">
              <div>
                <h2 id="geraet-edit-allgemein">Allgemeine Angaben</h2>
                <p>Diese Angaben benötigen keinen Verbindungstest.</p>
              </div>
            </div>
            <div className="vp-assist-field">
              <label htmlFor="anlegen-name">Anzeigename</label>
              <Input
                id="anlegen-name"
                value={name}
                placeholder={template?.modelLabel ?? edit.model ?? 'Gerät'}
                onChange={(event) => setName(event.target.value)}
                disabled={editorBusy}
                autoFocus
              />
              <p className="vp-assist-help">So erscheint das Gerät in Ihrer Anlage.</p>
            </div>

            {rollen.length > 1 ? (
              <div className="vp-geraet-edit-role">
                <span id="geraet-edit-rolle">Aufgabe in der Anlage</span>
                <div className="vp-assist-roles" role="radiogroup" aria-labelledby="geraet-edit-rolle">
                  {rollen.map((wahl) => (
                    <button
                      key={wahl.rolle}
                      type="button"
                      role="radio"
                      aria-checked={rolle === wahl.rolle}
                      className={`vp-assist-role${rolle === wahl.rolle ? ' is-on' : ''}${wahl.verfuegbar ? '' : ' is-soon'}`}
                      disabled={editorBusy || !wahl.verfuegbar}
                      onClick={() => setRolle(wahl.rolle)}
                    >
                      <strong>{wahl.label}</strong>
                      <span>{wahl.hint}</span>
                      {!wahl.verfuegbar && wahl.grund && <em className="vp-assist-soon">{wahl.grund}</em>}
                    </button>
                  ))}
                </div>
              </div>
            ) : rollen.length === 1 ? (
              <div className="vp-geraet-edit-static">
                <span>Aufgabe in der Anlage</span>
                <strong>{rollen[0].label}</strong>
                <small>{rollen[0].hint}</small>
              </div>
            ) : null}

            {rolle === 'pv-generation' && (
              <div className="vp-assist-field">
                <label htmlFor="anlegen-kwp">Nennleistung (kWp)</label>
                <Input
                  id="anlegen-kwp"
                  type="number"
                  inputMode="decimal"
                  value={kwp}
                  onChange={(event) => setKwp(event.target.value)}
                  disabled={editorBusy}
                />
                <p className="vp-assist-help">Optional – sie zählt zur Gesamtleistung Ihrer Anlage.</p>
              </div>
            )}
          </section>

          <aside className="vp-geraet-edit-card vp-geraet-edit-identity" aria-labelledby="geraet-edit-identitaet">
            <div className="vp-geraet-edit-cardhead">
              <div>
                <h2 id="geraet-edit-identitaet">Geräteidentität</h2>
                <p>Beim Verbinden festgelegt und hier bewusst nur lesbar.</p>
              </div>
            </div>
            <dl>
              <div><dt>Geräte-ID</dt><dd className="vp-mono">{geraetKennung || edit.edgeSourceId || edit.id}</dd></div>
              <div><dt>Standort</dt><dd>{siteName || 'Dieser Standort'}<small>Feste Zuordnung</small></dd></div>
            </dl>
          </aside>
        </div>

        <section className={`vp-geraet-edit-card vp-geraet-edit-technik${technikOffen ? ' is-open' : ''}`} aria-labelledby="geraet-edit-technik">
          <div className="vp-geraet-edit-techhead">
            <div>
              <h2 id="geraet-edit-technik">Verbindung &amp; Modell</h2>
              <p>{technikText}</p>
            </div>
            <Button
              variant="outline"
              aria-expanded={technikOffen}
              aria-controls="geraet-edit-technik-inhalt"
              onClick={() => setTechnikOffen((offen) => !offen)}
              disabled={editorBusy}
            >
              {technikOffen ? 'Technische Daten schließen' : 'Technische Daten ändern'}
            </Button>
          </div>

          {technikOffen && (
            <div id="geraet-edit-technik-inhalt" className="vp-geraet-edit-techbody">
              <div className="vp-assist-pick">
                <VpPicker
                  id="anlegen-modell"
                  label="Hersteller und Modell"
                  options={modellOptionen}
                  groups={modellGruppen}
                  value={template?.templateRef ?? null}
                  onChange={waehleTemplate}
                  disabled={editorBusy}
                  placeholder="Marke und Modell wählen …"
                  searchPlaceholder="Marke oder Modell suchen"
                  search="immer"
                  emptyText={(query) => `Keine Vorlage passt zu „${query}“.`}
                  hint="Eine Modelländerung kann Decoder, Register und Bilanz beeinflussen."
                />
              </div>

              {template && (
                <>
                  {gruppen.pflicht.map((field) => (
                    <Feld key={field.key} feld={field} wert={verbindung[field.key]} onChange={setzeFeld} disabled={editorBusy} />
                  ))}
                  {gruppen.erweitert.length > 0 && (
                    <details
                      className="vp-anlegen-erweitert"
                      open={erweitertOffen}
                      onToggle={(event) => setErweitertOffen(event.currentTarget.open)}
                    >
                      <summary>Erweiterte Verbindungsdaten</summary>
                      <p className="vp-assist-help">Ändern Sie diese Vorgaben nur, wenn Ihr Gerät es verlangt.</p>
                      {gruppen.erweitert.map((field) => (
                        <Feld key={field.key} feld={field} wert={verbindung[field.key]} onChange={setzeFeld} disabled={editorBusy} />
                      ))}
                    </details>
                  )}
                </>
              )}

              {fehlend.length > 0 && (
                <p className="vp-assist-warn">Noch erforderlich: {fehlend.map((field) => field.label).join(', ')}</p>
              )}

              <div className="vp-geraet-edit-test" aria-labelledby="geraet-edit-test-titel">
                <div>
                  <h3 id="geraet-edit-test-titel">Verbindung prüfen</h3>
                  <p>
                    {testNoetig
                      ? 'Technische Änderungen werden erst nach einem erfolgreichen Test gespeichert.'
                      : 'Verbindung und Modell sind unverändert – kein neuer Test nötig.'}
                  </p>
                </div>

                {!testNoetig && (
                  <p className="vp-assist-ok" role="status"><Icon name="check" size={16} /> Kein Verbindungstest erforderlich.</p>
                )}
                {testNoetig && testZustand === 'laeuft' && <p role="status">Prüfe Verbindung …</p>}
                {testText && (
                  <div className={testText.zustand === 'bestanden' ? 'vp-assist-ok' : 'vp-assist-error'} role="status">
                    <p>{testText.text}</p>
                    {testText.regelText && <p className="vp-assist-regel">{testText.regelText}</p>}
                    {testText.messwerte.length > 0 && (
                      <ul className="vp-assist-readings">
                        {testText.messwerte.map((messwert) => (
                          <li key={messwert.label}><span>{messwert.label}</span><strong>{messwert.wert}</strong></li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {testNoetig && testZustand !== 'laeuft' && (
                  <Button id="geraet-edit-test" variant="outline" onClick={testen} disabled={editorBusy || fehlend.length > 0 || !template}>
                    {testZustand === 'ungeprueft' ? 'Verbindung prüfen' : 'Erneut prüfen'}
                  </Button>
                )}

                {hebelListe.length > 0 && (
                  <div className="vp-assist-hebel" data-testid="test-hebel">
                    <p className="vp-assist-hebel-intro">{HEBEL_INTRO}</p>
                    <ul>
                      {hebelListe.map((item) => (
                        <li key={item.id}>
                          <div><strong>{item.titel}</strong><span>{item.satz}</span></div>
                          <Button variant="outline" size="sm" onClick={() => hebelKlick(item)} disabled={editorBusy}>{item.aktion}</Button>
                        </li>
                      ))}
                    </ul>
                    <p className="vp-assist-hebel-note">{HEBEL_HINWEIS}</p>
                  </div>
                )}

                {socAngeboten && (
                  <div className="vp-assist-socvolt" data-testid="soc-schaetzung">
                    <strong>{socSchaetzung.SOC_VOLTAGE_TITEL}</strong>
                    <p className="vp-assist-help">{socSchaetzung.SOC_VOLTAGE_INTRO}</p>
                    {socSchaetzung.SOC_VOLTAGE_FELDER.map((field) => (
                      <div className="vp-assist-field" key={field.id}>
                        <label htmlFor={field.id}>{field.label}</label>
                        <Input
                          id={field.id}
                          inputMode="decimal"
                          value={socVolt[field.key]}
                          placeholder={field.platzhalter}
                          onChange={(event) => setzeSocVolt({ ...socVolt, [field.key]: event.target.value })}
                          disabled={editorBusy}
                        />
                        <p className="vp-assist-help">{field.hilfe}</p>
                      </div>
                    ))}
                    {socSchaetzung.fehler(socVolt) && <p className="vp-assist-warn">{socSchaetzung.fehler(socVolt)}</p>}
                    {socSchaetzung.schaetzungSatz(testText?.befund) && (
                      <p className="vp-assist-uebernahme">{socSchaetzung.schaetzungSatz(testText?.befund)}</p>
                    )}
                    <ul className="vp-assist-folgen">{socSchaetzung.SOC_VOLTAGE_FOLGEN.map((line) => <li key={line}>{line}</li>)}</ul>
                  </div>
                )}

                {testZustand === 'fehlgeschlagen' && testText?.override && !ohneKanal && (
                  <Button variant="outline" onClick={() => setFragOhneKanal(true)} disabled={editorBusy}>{testText.override.label}</Button>
                )}
                {ohneKanal && (
                  <p className="vp-assist-uebernahme" data-testid="override-aktiv">
                    Sie fahren ohne diesen Messkanal fort. Alle anderen Messwerte laufen normal; die davon abhängige Steuerung bleibt aus.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {aenderungen.length > 0 && !nurName && (
          <section className="vp-geraet-edit-card vp-geraet-edit-review" aria-labelledby="geraet-edit-pruefen">
            <div className="vp-geraet-edit-cardhead">
              <div><h2 id="geraet-edit-pruefen">Änderungen und Auswirkungen</h2><p>Es wird eine neue Fassung angelegt; die Geräteidentität und Historie bleiben erhalten.</p></div>
            </div>
            <dl className="vp-edit-delta" aria-label="Änderungen">
              {aenderungen.map((row) => (
                <div key={row.feld}><dt>{row.feld}</dt><dd><del>{row.vorher}</del><span aria-hidden="true">→</span><ins>{row.nachher}</ins></dd></div>
              ))}
            </dl>
            <div className="vp-edit-effects"><strong>Auswirkungen</strong><ul>{auswirkungen(aenderungen).map((line) => <li key={line}>{line}</li>)}</ul></div>
          </section>
        )}

        {fehler && <p className="vp-assist-error vp-geraet-edit-error" role="alert">{fehler}</p>}

        <div className="vp-geraet-edit-actions">
          <p aria-live="polite">
            {hatAenderungen
              ? `${aenderungen.length || 1} ${aenderungen.length === 1 ? 'Änderung' : 'Änderungen'} bereit`
              : 'Noch keine Änderung'}
            {technischeAenderung && testNoetig ? ' · Verbindungstest erforderlich' : ''}
          </p>
          <div>
            <Button variant="ghost" onClick={inlineSchliessen} disabled={speichern}>Abbrechen</Button>
            <Button onClick={inlineSpeichern} disabled={speichern || !hatAenderungen}>
              {speichern ? 'Speichere …' : 'Änderungen speichern'}
            </Button>
          </div>
        </div>

        <CenteredConfirmDialog
          open={fragVerwerfen}
          title="Änderungen verwerfen?"
          intro="Ihre Eingaben wurden noch nicht gespeichert."
          consequences={['Alle Änderungen in diesem Bearbeitungsmodus gehen verloren.', 'Die aktuell aktive Gerätefassung bleibt unverändert.']}
          confirmLabel="Änderungen verwerfen"
          tone="danger"
          busy={speichern}
          onCancel={() => { setFragVerwerfen(false); setPendingNavigation(null); }}
          onConfirm={verwerfen}
        />
        <CenteredConfirmDialog
          open={fragRollenwechsel}
          title="Aufgabe des Geräts ändern?"
          intro="Die Aufgabe bestimmt, wie VoltPilot dieses Gerät bilanziert und steuert."
          consequences={auswirkungen(aenderungen)}
          confirmLabel="Aufgabe ändern und speichern"
          busy={speichern}
          onCancel={() => setFragRollenwechsel(false)}
          onConfirm={() => { setFragRollenwechsel(false); void anlegen(); }}
        />
        <CenteredConfirmDialog
          open={fragOhneKanal && !!testText?.override}
          title="Ohne Messkanal fortfahren?"
          intro="Ihr Gerät antwortet, meldet aber den benötigten Messkanal nicht."
          consequences={testText?.override?.folgen ?? []}
          confirmLabel="Trotzdem fortfahren"
          busy={editorBusy}
          onCancel={() => setFragOhneKanal(false)}
          onConfirm={() => {
            setOhneKanal(testText?.override ?? null);
            setFragOhneKanal(false);
          }}
        />
      </section>
    );
  }

  return (
    <AnlegenDialog
      titel={edit ? 'Gerät bearbeiten' : DIALOG_TITEL}
      schritte={schritte}
      aktiv={schritt}
      onClose={onClose}
      onBack={schritt > 1 && !istFertig ? zurueck : null}
      footer={fuss()}
    >
      {ladeFehler && <p className="vp-assist-error" role="alert">{ladeFehler}</p>}

      {/* 1 · Was möchten Sie anbinden? Die Typ-Karten aus der Katalog-Typ-
          Dimension (Captain-Entscheidung 2: Gerätetyp zuerst). */}
      {schritt === 1 && (
        <section>
          <h3 className="vp-assist-h">Was möchten Sie anbinden?</h3>
          <div className="vp-anlegen-typen">
            {karten.map((k) => (
              <button
                key={k.id}
                type="button"
                className="vp-anlegen-typ"
                data-testid={`typ-${k.id}`}
                onClick={() => waehleTyp(k.id)}
              >
                <span className="vp-anlegen-typ-i">
                  <Icon name={k.icon} size={20} />
                </span>
                <strong>{k.label}</strong>
                <span className="vp-anlegen-typ-h">{k.hint}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Die Ladesäulen-Karte legt weiterhin NICHTS an (§13.4) - die Säule
          verbindet sich selbst. Hier steht der ANBINDE-ASSISTENT, derselbe
          Körper wie im Drawer der Ladevorgänge-Seite: eine zweite Kopie wären
          zwei Wahrheiten über denselben Weg. */}
      {schritt >= 2 && typ === 'ladesaeule' && (
        <section data-testid="typ-ladesaeule">
          <LadesaeuleAnbinden siteId={siteId} device={box} />
        </section>
      )}

      {/* Der Eigenbau-Weg: die Schritte des Selbstbau-Baukastens SIND die
          Schritte 2-5 dieses Flusses (Konzept Stufe 2). */}
      {schritt >= 2 && schritt <= 5 && typ === 'eigenbau' && (
        <SelbstbauAssistent
          siteId={siteId}
          vorlage={vorlage}
          schritt={selbstbauSchritt}
          onSchritt={(s) => setSchritt(s + 1)}
          navPortal={fussEl}
          onBack={() => (vorlage ? onClose() : setSchritt(1))}
          onSaved={(result) => {
            setNeueId(neueKomponente(vorherigeIds, result.components));
            setUebernommen(false);
            setVorherigeIds(result.components.map((r) => ({ id: r.id })));
            setSchritt(6);
            onSaved(result);
          }}
        />
      )}

      {/* 2 · Gerät wählen - EIN Picker mit den Marken als Gruppen. */}
      {schritt === 2 && typ && typ !== 'eigenbau' && typ !== 'ladesaeule' && (
        <section>
          <h3 className="vp-assist-h">{edit ? 'Gerät und Aufgabe' : 'Welches Gerät ist es?'}</h3>
          {edit && (
            <div className="vp-edit-identity" role="note">
              <strong>{edit.label?.trim() || 'Gerät ohne Anzeigenamen'}</strong>
              <span>{[
                template?.brandLabel ?? edit.brand,
                template?.modelLabel ?? edit.model,
              ].filter(Boolean).join(' ') || 'Technische Angaben unbekannt'}</span>
              <p>Die Geräte-ID bleibt unverändert. Messhistorie, Transaktionen, Befehle und Audit werden fortgeführt.</p>
            </div>
          )}
          {/* Die einzige echte Rest-Frage der Typ-Karten: ein Wechselrichter
              kann das Herz der Anlage ODER ein weiterer Erzeuger sein. Jede
              andere Karte beantwortet sie selbst - dann steht hier nichts. */}
          {rollen.length > 1 && (
            <div className="vp-assist-roles" data-testid="rollen-wahl">
              {rollen.map((r) => (
                <button
                  key={r.rolle}
                  type="button"
                  className={`vp-assist-role${rolle === r.rolle ? ' is-on' : ''}${
                    r.verfuegbar ? '' : ' is-soon'
                  }`}
                  disabled={!r.verfuegbar}
                  aria-disabled={!r.verfuegbar}
                  onClick={() => setRolle(r.rolle)}
                >
                  <strong>{r.label}</strong>
                  <span>{r.hint}</span>
                  {!r.verfuegbar && r.grund && <em className="vp-assist-soon">{r.grund}</em>}
                </button>
              ))}
            </div>
          )}
          {rollen.length === 1 && !rollen[0].verfuegbar && (
            <p className="vp-assist-error">{rollen[0].grund}</p>
          )}
          {/* ⚠ Der ehrliche Satz, wenn der Katalog für diesen Typ (noch) keine
              eigene Vorlage hat und die Liste sich deshalb WEITET. */}
          {auswahl.erweitert && (
            <p className="vp-assist-help" data-testid="typ-erweitert">
              {karten.find((k) => k.id === typ)?.hinweis}
            </p>
          )}
          <div className="vp-assist-pick">
            <VpPicker
              id="anlegen-modell"
              label="Gerät"
              options={modellOptionen}
              groups={modellGruppen}
              value={template?.templateRef ?? null}
              onChange={waehleTemplate}
              placeholder="Marke und Modell wählen …"
              searchPlaceholder="z. B. SUN-30K, SG02 oder Fronius"
              search="immer"
              emptyText={(q) =>
                `Keine Vorlage passt zu „${q}“. Oft reicht ein Teil des Namens, `
                + 'zum Beispiel nur „30K“.'
              }
              hint="Der Name steht auf dem Typenschild - Marke oder Modell genügt."
            />
          </div>
          {template && (
            <p className="vp-anlegen-gewaehlt" data-testid="gewaehlt">
              <Icon name="check" size={14} /> {template.brandLabel} {template.modelLabel}
              {modellZusatz(template) ? ` · ${modellZusatz(template)}` : ''}
            </p>
          )}
          {edit && (
            <details className="vp-edit-locked">
              <summary>Gesperrte Angaben und Gründe</summary>
              <dl>
                {GESPERRTE_FELDER.map((item) => (
                  <div key={item.feld}>
                    <dt>{item.feld}</dt>
                    <dd>{item.grund}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      )}

      {/* 3 · Verbinden - Pflichtfelder oben, Experten-Angaben unter „Erweitert". */}
      {schritt === 3 && template && (
        <section>
          <h3 className="vp-assist-h">Verbindung zu {template.modelLabel}</h3>
          <p className="vp-assist-sub">{template.communicationLabel}</p>
          {gruppen.pflicht.map((f) => (
            <Feld key={f.key} feld={f} wert={verbindung[f.key]} onChange={setzeFeld} />
          ))}
          {gruppen.erweitert.length > 0 && (
            <details
              className="vp-anlegen-erweitert"
              open={erweitertOffen}
              onToggle={(e) => setErweitertOffen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>Erweitert</summary>
              <p className="vp-assist-help">
                Vorgaben, die fast immer passen - ändern Sie sie nur, wenn Ihr Gerät es verlangt.
              </p>
              {gruppen.erweitert.map((f) => (
                <Feld key={f.key} feld={f} wert={verbindung[f.key]} onChange={setzeFeld} />
              ))}
            </details>
          )}
          {fehlend.length > 0 && (
            <p className="vp-assist-help">Es fehlt noch: {fehlend.map((f) => f.label).join(', ')}</p>
          )}
        </section>
      )}

      {/* 4 · Testen - der Befund, die Hebel, der Ausweg, und was gleich entsteht. */}
      {schritt === 4 && template && (
        <section>
          <h3 className="vp-assist-h">{edit ? 'Änderungen prüfen' : 'Verbindung testen'}</h3>
          <div className="vp-assist-test">
            {!testNoetig && (
              <p className="vp-assist-ok" role="status">
                Verbindung und Vorlage sind unverändert — kein neuer Verbindungstest nötig.
              </p>
            )}
            {testNoetig && testZustand === 'laeuft' && <p role="status">Prüfe …</p>}
            {testText && (
              <div
                className={testText.zustand === 'bestanden' ? 'vp-assist-ok' : 'vp-assist-error'}
                role="status"
              >
                <p>{testText.text}</p>
                {/* Die VERLETZTE REGEL im Klartext - direkt über den Werten,
                    die wirklich ankamen. */}
                {testText.regelText && <p className="vp-assist-regel">{testText.regelText}</p>}
                {testText.messwerte.length > 0 && (
                  <ul className="vp-assist-readings">
                    {testText.messwerte.map((m) => (
                      <li key={m.label}>
                        <span>{m.label}</span>
                        <strong>{m.wert}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {testNoetig && testZustand !== 'laeuft' && (
              <Button variant="outline" className="vp-anlegen-nochmal" onClick={testen}>
                Erneut testen
              </Button>
            )}
            {/* Die HEBEL: konkrete Wege statt eines Fließtexts. Sie erscheinen
                auch neben einem BESTANDENEN Test - der Faktor-10-Fall verletzt
                keine Plausibilitätsregel und käme sonst nie zur Sprache. */}
            {hebelListe.length > 0 && (
              <div className="vp-assist-hebel" data-testid="test-hebel">
                <p className="vp-assist-hebel-intro">{HEBEL_INTRO}</p>
                <ul>
                  {hebelListe.map((h) => (
                    <li key={h.id}>
                      <div>
                        <strong>{h.titel}</strong>
                        <span>{h.satz}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`hebel-${h.id}`}
                        onClick={() => hebelKlick(h)}
                      >
                        {h.aktion}
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="vp-assist-hebel-note">{HEBEL_HINWEIS}</p>
              </div>
            )}
            {/* Der Ladestand aus der Batteriespannung - NUR im selben Fall, in
                dem es überhaupt einen Ausweg gibt („das BMS meldet nichts").
                Eine Anlage mit funktionierendem BMS sieht die Felder nie. */}
            {socAngeboten && (
              <div className="vp-assist-socvolt" data-testid="soc-schaetzung">
                <strong>{socSchaetzung.SOC_VOLTAGE_TITEL}</strong>
                <p className="vp-assist-help">{socSchaetzung.SOC_VOLTAGE_INTRO}</p>
                {socSchaetzung.SOC_VOLTAGE_FELDER.map((f) => (
                  <div className="vp-assist-field" key={f.id}>
                    <label htmlFor={f.id}>{f.label}</label>
                    <Input
                      id={f.id}
                      inputMode="decimal"
                      value={socVolt[f.key]}
                      placeholder={f.platzhalter}
                      onChange={(e) => setzeSocVolt({ ...socVolt, [f.key]: e.target.value })}
                    />
                    <p className="vp-assist-help">{f.hilfe}</p>
                  </div>
                ))}
                {socSchaetzung.fehler(socVolt) && (
                  <p className="vp-assist-warn" data-testid="soc-schaetzung-fehler">
                    {socSchaetzung.fehler(socVolt)}
                  </p>
                )}
                {/* Der BELEG der Box - die Rückmeldung, an der der Kunde seine
                    Angaben kalibriert. Ohne ihn wird nichts behauptet. */}
                {socSchaetzung.schaetzungSatz(testText?.befund) && (
                  <p className="vp-assist-uebernahme" data-testid="soc-schaetzung-beleg">
                    {socSchaetzung.schaetzungSatz(testText?.befund)}
                  </p>
                )}
                {!socSchaetzung.schaetzungSatz(testText?.befund)
                  && !socSchaetzung.istLeer(socVolt)
                  && !socSchaetzung.fehler(socVolt) && (
                  <p className="vp-assist-help" data-testid="soc-schaetzung-erneut">
                    {socSchaetzung.SOC_VOLTAGE_ERNEUT_TESTEN}
                  </p>
                )}
                <ul className="vp-assist-folgen">
                  {socSchaetzung.SOC_VOLTAGE_FOLGEN.map((z) => (
                    <li key={z}>{z}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* Der Ausweg - NUR wenn der Server ihn als solchen ausweist. */}
            {testZustand === 'fehlgeschlagen' && testText?.override && !ohneKanal && (
              <Button
                variant="outline"
                onClick={() => setFragOhneKanal(true)}
                data-testid="override-anbieten"
              >
                {testText.override.label}
              </Button>
            )}
            {ohneKanal && (
              <p className="vp-assist-uebernahme" data-testid="override-aktiv">
                Sie fahren fort, ohne dass diese Komponente einen Ladestand meldet. Alle anderen
                Messwerte laufen normal; die Steuerung des Speichers bleibt aus.
              </p>
            )}
          </div>

          {/* Was gleich entsteht - erst nach einem Ja (oder der abgenickten
              Ausnahme). Vorher gibt es nichts anzulegen. */}
          {rolle && (!testNoetig || testZustand === 'bestanden' || ohneKanal) && (
            <div className="vp-anlegen-fertigmachen" data-testid="fertigmachen">
              <h4 className="vp-assist-h">{edit ? 'Nur diese Änderungen' : 'Fast fertig'}</h4>
              {uebernahmeHinweis(uebernahme, template) && (
                <p className="vp-assist-uebernahme">{uebernahmeHinweis(uebernahme, template)}</p>
              )}
              <div className="vp-assist-field">
                <label htmlFor="anlegen-name">Name</label>
                <Input
                  id="anlegen-name"
                  value={name}
                  placeholder={uebernahme?.label?.trim() || template.modelLabel}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="vp-assist-help">{nameHilfe(uebernahme)}</p>
              </div>
              {rolle === 'pv-generation' && (
                <div className="vp-assist-field">
                  <label htmlFor="anlegen-kwp">Leistung (kWp)</label>
                  <Input
                    id="anlegen-kwp"
                    type="number"
                    value={kwp}
                    onChange={(e) => setKwp(e.target.value)}
                  />
                  <p className="vp-assist-help">
                    Optional - sie zählt zur Gesamtleistung Ihrer Anlage.
                  </p>
                </div>
              )}
              {edit ? (
                <>
                  {aenderungen.length > 0 ? (
                    <dl className="vp-edit-delta" aria-label="Änderungen">
                      {aenderungen.map((row) => (
                        <div key={row.feld}>
                          <dt>{row.feld}</dt>
                          <dd><del>{row.vorher}</del><span aria-hidden="true">→</span><ins>{row.nachher}</ins></dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="vp-assist-help" role="status">Noch keine Änderung.</p>
                  )}
                  <div className="vp-edit-effects">
                    <strong>Auswirkungen</strong>
                    <ul>{auswirkungen(aenderungen).map((satz) => <li key={satz}>{satz}</li>)}</ul>
                  </div>
                </>
              ) : (
                <>
                  <dl className="vp-assist-check">
                    {pruefen(template, rolle, name, verbindung, uebernahme).map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>{row.wert}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="vp-assist-balance">{bilanzHinweis(rolle)}</p>
                </>
              )}
            </div>
          )}
          {fehler && <p className="vp-assist-error" role="alert">{fehler}</p>}
        </section>
      )}

      {/* 5 · Fertig - was entstanden ist, und der Weg dorthin. */}
      {istFertig && (
        <section className="vp-anlegen-fertig" data-testid="schritt-fertig">
          <p className="vp-assist-ok">
            <Icon name="check" />{' '}
            {edit
              ? `„${name.trim() || template?.modelLabel || 'Gerät'}“ wurde als neue Fassung gespeichert.`
              : abschlussTitel(
                name.trim() || uebernahme?.label?.trim() || template?.modelLabel || '',
                uebernommen,
              )}
          </p>
          <p className="vp-assist-help">
            {edit
              ? gespeichert?.components.find((row) => row.id === edit.id)?.syncStatus === 'in_sync'
                ? 'Die Box hat diese Fassung bereits vollständig aktiviert.'
                : 'Die bisherige Fassung bleibt aktiv, bis die Box die neue vollständig bestätigt. Bei Ablehnung können Sie in der Gerätehistorie zurückrollen.'
              : ABSCHLUSS_HINWEIS}
          </p>
        </section>
      )}

      {/* Die Rückfrage im HAUS-MUSTER (Folgenliste statt window.confirm): sie
          nennt ausdrücklich auch, was GLEICH bleibt. */}
      <ConfirmDialog
        open={fragOhneKanal && !!testText?.override}
        title="Ohne Ladestand fortfahren?"
        intro={
          'Ihr Gerät antwortet, meldet aber keinen Ladestand. Diese Komponente wird dann nur '
          + 'ausgelesen.'
        }
        consequences={testText?.override?.folgen ?? []}
        confirmLabel="Trotzdem fortfahren"
        onCancel={() => setFragOhneKanal(false)}
        onConfirm={() => {
          setOhneKanal(testText?.override ?? null);
          setFragOhneKanal(false);
          void frageUebernahme();
        }}
      />
    </AnlegenDialog>
  );
}

/** EIN Verbindungsfeld, GENERISCH aus dem `transport_schema` der Vorlage. */
function Feld({
  feld,
  wert,
  onChange,
  disabled = false,
}: {
  feld: TemplateField;
  wert: unknown;
  onChange: (feld: TemplateField, value: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <div className="vp-assist-field">
      <label htmlFor={`anlegen-${feld.key}`}>
        {feld.label}
        {feld.required && <span aria-hidden="true"> *</span>}
      </label>
      {feld.type === 'checkbox' ? (
        <input
          id={`anlegen-${feld.key}`}
          type="checkbox"
          checked={Boolean(wert)}
          onChange={(e) => onChange(feld, e.target.checked)}
          disabled={disabled}
        />
      ) : feld.options ? (
        <VpPicker
          id={`anlegen-${feld.key}`}
          ariaLabel={feld.label}
          options={feld.options.map((o) => ({ value: String(o.value), label: o.label }))}
          value={String(wert ?? '')}
          onChange={(v) => onChange(feld, v)}
          disabled={disabled}
        />
      ) : (
        <Input
          id={`anlegen-${feld.key}`}
          type={istSecret(feld) ? 'password' : feld.type === 'number' ? 'number' : 'text'}
          value={istSecret(feld) && String(wert ?? '') === '••••••••' ? '' : String(wert ?? '')}
          placeholder={istSecret(feld) && wert ? '•••••••• (unverändert)' : undefined}
          autoComplete={istSecret(feld) ? 'new-password' : undefined}
          onChange={(e) => onChange(feld, e.target.value)}
          disabled={disabled}
        />
      )}
      {istSecret(feld) && Boolean(wert) && (
        <p className="vp-assist-help">Gespeichert und verborgen. Leer lassen, um es beizubehalten.</p>
      )}
      {feld.help && <p className="vp-assist-help">{feld.help}</p>}
    </div>
  );
}
