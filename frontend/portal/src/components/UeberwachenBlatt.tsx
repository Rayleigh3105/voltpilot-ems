import { useEffect, useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { UeberwachungsRegel } from '../meldungenApi';
import { WORT_ERHOLDAUER, WORT_RUECKKEHRSCHWELLE, WORT_UEBERWACHEN, SCHWERE_WORT } from '../meldungen';
import type { Schwere } from '../meldungenApi';
import {
  ueberwachungApi,
  type ProbelaufVorschau,
  type UeberwachungBedingungEingabe,
  type UeberwachungBezugEingabe,
} from '../ueberwachungApi';
import {
  PERIODE_WORT,
  ueberwachungSatz,
  VORLAGE_SCHWELLE,
  vorgabenFuerBedingung,
  vorlageSatz,
  zustandswortAnzeige,
  type BedingungEingabe,
} from '../ueberwachungSatz';
import { katalogEintrag, type Periode } from '../werteKatalog';
import { BottomSheet } from './BottomSheet';
import { VpPicker } from './VpPicker';
import './UeberwachenBlatt.css';

/** Der Bezug einer Überwachung (§6.3): Anlage (ihre Live-Werte), Komponente+Kanal (Familie
 * `geraet.messwert`), oder - Alerting Scheibe 5 - Messstelle, Kennzahl bzw. Energieziel (keine
 * Anlage): nie mehr als eine Form zugleich. */
export type UeberwachenBezug =
  | { anlage: string }
  | { komponente: string; kanal: string }
  | { messstelle: string }
  | { kennzahl: string }
  | { energieziel: string };

const PERIODEN: readonly Periode[] = ['tag', 'woche', 'monat', 'abrechnungszeitraum'];

/**
 * Das Blatt „Überwachen" (Alerting Scheibe 2, Konzept §6.8). Seit Konzept b1 (20.10.2026, E3) öffnen
 * es nur „+ Überwachung“ unter Meldungen (nach Ort und Wert, `NeueUeberwachung.tsx`) und „In
 * Überwachung umwandeln“ in der Steuerung - nie mehr ein Menü am Wert. Der Satz ist vorbelegt
 * (Schwelle aus dem aktuellen Live-Wert, Dauer/Rückkehrschwelle aus §9) und jedes
 * Feld bleibt änderbar (§6.1 Leitsatz 9) - kein Pflichtfeld ohne Vorbelegung.
 *
 * Zwei Bedingungsformen, toddler-simple nach Leserart (Alerting Scheibe 4, §6.4):
 *  - Momentanwerte (`anlagenfluss`/`messreihe`): nur „über" mit Schwelle/Dauer/Erholdauer (Aufgabe 4b) -
 *    unverändert seit Scheibe 2.
 *  - Perioden-Werte (`menge`/`geld`, §6.3): „mehr als X im Zeitraum" (Periode-Chips, keine Dauer -
 *    §6.4 Nr. 2) ODER „Änderung gegenüber der Vorperiode um X %" - ein Schalter wählt die Form.
 *
 * „Gilt für" (§6.4 "Gilt für", nur am Anlagen-Bezug - eine Auswahl ergibt serverseitig je Anlage
 * eine eigene Meldung, §6.4 Nr. 6/7): „Diese Anlage" (Vorgabe) oder „Alle Anlagen" - toddler-simple
 * zwei Chips, kein eigener Standort-Schritt in dieser Scheibe.
 *
 * Alarm-Vorlagen (UEMS EZ-11, Katalog `vorlage`, z. B. „Anlage folgt nicht“): Ziel-Zustand, Dauer, Erholdauer,
 * Schwere und die eigenen Schwellen der Vorlage sind vorbelegt; die Schwellen stehen als Felder im Blatt. Keine
 * Probelauf-Vorschau - ihre Werte haben keine Rückschau -, darum meldet eine Vorlage ab dem Anlegen.
 *
 * Seit der Nachbesserung 3/3 zeigt das Blatt die Probelauf-Vorschau (§6.8 Entwurf 1, „was diese
 * Regel in den letzten 30 Tagen gemeldet hätte"): ein einfacher Debounce (~400 ms), damit nicht
 * jeder Tastenanschlag einen Abruf auslöst; ein Fehlschlag zeigt nichts - die Vorschau ist eine
 * Hilfe, nie ein Blocker für „Überwachung starten".
 */
export function UeberwachenBlatt({
  offen,
  isPhone,
  onClose,
  wertart,
  bezug,
  aktuellerWert,
  einheit = 'kW',
  titelZusatz,
  herkunft,
  regel = null,
  onUeberwacht,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  wertart: string;
  bezug: UeberwachenBezug;
  aktuellerWert: number | null;
  einheit?: string;
  /** Zusatz zum Blatt-Titel - z. B. „Netzbezug“ oder „Monat unvollständig · Hauptzähler“; ohne Zusatz nur „Überwachen“. */
  titelZusatz?: string;
  /** Vorgabe `'eigen'`; `'steuerung'` nur für "In Überwachung umwandeln" (Alerting Scheibe 6, Entscheid 10A). */
  herkunft?: 'eigen' | 'steuerung';
  /**
   * Kunden-Alarmierung P3: eine bestehende Regel ändern statt eine neue anzulegen - das Blatt startet mit ihrer
   * Bedingung, Stufe und ihrem Probelauf und speichert über `PUT /regeln/{id}` (Wertart und Bezug bleiben).
   */
  regel?: UeberwachungsRegel | null;
  onUeberwacht: (regel: UeberwachungsRegel) => void;
}) {
  const alt = (regel?.bedingung ?? null) as Record<string, unknown> | null;
  const altZahl = (feld: string): number | null => (alt && typeof alt[feld] === 'number' ? (alt[feld] as number) : null);
  const eintrag = katalogEintrag(wertart);
  // Periodisch/Zustand folgt den `bedingungen` des Katalog-Eintrags, nicht seiner Leserart (Alerting
  // Scheibe 5, §6.3): `zaehlung` (messstelle.menge) ist ebenso periodisch wie `menge`/`geld`.
  const istPeriodisch = eintrag ? eintrag.bedingungen.includes('periode') || eintrag.bedingungen.includes('aenderung') : false;
  // Die Zustands-Form (Alerting Scheibe 5, §6.3): ein Ziel-Zustand statt einer Schwelle - bisher nur
  // ab Werk gesät (box.erreichbar/datenquelle.liefert_daten, Entscheid 9A nie über dieses Blatt),
  // Scheibe 5 bringt die ersten SELBST angelegten Zustands-Regeln (Energieziel-Kurs, Beobachtung,
  // Monat unvollständig).
  const vorlage = eintrag?.vorlage ?? null;
  const istVorlage = vorlage != null;
  const istZustandsform = !istVorlage && !istPeriodisch && (eintrag?.bedingungen.includes('zustand') ?? false);
  const [schwellen, setSchwellen] = useState<Record<string, number>>(() => ({ ...(vorlage?.schwellen ?? {}) }));
  const [ziel, setZiel] = useState<string[]>(() => (alt && Array.isArray(alt.ziel) ? (alt.ziel as string[]) : []));
  const kannAuswahl = 'anlage' in bezug;

  const vorschlag = altZahl('schwelle') ?? vorschlagSchwelle(aktuellerWert);
  const [schwelle, setSchwelle] = useState(vorschlag);
  // Kunden-Alarmierung P3: der Satz fragt „über“ ODER „unter“ (vier Wahlfelder: Wert, Richtung, Schwelle, Dauer).
  const kannUnter = eintrag?.bedingungen.includes('unter') ?? false;
  const [richtung, setRichtung] = useState<'ueber' | 'unter'>(alt?.art === 'unter' ? 'unter' : 'ueber');
  const vorgaben = vorgabenFuerBedingung(richtung, vorschlag);
  const [dauerMinuten, setDauerMinuten] = useState((altZahl('dauer_s') ?? vorlage?.dauer_s ?? vorgaben.dauer_s) / 60);
  const [erholdauerMinuten, setErholdauerMinuten] = useState(
    (altZahl('erholen_s') ?? vorlage?.erholen_s ?? vorgaben.erholen_s) / 60,
  );
  const [feinOffen, setFeinOffen] = useState(false);
  // KA-3 A: „Erst 30 Tage mitzählen, nichts senden“ ist ein sichtbarer Schalter, Vorgabe aus - eine neue Regel
  // meldet sofort. Beim Ändern gilt der Stand der Regel.
  const [mitzaehlen, setMitzaehlen] = useState(regel ? regel.probelaufBis != null : false);
  // Kunden-Alarmierung P0: die Rückkehrschwelle FOLGT der Schwelle (5 % darunter, `vorgabenFuerBedingung`), bis die
  // Person sie selbst ändert; ändert sie danach die Schwelle, folgt sie wieder. Vorher blieb sie beim Vorschlag
  // stehen - im Labor Schwelle 5 mit Rückkehr 7,6 ct/kWh, die Meldung flatterte.
  const [rueckkehrEigen, setRueckkehrEigen] = useState<number | null>(() => altZahl('rueckkehr'));
  const rueckkehr = rueckkehrEigen ?? vorgabenFuerBedingung(richtung, schwelle).rueckkehr ?? schwelle;
  const paarVerdreht = Number.isFinite(rueckkehr) && Number.isFinite(schwelle)
    && (richtung === 'ueber' ? rueckkehr > schwelle : rueckkehr < schwelle);
  function richtungAendern(r: 'ueber' | 'unter') {
    setRichtung(r);
    setRueckkehrEigen(null);
  }
  function schwelleAendern(wert: number) {
    setSchwelle(wert);
    setRueckkehrEigen(null);
  }
  const [schwere, setSchwere] = useState<Schwere>(regel?.schwere ?? vorlage?.schwere ?? 'warnung');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const [probelauf, setProbelauf] = useState<ProbelaufVorschau | null>(null);
  const feldId = useId();

  // Perioden-Form (§6.3/§6.4, nur `menge`/`geld`): Schwelle ODER Änderung, nie Dauer.
  const [periodenform, setPeriodenform] = useState<'periode' | 'aenderung'>('periode');
  const [periode, setPeriode] = useState<Periode>('monat');
  const [richtungPeriode, setRichtungPeriode] = useState<'ueber' | 'unter'>('ueber');
  const [richtungAenderung, setRichtungAenderung] = useState<'hoeher' | 'niedriger' | 'beide'>('hoeher');
  const [schwelleProzent, setSchwelleProzent] = useState(20);

  // „Gilt für" (§6.4): nur am Anlagen-Bezug wählbar - eine Auswahl ersetzt den konkreten Bezug.
  const [giltFuer, setGiltFuer] = useState<'diese' | 'alle'>('diese');

  const gueltig = istVorlage
    ? Number.isFinite(dauerMinuten) && dauerMinuten >= 0 && erholdauerMinuten > 0
      && Object.values(schwellen).every((x) => Number.isFinite(x) && x >= 0)
    : istPeriodisch
    ? periodenform === 'periode'
      ? Number.isFinite(schwelle)
      : Number.isFinite(schwelleProzent) && schwelleProzent > 0
    : istZustandsform
      ? ziel.length > 0 && dauerMinuten > 0 && erholdauerMinuten > 0
      : Number.isFinite(schwelle) && Number.isFinite(rueckkehr) && !paarVerdreht && dauerMinuten > 0 && erholdauerMinuten > 0;
  const bezugKey = 'anlage' in bezug
    ? `anlage:${bezug.anlage}`
    : 'komponente' in bezug
      ? `komponente:${bezug.komponente}:${bezug.kanal}`
      : 'messstelle' in bezug
        ? `messstelle:${bezug.messstelle}`
        : 'kennzahl' in bezug
          ? `kennzahl:${bezug.kennzahl}`
          : `energieziel:${bezug.energieziel}`;

  function bedingungFuerAnfrage(): UeberwachungBedingungEingabe {
    if (vorlage) {
      const b: UeberwachungBedingungEingabe = {
        art: 'zustand',
        ziel: vorlage.ziel,
        dauer_s: Math.round(dauerMinuten * 60),
        erholen_s: Math.round(erholdauerMinuten * 60),
      };
      return Object.assign(b, schwellen);
    }
    if (istZustandsform) {
      return { art: 'zustand', ziel, dauer_s: Math.round(dauerMinuten * 60), erholen_s: Math.round(erholdauerMinuten * 60) };
    }
    if (!istPeriodisch) {
      return {
        art: richtung,
        schwelle,
        rueckkehr,
        dauer_s: Math.round(dauerMinuten * 60),
        erholen_s: Math.round(erholdauerMinuten * 60),
      };
    }
    if (periodenform === 'aenderung') {
      return { art: 'aenderung', richtung: richtungAenderung, schwelle_prozent: schwelleProzent, periode };
    }
    const periodenVorgaben = vorgabenFuerBedingung(richtungPeriode, schwelle);
    return {
      art: 'periode',
      richtung: richtungPeriode,
      schwelle,
      rueckkehr: periodenVorgaben.rueckkehr,
      periode,
      dauer_s: 0,
      erholen_s: 0,
    };
  }

  function bezugFuerAnfrage(): UeberwachungBezugEingabe {
    if (giltFuer === 'alle') return { alle: 'anlage' };
    if ('anlage' in bezug) return { anlage: bezug.anlage };
    if ('komponente' in bezug) return { komponente: bezug.komponente, kanal: bezug.kanal };
    if ('messstelle' in bezug) return { messstelle: bezug.messstelle };
    if ('kennzahl' in bezug) return { kennzahl: bezug.kennzahl };
    return { energieziel: bezug.energieziel };
  }

  // Die Probelauf-Vorschau (§6.8 Entwurf 1) - gedämpft, damit nicht jede Änderung an Schwelle,
  // Dauer oder Rückkehrschwelle sofort einen eigenen Abruf auslöst. Eine Auswahl ("alle Anlagen")
  // hat keine eigene Vorschau (der Probelauf braucht EINEN konkreten Bezug) - sie bleibt aus.
  useEffect(() => {
    if (!offen || !gueltig || giltFuer === 'alle' || istVorlage) {
      setProbelauf(null);
      return undefined;
    }
    let aktiv = true;
    const zeitnehmer = window.setTimeout(() => {
      ueberwachungApi
        .probelauf({ wertart, bezug, bedingung: bedingungFuerAnfrage(), schwere })
        .then(
          (v) => { if (aktiv) setProbelauf(v); },
          () => { if (aktiv) setProbelauf(null); },
        );
    }, 400);
    return () => { aktiv = false; window.clearTimeout(zeitnehmer); };
    // `bezugKey` fasst den Bezug stabil zusammen - `bezug` selbst ist bei jedem Render ein neues Objekt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    offen, gueltig, wertart, bezugKey, giltFuer, schwelle, rueckkehr, dauerMinuten, erholdauerMinuten, schwere,
    periodenform, periode, richtungPeriode, richtungAenderung, schwelleProzent, istVorlage, schwellen, richtung,
  ]);

  if (!eintrag) return null;

  const satzBedingung: BedingungEingabe = istZustandsform
    ? { art: 'zustand', ziel, dauer_s: dauerMinuten * 60 }
    : istPeriodisch
      ? periodenform === 'aenderung'
        ? { art: 'aenderung', richtung: richtungAenderung, schwelleProzent, periode }
        : { art: 'periode', richtung: richtungPeriode, schwelle, periode }
      : { art: richtung, schwelle, rueckkehr, dauer_s: dauerMinuten * 60 };
  const satz = istVorlage
    ? vorlageSatz(wertart, Math.round(dauerMinuten * 60), schwellen, schwere)
    : ueberwachungSatz(eintrag, satzBedingung, schwere, istPeriodisch && periodenform === 'aenderung' ? '' : einheit);
  const probelaufText = probelauf == null
    ? null
    : probelauf.moeglich === false
      ? 'Für diesen Wert ist keine Vorschau möglich.'
      : probelauf.ausgeloest === 0
      ? `In den letzten ${probelauf.fensterTage} Tagen hätte das nicht ausgelöst.`
      : `In den letzten ${probelauf.fensterTage} Tagen hätte das ${probelauf.ausgeloest} Mal ausgelöst.`;

  async function starten() {
    if (busy || !gueltig) return;
    setBusy(true);
    setFehler('');
    try {
      const gespeichert = regel
        ? await ueberwachungApi.aendern(regel.id, {
            bedingung: bedingungFuerAnfrage(),
            schwere,
            name: regel.name,
            probelauf: mitzaehlen,
          })
        : await ueberwachungApi.anlegen({
            wertart,
            bezug: bezugFuerAnfrage(),
            bedingung: bedingungFuerAnfrage(),
            schwere,
            ...(herkunft ? { herkunft } : {}),
            ...(istVorlage ? {} : { probelauf: mitzaehlen }),
          });
      onUeberwacht(gespeichert);
      onClose();
    } catch {
      setFehler('Die Überwachung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  const inhalt = (
    <div className="vp-ueberwachen-blatt">
      <p className="vp-ueberwachen-satz" aria-live="polite">
        {satz}
      </p>
      {istVorlage && (
        <p className="vp-ueberwachen-probelauf">Meldet ab dem Start, ohne Probelauf.</p>
      )}
      {probelaufText && (
        <p className="vp-ueberwachen-probelauf" aria-live="polite">
          {probelaufText}
        </p>
      )}
      {kannAuswahl && !regel && (
        <div className="vp-ueberwachen-schwere" role="group" aria-label="Gilt für">
          <span className="vp-ueberwachen-schwere-label">Gilt für</span>
          <div className="vp-seg vp-seg-compact">
            {(['diese', 'alle'] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={giltFuer === g}
                className={giltFuer === g ? 'active' : ''}
                onClick={() => setGiltFuer(g)}
              >
                {g === 'diese' ? 'Diese Anlage' : 'Alle Anlagen'}
              </button>
            ))}
          </div>
        </div>
      )}
      {istPeriodisch && (
        <div className="vp-ueberwachen-schwere" role="group" aria-label="Zeitraum">
          <span className="vp-ueberwachen-schwere-label">Zeitraum</span>
          <div className="vp-seg vp-seg-compact">
            {PERIODEN.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={periode === p}
                className={periode === p ? 'active' : ''}
                onClick={() => setPeriode(p)}
              >
                {PERIODE_WORT[p]}
              </button>
            ))}
          </div>
        </div>
      )}
      {istPeriodisch && (
        <div className="vp-ueberwachen-schwere" role="group" aria-label="Wie prüfen?">
          <span className="vp-ueberwachen-schwere-label">Wie prüfen?</span>
          <div className="vp-seg vp-seg-compact">
            {(['periode', 'aenderung'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={periodenform === f}
                className={periodenform === f ? 'active' : ''}
                onClick={() => setPeriodenform(f)}
              >
                {f === 'periode' ? 'Mehr als …' : 'Änderung …'}
              </button>
            ))}
          </div>
        </div>
      )}
      {istPeriodisch && periodenform === 'periode' && (
        <div className="vp-ueberwachen-felder">
          <div className="vp-seg vp-seg-compact">
            {(['ueber', 'unter'] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={richtungPeriode === r}
                className={richtungPeriode === r ? 'active' : ''}
                onClick={() => setRichtungPeriode(r)}
              >
                {r === 'ueber' ? 'über' : 'unter'}
              </button>
            ))}
          </div>
          <Input
            id={`${feldId}-schwelle-periode`}
            label={`Schwelle (${einheit})`}
            type="number"
            step="0.1"
            value={schwelle}
            onChange={(e) => setSchwelle(Number(e.target.value))}
          />
        </div>
      )}
      {istPeriodisch && periodenform === 'aenderung' && (
        <div className="vp-ueberwachen-felder">
          <div className="vp-seg vp-seg-compact">
            {(['hoeher', 'niedriger', 'beide'] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={richtungAenderung === r}
                className={richtungAenderung === r ? 'active' : ''}
                onClick={() => setRichtungAenderung(r)}
              >
                {r === 'hoeher' ? 'steigt' : r === 'niedriger' ? 'fällt' : 'ändert sich'}
              </button>
            ))}
          </div>
          <Input
            id={`${feldId}-schwelle-prozent`}
            label="Um mehr als (%)"
            type="number"
            step="1"
            min="1"
            value={schwelleProzent}
            onChange={(e) => setSchwelleProzent(Number(e.target.value))}
          />
        </div>
      )}
      {istZustandsform && (
        <div className="vp-ueberwachen-schwere" role="group" aria-label="Wenn der Zustand">
          <span className="vp-ueberwachen-schwere-label">Wenn der Zustand</span>
          <div className="vp-seg vp-seg-compact">
            {(eintrag.zustaende ?? []).map((z) => (
              <button
                key={z}
                type="button"
                aria-pressed={ziel.includes(z)}
                className={ziel.includes(z) ? 'active' : ''}
                onClick={() => setZiel((vorher) => (vorher.includes(z) ? vorher.filter((x) => x !== z) : [...vorher, z]))}
              >
                {zustandswortAnzeige(z)}
              </button>
            ))}
          </div>
        </div>
      )}
      {!istPeriodisch && (
        <div className="vp-ueberwachen-felder">
          {istVorlage && Object.keys(schwellen).map((name) => (
            <Input
              key={name}
              id={`${feldId}-${name}`}
              label={VORLAGE_SCHWELLE[name]?.label ?? name}
              type="number"
              step="0.5"
              min="0"
              value={schwellen[name]}
              onChange={(e) => {
                const wert = Number(e.target.value);
                setSchwellen((vorher) => ({ ...vorher, [name]: wert }));
              }}
            />
          ))}
          {!istZustandsform && !istVorlage && kannUnter && (
            <div className="vp-seg vp-seg-compact" role="group" aria-label="Richtung">
              {(['ueber', 'unter'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={richtung === r}
                  className={richtung === r ? 'active' : ''}
                  onClick={() => richtungAendern(r)}
                >
                  {r === 'ueber' ? 'über' : 'unter'}
                </button>
              ))}
            </div>
          )}
          {!istZustandsform && !istVorlage && (
            <Input
              id={`${feldId}-schwelle`}
              label={`Schwelle (${einheit})`}
              type="number"
              step="0.1"
              value={schwelle}
              onChange={(e) => schwelleAendern(Number(e.target.value))}
            />
          )}
          <VpPicker
            label="Länger als"
            ariaLabel="Länger als"
            options={dauerOptionen(dauerMinuten, istVorlage && vorlage.dauer_s === 0)}
            value={String(dauerMinuten)}
            onChange={(v) => setDauerMinuten(Number(v))}
          />
          <button
            type="button"
            className="vp-ueberwachen-fein"
            aria-expanded={feinOffen}
            onClick={() => setFeinOffen((o) => !o)}
            data-testid="ueberwachen-feineinstellung"
          >
            Feineinstellung {feinOffen ? '‹' : '›'}
          </button>
          {feinOffen && (
            <>
              <p className="vp-ueberwachen-erklaerung">
                Damit eine Meldung nicht flattert, endet sie erst, wenn der Wert eine Weile zurück ist. Beides rechnet
                das Portal aus Ihrer Schwelle - ändern nur, wenn Sie es genau wollen.
              </p>
              {!istZustandsform && !istVorlage && (
                <Input
                  id={`${feldId}-rueckkehr`}
                  label={`${WORT_RUECKKEHRSCHWELLE} (${einheit})`}
                  type="number"
                  step="0.1"
                  value={rueckkehr}
                  error={paarVerdreht ? (richtung === 'ueber' ? 'Muss bei oder unter der Schwelle liegen.' : 'Muss bei oder über der Schwelle liegen.') : undefined}
                  onChange={(e) => setRueckkehrEigen(Number(e.target.value))}
                />
              )}
              <Input
                id={`${feldId}-erholdauer`}
                label={`${WORT_ERHOLDAUER} (Minuten)`}
                type="number"
                step="1"
                min="1"
                value={erholdauerMinuten}
                onChange={(e) => setErholdauerMinuten(Number(e.target.value))}
              />
            </>
          )}
        </div>
      )}
      <div className="vp-ueberwachen-schwere" role="group" aria-label="Wie wichtig?">
        <span className="vp-ueberwachen-schwere-label">Wie wichtig?</span>
        <div className="vp-seg vp-seg-compact">
          {(['hinweis', 'warnung', 'dringend'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={schwere === s} className={schwere === s ? 'active' : ''} onClick={() => setSchwere(s)}>
              {SCHWERE_WORT[s]}
            </button>
          ))}
        </div>
      </div>
      <p className="vp-ueberwachen-erklaerung" data-testid="ueberwachen-stufe-bedeutung">{SCHWERE_BEDEUTUNG[schwere]}</p>
      {!istVorlage && (
        <div data-testid="ueberwachen-mitzaehlen">
          <Switch
            id={`${feldId}-mitzaehlen`}
            checked={mitzaehlen}
            onChange={(e) => setMitzaehlen(e.target.checked)}
            label="Erst 30 Tage mitzählen, nichts senden"
          />
        </div>
      )}
      {fehler && <p role="alert">{fehler}</p>}
      <Button variant="primary" fullWidth disabled={busy || !gueltig} onClick={starten}>
        {regel ? 'Speichern' : 'Überwachung starten'}
      </Button>
    </div>
  );

  const titel = titelZusatz ? `${WORT_UEBERWACHEN}: ${titelZusatz}` : WORT_UEBERWACHEN;
  return isPhone ? (
    <BottomSheet open={offen} title={titel} onClose={onClose}>
      {inhalt}
    </BottomSheet>
  ) : (
    <Modal open={offen} onClose={onClose} title={titel}>
      {inhalt}
    </Modal>
  );
}

