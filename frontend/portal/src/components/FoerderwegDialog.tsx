import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type MessstelleRegisterZeile } from '../api';
import {
  ablehnungSatz,
  ablehnungSchritt,
  awRegelLabel,
  AW_REGELN,
  AW_UNBEKANNT,
  EINVERSTAENDNIS_BIS,
  einverstaendnisNoetig,
  folgen,
  foerderweg,
  foerderwegReihe,
  FORMELSAETZE,
  formelsatzVorschlag,
  gebundenBis,
  giltAb,
  pauschalTerminOffen,
  PAUSCHAL_VORMERKBAR,
  schritteFuer,
  schrittTitel,
  tagText,
  zaehlerZustand,
  type Ablehnung,
  type FoerderwegWert,
  type SchrittId,
  type ZaehlerZustand,
} from '../mispelFoerderweg';
import {
  mispelApi,
  type FoerderwegAnsicht,
  type ZaehlerrolleAendern,
  type ZaehlerrolleAnsicht,
} from '../mispelFoerderwegApi';
import { AnlegenDialog } from './AnlegenDialog';
import {
  PauschalgrenzenSchritt,
  PauschalPruefen,
  steckersolarKwp,
  VoraussetzungenSchritt,
  voraussetzungUrteil,
  type PauschalAngaben,
  type PauschalAufbau,
} from './FoerderwegPauschal';
import { Recht } from './Recht';
import { VpPicker } from './VpPicker';
import './FoerderwegDialog.css';

/**
 * „Förderweg ändern“ (MiSpeL MP-17, Bedienkonzept BK-17 Variante A, abgestimmt am 02.10.2026): ein geführter Dialog in
 * der Reihenfolge der Festlegung — Förderweg · Zähler · Formelsatz · Partner · Prüfen. Zentriertes Fenster, am Telefon
 * Vollbild-Blatt; die Schale ist der Anlege-Dialog wie beim Messen-Assistenten. Einspeisevergütung,
 * Ausschließlichkeitsoption und ungeförderte Direktvermarktung gehen den Kurzweg (Schritt 1 → Prüfen).
 *
 * Gespeichert wird über die Routen der Verträge: die Zählerrollen beim Verlassen von „Zähler“ (MP-6,
 * `PUT …/messstellen/{id}/zaehlerrolle`, gültig ab heute — sie beschreiben die Zähler, wie sie eingebaut sind), der
 * Förderweg am Ende (MP-5, `PUT …/sites/{id}/foerderweg`, gültig ab dem Monatsersten, vorgemerkt nach Vertrag 1.2 § 5).
 * Jede Ablehnung erscheint als Satz in dem Schritt, in dem sie entsteht.
 */

type Slot = 'z1Bezug' | 'z1Abgabe' | 'z2Laden' | 'z2Entladen';

const SLOTS: { slot: Slot; rolle: 'Z1' | 'Z2'; richtungen: string[]; label: string }[] = [
  { slot: 'z1Bezug', rolle: 'Z1', richtungen: ['Bezug'], label: 'Richtung Bezug' },
  { slot: 'z1Abgabe', rolle: 'Z1', richtungen: ['Abgabe'], label: 'Richtung Abgabe' },
  { slot: 'z2Laden', rolle: 'Z2', richtungen: ['Bezug', 'Laden'], label: 'Richtung Laden (Bezug)' },
  { slot: 'z2Entladen', rolle: 'Z2', richtungen: ['Abgabe', 'Entladen', 'Erzeugung'], label: 'Richtung Entladen (Abgabe)' },
];

interface ZaehlerAngaben {
  zaehlpunkt: string;
  messstellenbetreiber: string;
  eichstatus: '' | 'eichrechtskonform' | 'nicht_eichrechtskonform';
  eichfrist_bis: string;
  wertequelle: '' | 'messstellenbetreiber' | 'geraet';
}

const LEER: ZaehlerAngaben = { zaehlpunkt: '', messstellenbetreiber: '', eichstatus: '', eichfrist_bis: '', wertequelle: '' };

const ZAEHLER_TITEL: Record<'Z1' | 'Z2', string> = {
  Z1: 'Zweirichtungszähler am Netzanschluss',
  Z2: 'Zähler für die Stromspeicher und/oder Ladepunkte',
};

const URTEIL_TEXT: Record<ZaehlerZustand, string> = {
  fehlt: 'fehlt',
  tauglich: 'tauglich',
  nicht_pruefbar: 'nicht prüfbar',
  nicht_tauglich: 'nicht tauglich',
};

function angabenAus(v: ZaehlerrolleAnsicht | undefined): ZaehlerAngaben {
  const r = v?.rolle;
  if (!r) return LEER;
  return {
    zaehlpunkt: r.zaehlpunkt ?? '',
    messstellenbetreiber: r.messstellenbetreiber ?? '',
    eichstatus: r.eichstatus ?? '',
    eichfrist_bis: r.eichfrist_bis ?? '',
    wertequelle: r.wertequelle ?? '',
  };
}

function fehlerText(e: unknown, sonst: string): Ablehnung {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'code' in e.body) return e.body as Ablehnung;
  return { code: 'netz', message: sonst };
}

export interface FoerderwegDialogProps {
  siteId: string;
  ansicht: FoerderwegAnsicht;
  onClose: () => void;
  onGespeichert: (neu: FoerderwegAnsicht) => void;
  /** Der Platz des MiSpeL-Checks in Schritt 1 unter der Abgrenzungsoption (MP-48, BK-48 Variante A). */
  mispelCheck?: ReactNode;
  /** Der MiSpeL-Check Haushalt unter der Pauschaloption (MP-29, Basisfall P1; MP-27). */
  mispelCheckPauschal?: ReactNode;
  /** Der Aufbau für die Voraussetzungen und Pauschalgrenzen der Pauschaloption (MP-27). */
  aufbau?: PauschalAufbau;
}

const AUFBAU_LEER: PauschalAufbau = { pvKwp: null, speicherKwh: null, arten: [] };