/** Was eine Stufe bedeutet (Kunden-Alarmierung P3, §6.2: „Unter der Stufe steht, was sie bedeutet“). */
const SCHWERE_BEDEUTUNG: Record<Schwere, string> = {
  hinweis: 'Hinweis: steht leise unter Meldungen, ohne E-Mail und ohne Push.',
  warnung: 'Warnung: E-Mail und Push. Wartet in Ihrer Ruhezeit.',
  dringend: 'Dringend: E-Mail und Push, auch in der Ruhezeit.',
};

/** Die Wahl „Länger als“: feste Stufen, dazu der gespeicherte Wert, falls er keine davon ist. */
function dauerOptionen(aktuell: number, mitSofort: boolean): { value: string; label: string }[] {
  const stufen = [...(mitSofort ? [0] : []), 1, 5, 15, 30, 60, 120, 240, 720, 1440, 2880];
  if (Number.isFinite(aktuell) && !stufen.includes(aktuell)) stufen.push(aktuell);
  return stufen
    .sort((a, b) => a - b)
    .map((m) => ({ value: String(m), label: m === 0 ? 'sofort' : m < 60 ? `${m} Min.` : `${m / 60} Std.` }));
}

/**
 * Vorschlag aus dem Live-Wert (§6.1 Leitsatz 9): grob der aktuelle Wert mal 1,2, gerundet auf eine
 * Stufe, die zur Größenordnung passt. Ohne Live-Wert (oder 0) ein kleiner fester Startwert - besser
 * ein grober Vorschlag als ein leeres Pflichtfeld.
 */
export function vorschlagSchwelle(wert: number | null): number {
  if (wert == null || wert === 0) return 10;
  const basis = Math.abs(wert) * 1.2;
  const schritt = basis >= 100 ? 10 : basis >= 20 ? 5 : 1;
  return Math.max(schritt, Math.round(basis / schritt) * schritt);
}