export function FoerderwegDialog({
  siteId,
  ansicht,
  onClose,
  onGespeichert,
  mispelCheck,
  mispelCheckPauschal,
  aufbau = AUFBAU_LEER,
}: FoerderwegDialogProps) {
  const basis = useId();
  const heute = ansicht.am;
  const v = ansicht.vormerkung ?? null;
  const pv = ansicht.pauschal_vormerkung ?? null;
  const heuteWeg = ansicht.foerderweg;
  // Die Pauschaloption geht vor der EU-Genehmigung als Vormerkung mit offenem Termin (MP-27, Vertrag § 5a).
  const terminOffen = pauschalTerminOffen(heute, ansicht.pauschaloption_ab);

  const [weg, setWeg] = useState<FoerderwegWert>(
    v?.foerderweg ?? (pv ? 'marktpraemie_pauschal' : null) ?? heuteWeg ?? 'marktpraemie_ausschliesslichkeit',
  );
  const [schritt, setSchritt] = useState<SchrittId>('foerderweg');
  const [fehler, setFehler] = useState<{ schritt: SchrittId; satz: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Zähler
  const [register, setRegister] = useState<MessstelleRegisterZeile[] | null>(null);
  const [rollen, setRollen] = useState<Record<string, ZaehlerrolleAnsicht>>({});
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [wahl, setWahl] = useState<Record<Slot, string>>({ z1Bezug: '', z1Abgabe: '', z2Laden: '', z2Entladen: '' });
  const [angaben, setAngaben] = useState<Record<'Z1' | 'Z2', ZaehlerAngaben>>({ Z1: LEER, Z2: LEER });

  // Formelsatz, Partner
  const [formelsatz, setFormelsatz] = useState<string>(v?.formelsatz ?? ansicht.formelsatz ?? '');
  const [awRegel, setAwRegel] = useState<string>((v ? v.aw_regel : ansicht.aw_regel) ?? AW_UNBEKANNT);
  const [dv, setDv] = useState<string>((v ? v.direktvermarkter : pv ? pv.direktvermarkter : ansicht.direktvermarkter) ?? '');
  const [bilanzkreis, setBilanzkreis] = useState<boolean>(
    (v ? v.bilanzkreis_gesondert : pv ? pv.bilanzkreis_gesondert : ansicht.bilanzkreis_gesondert) === true,
  );
  // Voraussetzungen der Pauschaloption (A2 Abschn. 3.1.1)
  const [pauschal, setPauschal] = useState<PauschalAngaben>({
    steckersolar: pv ? (pv.steckersolar_kwp > 0 ? 'ja' : 'nein') : null,
    steckersolarKwp: pv && pv.steckersolar_kwp > 0 ? String(pv.steckersolar_kwp).replace('.', ',') : '',
    einBetreiber: pv != null,
    steckersolarDv: pv?.steckersolar_direktvermarktung_bestaetigt_am != null,
  });
  const [einverstanden, setEinverstanden] = useState<boolean>((v ? v.einverstaendnis : ansicht.einverstaendnis) === true);

  const schritte = schritteFuer(weg);
  const ab = giltAb(heute, heuteWeg, weg, v?.gueltig_ab ?? null);
  const vormerkenOffen = weg === 'marktpraemie_pauschal' && terminOffen;
  const stecker = steckersolarKwp(pauschal) ?? 0;
  const index = schritte.indexOf(schritt);

  // Das Register der Anlage und die Zählerrollen, sobald der Weg Zähler braucht.
  const brauchtZaehler = schritte.includes('zaehler');
  useEffect(() => {
    if (!brauchtZaehler || register != null) return;
    let aus = false;
    (async () => {
      try {
        const r = await api.messstellenRegister({ anlage: siteId });
        const strom = r.register.filter((z) => z.art === 'gemessen' && z.medium === 'Strom' && z.lebenszyklus !== 'archiviert');
        const ansichten = await Promise.all(strom.map((z) => mispelApi.zaehlerrolle(z.id).catch(() => null)));
        if (aus) return;
        const neu: Record<string, ZaehlerrolleAnsicht> = {};
        ansichten.forEach((a, i) => {
          if (a) neu[strom[i].id] = a;
        });
        setRegister(strom);
        setRollen(neu);
        const w: Record<Slot, string> = { z1Bezug: '', z1Abgabe: '', z2Laden: '', z2Entladen: '' };
        for (const s of SLOTS) {
          const treffer = strom.find(
            (z) => neu[z.id]?.rolle?.rolle === s.rolle && s.richtungen.includes(z.hauptgroesse.richtung),
          );
          if (treffer) w[s.slot] = treffer.id;
        }
        setWahl(w);
        setAngaben({ Z1: angabenAus(neu[w.z1Bezug] ?? neu[w.z1Abgabe]), Z2: angabenAus(neu[w.z2Laden] ?? neu[w.z2Entladen]) });
      } catch {
        if (!aus) setLadeFehler('Das Messstellen-Register konnte nicht geladen werden. Bitte versuchen Sie es erneut.');
      }
    })();
    return () => {
      aus = true;
    };
  }, [brauchtZaehler, register, siteId]);

  const zustand = (rolle: 'Z1' | 'Z2'): ZaehlerZustand => {
    const slots = SLOTS.filter((s) => s.rolle === rolle);
    return zaehlerZustand(slots.map((s) => (wahl[s.slot] ? rollen[wahl[s.slot]]?.urteil ?? null : null)));
  };
  const z1 = zustand('Z1');
  const z2 = zustand('Z2');
  // Z3 (A4, Speicher allein) erfasst das Messstellen-Register; der Dialog liest es nur für den Vorschlag.
  const z3 = zaehlerZustand(Object.values(rollen).filter((r) => r.rolle?.rolle === 'Z3').map((r) => r.urteil));
  const altFormelsatz = ansicht.formelsatz;
  const fv = useMemo(() => formelsatzVorschlag(z1, z2, altFormelsatz, ab, z3), [z1, z2, altFormelsatz, ab, z3]);

  const geh = (ziel: SchrittId) => {
    setFehler(null);
    setSchritt(ziel);
  };
  const weiter = () => geh(schritte[Math.min(index + 1, schritte.length - 1)]);
  const zurueck = index > 0 ? () => geh(schritte[index - 1]) : null;

  // ---------------------------------------------------------------- Zähler speichern
  async function zaehlerSpeichern() {
    const offen = SLOTS.filter((s) => !wahl[s.slot]);
    if (offen.length > 0) {
      setFehler({
        schritt: 'zaehler',
        satz: `Bitte wählen Sie für ${offen.map((s) => `${s.rolle} ${s.label}`).join(' und ')} eine Messstelle. Die Abgrenzungsoption rechnet mit Z1 und Z2 in beiden Richtungen (A1 S. 32–33).`,
      });
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const neu = { ...rollen };
      // Erst die Messstellen frei machen, die eine Rolle abgeben — sonst ist die Größe „schon vergeben“ (409).
      for (const s of SLOTS) {
        const bisher = Object.values(neu).find(
          (a) => a.rolle?.rolle === s.rolle && a.messstelle_id !== wahl[s.slot] &&
            s.richtungen.includes(register?.find((z) => z.id === a.messstelle_id)?.hauptgroesse.richtung ?? ''),
        );
        if (bisher) {
          neu[bisher.messstelle_id] = await mispelApi.zaehlerrolleSetzen(bisher.messstelle_id, {
            rolle: null, zaehlpunkt: null, messstellenbetreiber: null, eichstatus: null, eichfrist_bis: null,
            wertequelle: null, gueltig_ab: heute,
          });
        }
      }
      for (const s of SLOTS) {
        const id = wahl[s.slot];
        const g = angaben[s.rolle];
        const soll: ZaehlerrolleAendern = {
          rolle: s.rolle,
          zaehlpunkt: g.zaehlpunkt.trim() || null,
          messstellenbetreiber: g.messstellenbetreiber.trim() || null,
          eichstatus: g.eichstatus || null,
          eichfrist_bis: g.eichfrist_bis || null,
          wertequelle: g.wertequelle || null,
          gueltig_ab: heute,
        };
        const ist = neu[id]?.rolle;
        const gleich = ist && ist.rolle === soll.rolle && (ist.zaehlpunkt ?? null) === soll.zaehlpunkt &&
          (ist.messstellenbetreiber ?? null) === soll.messstellenbetreiber && (ist.eichstatus ?? null) === soll.eichstatus &&
          (ist.eichfrist_bis ?? null) === soll.eichfrist_bis && (ist.wertequelle ?? null) === soll.wertequelle;
        if (!gleich) neu[id] = await mispelApi.zaehlerrolleSetzen(id, soll);
      }
      setRollen(neu);
      const urteile = SLOTS.map((s) => neu[wahl[s.slot]]?.urteil ?? null);
      if (urteile.includes('nicht_tauglich')) {
        setFehler({
          schritt: 'zaehler',
          satz: 'Ein Zähler ist nicht tauglich (siehe Befund). Mit ihm lassen sich die Mengen nicht nach Anlage 1 bestimmen.',
        });
        return;
      }
      geh('formelsatz');
    } catch (e) {
      const a = fehlerText(e, 'Die Zähler konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.');
      setFehler({ schritt: 'zaehler', satz: a.message ?? 'Die Zähler konnten nicht gespeichert werden.' });
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- Förderweg eintragen
  async function eintragen() {
    setBusy(true);
    setFehler(null);
    const kurz = foerderweg(weg).kurzweg;
    const dvWeg = weg !== 'einspeiseverguetung' && !kurz;
    try {
      if (vormerkenOffen) {
        const neu = await mispelApi.pauschalVormerken(siteId, {
          ein_betreiber: pauschal.einBetreiber,
          steckersolar_kwp: stecker,
          steckersolar_direktvermarktung: stecker > 0 ? pauschal.steckersolarDv : null,
          direktvermarkter: dv.trim() ? dv.trim() : null,
          bilanzkreis_gesondert: bilanzkreis,
        });
        onGespeichert(neu);
        return;
      }
      const neu = await mispelApi.foerderwegSetzen(siteId, {
        foerderweg: weg,
        formelsatz: weg === 'marktpraemie_abgrenzung' ? formelsatz || null : null,
        einverstaendnis: einverstaendnisNoetig(weg, ab) ? einverstanden : false,
        gueltig_ab: ab,
        aw_regel: weg === 'marktpraemie_abgrenzung' && awRegel !== AW_UNBEKANNT ? awRegel : null,
        direktvermarkter: dvWeg && dv.trim() ? dv.trim() : null,
        bilanzkreis_gesondert: dvWeg ? bilanzkreis : null,
      });
      onGespeichert(neu);
    } catch (e) {
      const a = fehlerText(e, 'Der Förderweg konnte nicht eingetragen werden. Bitte versuchen Sie es erneut.');
      const ziel = a.code === 'netz' ? 'pruefen' : ablehnungSchritt(a);
      setSchritt(schritte.includes(ziel) ? ziel : 'pruefen');
      setFehler({ schritt: schritte.includes(ziel) ? ziel : 'pruefen', satz: ablehnungSatz(a) });
    } finally {
      setBusy(false);
    }
  }

  const fehlerZeile = (id: SchrittId) =>
    fehler?.schritt === id ? (
      <p className="vp-fw-fehler" role="alert" data-testid="fw-fehler">
        {fehler.satz}
      </p>
    ) : null;

  // Der MiSpeL-Check (MP-48, BK-48 A) vergleicht heute gegen die Abgrenzungsoption — nur, wenn sie nicht schon gilt.
  const mitCheck = weg === 'marktpraemie_abgrenzung' && heuteWeg !== 'marktpraemie_abgrenzung' && mispelCheck != null;
  // MP-27: unter der Pauschaloption der Check Haushalt (MP-29) — gleiche Regel „informieren, nicht drängen“.
  const mitCheckPauschal =
    weg === 'marktpraemie_pauschal' && heuteWeg !== 'marktpraemie_pauschal' && mispelCheckPauschal != null;
  const urteil = voraussetzungUrteil(aufbau, pauschal);

  // ---------------------------------------------------------------- Rümpfe
  let rumpf: ReactNode = null;
  if (schritt === 'foerderweg') {
    rumpf = (
      <section className="vp-fw-schritt" aria-labelledby={`${basis}-frage`} data-schritt="foerderweg">
        <p id={`${basis}-frage`} className="vp-fw-frage">
          Wie wird die Einspeisung Ihrer Anlage gefördert? Es gibt genau einen Förderweg je Einspeisestelle.
        </p>
        <div className="vp-fw-wahlen" role="radiogroup" aria-labelledby={`${basis}-frage`}>
          {foerderwegReihe(heuteWeg).map((f) => (
            <label
              key={f.wert}
              className={`vp-fw-wahl${weg === f.wert ? ' is-gewaehlt' : ''}${f.gesperrt ? ' is-gesperrt' : ''}`}
              data-weg={f.wert}
            >
              <input
                type="radio"
                name={`${basis}-weg`}
                value={f.wert}
                checked={weg === f.wert}
                disabled={f.gesperrt != null}
                onChange={() => {
                  setWeg(f.wert);
                  setFehler(null);
                }}
              />
              <span className="vp-fw-wahl-text">
                <b>
                  {f.begriff}
                  {f.wert === heuteWeg && <em className="vp-fw-heute">heute</em>}
                  {v && f.wert === v.foerderweg && <em className="vp-fw-heute">ab {tagText(v.gueltig_ab)} vorgemerkt</em>}
                  {pv && f.wert === 'marktpraemie_pauschal' && <em className="vp-fw-heute">vorgemerkt, Termin offen</em>}
                </b>
                <span>{f.satz}</span>
                <small>
                  {f.rechtsgrundlage} · {f.gesperrt ?? (f.netzladenMoeglich ? 'Netzladen: Ihre Einstellung' : 'Netzladen ausgeschlossen')}
                </small>
                {f.wert === 'marktpraemie_pauschal' && terminOffen && (
                  <small className="vp-fw-vormerkbar" data-testid="fw-pauschal-vormerkbar">
                    {PAUSCHAL_VORMERKBAR}
                  </small>
                )}
              </span>
            </label>
          ))}
        </div>
        {mitCheck && <div className="vp-fw-check">{mispelCheck}</div>}
        {mitCheckPauschal && <div className="vp-fw-check">{mispelCheckPauschal}</div>}
        {fehlerZeile('foerderweg')}
      </section>
    );
  } else if (schritt === 'zaehler') {
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="zaehler">
        <p className="vp-fw-frage">
          Die Abgrenzungsoption rechnet mit zwei geeichten Zählern: <b>Z1</b> am Netzanschluss und <b>Z2</b> am Speicher.
          Hinter Z2 darf nichts anderes hängen (Anlage 1 S. 25). Wählen Sie die Messstellen aus Ihrem Register.
        </p>
        {ladeFehler && (
          <p className="vp-fw-fehler" role="alert">
            {ladeFehler}
          </p>
        )}
        {!register && !ladeFehler && <p className="vp-fw-satz">Das Register wird geladen …</p>}
        {register && register.length === 0 && (
          <p className="vp-fw-hinweis" role="status">
            An dieser Anlage gibt es noch keine Messstelle für Strom. Legen Sie die Messstellen für Z1 und Z2 zuerst im
            Messstellen-Register an.
          </p>
        )}
        {register && register.length > 0 &&
          (['Z1', 'Z2'] as const).map((rolle) => {
            const z = zustand(rolle);
            const g = angaben[rolle];
            const setze = (feld: keyof ZaehlerAngaben, wert: string) =>
              setAngaben((alt) => ({ ...alt, [rolle]: { ...alt[rolle], [feld]: wert } }));
            const befunde = SLOTS.filter((s) => s.rolle === rolle)
              .flatMap((s) => (wahl[s.slot] ? rollen[wahl[s.slot]]?.befunde ?? [] : []))
              .filter((b, i, alle) => alle.findIndex((x) => x.code === b.code && x.messstelle === b.messstelle) === i);
            return (
              <fieldset key={rolle} className="vp-fw-zaehler" data-rolle={rolle}>
                <legend>
                  <b>
                    {rolle} · {ZAEHLER_TITEL[rolle]}
                  </b>
                  <span className={`vp-fw-urteil is-${z}`}>{URTEIL_TEXT[z]}</span>
                </legend>
                <div className="vp-fw-raster">
                  {SLOTS.filter((s) => s.rolle === rolle).map((s) => (
                    <VpPicker
                      key={s.slot}
                      id={`${basis}-${s.slot}`}
                      label={s.label}
                      placeholder="Messstelle wählen"
                      value={wahl[s.slot] || null}
                      options={register
                        .filter((m) => s.richtungen.includes(m.hauptgroesse.richtung))
                        .map((m) => ({ value: m.id, label: `${m.kennzeichen} ${m.name ?? ''}`.trim(), sub: m.hauptgroesse.richtung }))}
                      emptyText={() => 'Keine Messstelle mit dieser Richtung an der Anlage.'}
                      onChange={(id) => setWahl((alt) => ({ ...alt, [s.slot]: id }))}
                    />
                  ))}
                  <Input
                    label="Zählpunkt"
                    value={g.zaehlpunkt}
                    placeholder="DE + 31 Zeichen"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setze('zaehlpunkt', e.target.value.toUpperCase())}
                  />
                  <Input
                    label="Messstellenbetreiber"
                    value={g.messstellenbetreiber}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setze('messstellenbetreiber', e.target.value)}
                  />
                  <VpPicker
                    id={`${basis}-${rolle}-eich`}
                    label="Eichstatus"
                    value={g.eichstatus || 'unbekannt'}
                    options={[
                      { value: 'eichrechtskonform', label: 'eichrechtskonform' },
                      { value: 'nicht_eichrechtskonform', label: 'nicht eichrechtskonform' },
                      { value: 'unbekannt', label: 'nicht erhoben' },
                    ]}
                    onChange={(w) => setze('eichstatus', w === 'unbekannt' ? '' : w)}
                  />
                  <VpPicker
                    id={`${basis}-${rolle}-quelle`}
                    label="Wertequelle"
                    value={g.wertequelle || 'unbekannt'}
                    options={[
                      { value: 'messstellenbetreiber', label: 'Messstellenbetreiber', sub: 'maßgeblich für Nachweis und Abrechnung' },
                      { value: 'geraet', label: 'Gerät', sub: 'nicht maßgeblich (Tenor S. 28)' },
                      { value: 'unbekannt', label: 'nicht erhoben' },
                    ]}
                    onChange={(w) => setze('wertequelle', w === 'unbekannt' ? '' : w)}
                  />
                </div>
                {befunde.map((b) => (
                  <p key={`${b.code}-${b.messstelle}`} className={`vp-fw-befund is-${b.schwere}`}>
                    {b.satz}
                    {b.fundstelle ? ` (${b.fundstelle})` : ''}
                  </p>
                ))}
              </fieldset>
            );
          })}
        {fehlerZeile('zaehler')}
      </section>
    );
  } else if (schritt === 'formelsatz') {
    const optionen = fv.optionen.map((o) => {
      const f = FORMELSAETZE.find((x) => x.wert === o.wert)!;
      return {
        value: o.wert,
        label: f.titel,
        sub: `${f.satz} ${f.fundstelle}`,
        disabled: o.gesperrt != null,
        disabledHint: o.gesperrt,
      };
    });
    const wert = formelsatz || fv.vorschlag || '';
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="formelsatz">
        <p className={`vp-fw-hinweis${fv.vorschlag ? ' is-ok' : ''}`} role="status">
          {fv.vorschlag ? <b>Vorschlag: Formelsatz {fv.vorschlag}. </b> : null}
          {fv.satz}
        </p>
        <VpPicker
          id={`${basis}-formelsatz`}
          label="Formelsatz"
          value={wert || null}
          placeholder="Formelsatz wählen"
          options={optionen}
          hint="Andere Fallkonstellationen (A6–A9) unterstützt VoltPilot noch nicht."
          onChange={(w) => setFormelsatz(w)}
        />
        <p className="vp-fw-hinweis">
          <b>Gebunden bis {tagText(gebundenBis(ab))}.</b> Die Wahl zwischen vereinfachtem und umfangreicherem Formelsatz ist
          verbindlich und erst zum 01.01. änderbar — früher nur, wenn sich das Messkonzept ändert (A1 S. 24, S. 103).
        </p>
        <VpPicker
          id={`${basis}-aw`}
          label="Prämien-Viertelstunden Ihrer Anlage"
          value={awRegel}
          options={[
            ...AW_REGELN.map((r) => ({ value: r.wert, label: r.label })),
            { value: AW_UNBEKANNT, label: 'weiß ich nicht', sub: 'die Marktprämie bleibt vorläufig' },
          ]}
          hint="Die Übertragungsnetzbetreiber veröffentlichen, in welchen Viertelstunden der anzulegende Wert wegen negativer Preise auf null fällt — je nach Inbetriebnahme nach einer anderen Regel (§ 51, § 51b EEG; A1 S. 17 Fn. 8). Steht im Förderbescheid."
          onChange={setAwRegel}
        />
        {fehlerZeile('formelsatz')}
      </section>
    );
  } else if (schritt === 'voraussetzungen') {
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="voraussetzungen">
        <VoraussetzungenSchritt aufbau={aufbau} angaben={pauschal} onAngaben={setPauschal} basis={basis} />
        {fehlerZeile('voraussetzungen')}
      </section>
    );
  } else if (schritt === 'pauschalgrenzen') {
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="pauschalgrenzen">
        <PauschalgrenzenSchritt aufbau={aufbau} steckersolar={stecker} />
        {fehlerZeile('pauschalgrenzen')}
      </section>
    );
  } else if (schritt === 'pruefen' && vormerkenOffen) {
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="pruefen">
        <PauschalPruefen
          heuteBegriff={ansicht.begriff ?? 'der heutige Förderweg'}
          aufbau={aufbau}
          steckersolar={stecker}
          heute={heute}
          dv={dv}
          bilanzkreis={bilanzkreis}
        />
        {fehlerZeile('pruefen')}
      </section>
    );
  } else if (schritt === 'partner') {
    const noetig = einverstaendnisNoetig(weg, ab) && !vormerkenOffen;
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="partner">
        <p className="vp-fw-frage" id={`${basis}-partner`}>
          Wer vermarktet Ihren Strom?
        </p>
        <div className="vp-fw-wahlen" role="radiogroup" aria-labelledby={`${basis}-partner`}>
          <label className="vp-fw-wahl is-gewaehlt">
            <input type="radio" name={`${basis}-partner`} value="eigen" checked readOnly />
            <span className="vp-fw-wahl-text">
              <b>Eigener Direktvermarkter</b>
              <span>Ihr Vertrag mit einem Direktvermarkter Ihrer Wahl.</span>
            </span>
          </label>
          <label className="vp-fw-wahl is-gesperrt">
            <input type="radio" name={`${basis}-partner`} value="voltpilot" disabled />
            <span className="vp-fw-wahl-text">
              <b>VoltPilot-Partner</b>
              <span>folgt — die Auswahl aus den Angeboten läuft noch.</span>
            </span>
          </label>
        </div>
        <Input
          label="Name des Direktvermarkters"
          value={dv}
          maxLength={200}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDv(e.target.value)}
        />
        <label className="vp-fw-haken">
          <input type="checkbox" checked={bilanzkreis} onChange={(e) => setBilanzkreis(e.target.checked)} />
          <span>
            <b>Gesonderter Bilanzkreis</b>
            <small>Der Direktvermarkter führt die ganze Einspeisung in einem eigenen Bilanzkreis (§ 20 S. 2 EEG).</small>
          </span>
        </label>
        {noetig && (
          <>
            <p className="vp-fw-zwischen">Übergangszeit bis {tagText(EINVERSTAENDNIS_BIS)}</p>
            <label className="vp-fw-haken">
              <input type="checkbox" checked={einverstanden} onChange={(e) => setEinverstanden(e.target.checked)} />
              <span>
                <b>Netzbetreiber und Messstellenbetreiber sind einverstanden</b>
                <small>Bis {tagText(EINVERSTAENDNIS_BIS)} nötig (Tenor Ziff. 9a), danach nicht mehr.</small>
              </span>
            </label>
          </>
        )}
        {fehlerZeile('partner')}
      </section>
    );
  } else {
    const f = foerderweg(weg);
    const zeilen: [string, string][] = [['Förderweg', f.begriff]];
    if (weg === 'marktpraemie_abgrenzung') {
      zeilen.push(['Formelsatz', `${formelsatz || fv.vorschlag || '—'} · gebunden bis ${tagText(gebundenBis(ab))}`]);
      zeilen.push(['Zähler', `Z1 ${URTEIL_TEXT[z1]} · Z2 ${URTEIL_TEXT[z2]}`]);
      zeilen.push(['Prämien-Viertelstunden', awRegelLabel(awRegel === AW_UNBEKANNT ? null : awRegel)]);
      zeilen.push(['Direktvermarkter', dv.trim() || 'nicht angegeben']);
      zeilen.push(['Gesonderter Bilanzkreis', bilanzkreis ? 'ja' : 'nicht bestätigt']);
      if (einverstaendnisNoetig(weg, ab)) {
        zeilen.push(['Einverständnis Netz- und Messstellenbetreiber', einverstanden ? 'ja' : 'nicht bestätigt']);
      }
    }
    rumpf = (
      <section className="vp-fw-schritt" data-schritt="pruefen">
        <div className="vp-fw-ab">
          <span>Gilt ab</span>
          <b data-testid="fw-gilt-ab">{tagText(ab)}</b>
        </div>
        <p className="vp-fw-satz">
          {ab === heute
            ? 'Der Förderweg gilt ab heute.'
            : `Ein anderer Förderweg gilt immer ab dem ersten Tag eines Monats (§ 21b Abs. 1 S. 2 EEG). Bis dahin bleibt alles, wie es ist; VoltPilot stellt am ${tagText(ab)} um.`}
        </p>
        <dl className="vp-fw-kv">
          {zeilen.map(([k, w]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{w}</dd>
            </div>
          ))}
        </dl>
        <p className="vp-fw-zwischen">Was sich ab dann ändert</p>
        <ul className="vp-fw-folgen">
          {folgen(weg).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        {fehlerZeile('pruefen')}
      </section>
    );
  }

  // ---------------------------------------------------------------- Fuß
  const naechsterTitel = index < schritte.length - 1 ? schrittTitel(schritte[index + 1]) : null;
  const formelsatzOk = !!(formelsatz || fv.vorschlag) &&
    !fv.optionen.find((o) => o.wert === (formelsatz || fv.vorschlag))?.gesperrt;
  let primaer: ReactNode;
  if (schritt === 'foerderweg' && (mitCheck || mitCheckPauschal)) {
    // BK-48 A: „Weiter zur Einrichtung“ und „Beim heutigen Förderweg bleiben“ gleich groß — informieren, nicht drängen.
    primaer = (
      <Button variant="primary" className="vp-fw-gleich" onClick={weiter}>
        Weiter zur Einrichtung
      </Button>
    );
  } else if (schritt === 'foerderweg') {
    primaer = (
      <Button variant="primary" onClick={weiter}>
        Weiter: {naechsterTitel}
      </Button>
    );
  } else if (schritt === 'zaehler') {
    primaer = (
      <Recht aktion="messstelle.bearbeiten">
        <Button variant="primary" onClick={() => void zaehlerSpeichern()} disabled={busy || !register?.length} aria-busy={busy || undefined}>
          {busy ? 'Wird gespeichert …' : `Weiter: ${naechsterTitel}`}
        </Button>
      </Recht>
    );
  } else if (schritt === 'formelsatz') {
    primaer = (
      <Button
        variant="primary"
        onClick={() => {
          if (!formelsatzOk) {
            setFehler({ schritt: 'formelsatz', satz: fv.vorschlag ? 'Bitte wählen Sie einen Formelsatz, der zu Ihren Zählern passt.' : fv.satz });
            return;
          }
          if (!formelsatz && fv.vorschlag) setFormelsatz(fv.vorschlag);
          weiter();
        }}
      >
        Weiter: {naechsterTitel}
      </Button>
    );
  } else if (schritt === 'voraussetzungen') {
    primaer = (
      <Button
        variant="primary"
        disabled={!urteil.weiter}
        className="vp-fw-umbruch"
        data-testid="fw-weiter-voraussetzungen"
        onClick={() => {
          if (!urteil.weiter) return;
          weiter();
        }}
      >
        Weiter: {naechsterTitel}
      </Button>
    );
  } else if (schritt === 'pauschalgrenzen') {
    primaer = (
      <Button variant="primary" onClick={weiter}>
        Weiter: {naechsterTitel}
      </Button>
    );
  } else if (schritt === 'partner') {
    primaer = (
      <Button variant="primary" onClick={weiter}>
        Weiter: {naechsterTitel}
      </Button>
    );
  } else {
    primaer = (
      <Recht aktion="anlage.verwalten">
        <Button variant="primary" onClick={() => void eintragen()} disabled={busy} aria-busy={busy || undefined} data-testid="fw-eintragen">
          {busy
            ? 'Wird eingetragen …'
            : vormerkenOffen
              ? 'Vormerken'
              : ab === heute
                ? 'Ab heute eintragen'
                : `Ab ${tagText(ab).slice(0, 6)} eintragen`}
        </Button>
      </Recht>
    );
  }
  const fuss = (
    <>
      {schritt === 'foerderweg' && (mitCheck || mitCheckPauschal) ? (
        <Button variant="outline" className="vp-fw-gleich" onClick={onClose}>
          Beim heutigen Förderweg bleiben
        </Button>
      ) : zurueck ? (
        <Button variant="ghost" onClick={zurueck}>
          Zurück
        </Button>
      ) : (
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
      )}
      {primaer}
    </>
  );

  return (
    <AnlegenDialog
      titel="Förderweg ändern"
      schritte={schritte.map(schrittTitel)}
      aktiv={index + 1}
      onClose={onClose}
      onBack={zurueck}
      footer={fuss}
    >
      <div className="vp-fw">{rumpf}</div>
    </AnlegenDialog>
  );
}
