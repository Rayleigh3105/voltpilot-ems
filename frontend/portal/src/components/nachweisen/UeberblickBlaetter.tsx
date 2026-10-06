import { useEffect, useId, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { api, type EnergiemanagementPerson } from '../../api';
import { seitenSprung, sprungKlick, type Sprung } from '../../entscheid';
import { STARTWERTE } from '../../energiemanagement';
import * as E from '../../energiemanagementPortal';
import { dokumentRoute, energiemanagementRoute, type Route } from '../../nav';
import {
  FESTHALTEN,
  IN_DER_WIEDERVORLAGE,
  TRIFFT_NICHT_ZU,
  ueberfaelligWort,
  type TeilGruppe,
  type TeilStand,
  type TeilZustand,
} from '../../nachweisStand';
import { buendel, standTag, type Eintrag } from '../../wiedervorlage';
import { DokumentAnlegenDialog } from '../DokumentDialoge';
import { EinsichtRecht } from '../EinsichtRecht';
import { FristDatum, Kennzeichentext } from '../FristDatum';
import { VpPicker } from '../VpPicker';
import { ErklaerKnopf } from './ErklaerKnopf';
import { TRIFFT_NICHT_ZU as TRIFFT_NICHT_ZU_ERKLAERUNG } from './nachweisBegriffe';
import { NwBlatt } from './NwBlatt';
import { AntwortKarten, HinweisZeile, PruefZeilen, SchrittAnzeige, Wortlaut } from './NwSchritte';
import { NwZeichen, type ZeichenArt } from './NwZeichen';
import './Nachweisen.css';

const ZEICHEN: Record<TeilZustand, ZeichenArt> = { festgehalten: 'festgehalten', offen: 'offen', entwurf: 'entwurf', ueber: 'ueber' };

export const WEITER = 'Weiter';
export const ABBRECHEN = 'Abbrechen';
export const AUFHEBEN = 'Aufheben';
export const ALS_DOKUMENT = 'Als Dokument festhalten';
export const ALS_DOKUMENT_ZUSATZ = 'Text oder Verweis';
export const DORT_FESTHALTEN = 'Dort festhalten';
export const TRIFFT_NICHT_ZU_KARTE = 'Trifft zurzeit nicht zu';
export const TRIFFT_NICHT_ZU_ZUSATZ = 'mit Grund';
export const WARUM = 'Warum trifft es zurzeit nicht zu?';
export const WER = 'Wer hat entschieden?';
export const WIE_FESTHALTEN = 'Wie halten Sie es fest?';

/** Wohin ein Teil führt, der an seinem Ort entsteht: das Wort dieses Orts (höchstens drei Wörter). */
const ORT_WORT: Readonly<Record<string, string>> = {
  aufgaben: 'Aufgaben',
  energetische_bewertung: 'Energetische Bewertung',
  bezugsbasen: 'Kennzahlen',
  massnahmen: 'Maßnahmen',
  interne_audits: 'Audits',
  feststellungen: 'Feststellungen',
  managementbewertung: 'Managementbewertung',
  berichte: 'Berichte',
};

/**
 * Das Blatt einer Gruppe (§6.3, Mock `r2-U-teil`): ein Fakt je Teil („Energiepolitik · Fassung 2“), offene mit
 * „Festhalten“. Eine Zeile führt zu ihrem Teil: ein überfälliger zur Frist, ein offener ins Festhalten.
 */
export function GruppenBlatt({
  gruppe,
  offen,
  onClose,
  onTeil,
}: {
  gruppe: TeilGruppe;
  offen: boolean;
  onClose: () => void;
  onTeil: (t: TeilStand) => void;
}) {
  return (
    <NwBlatt open={offen} titel={gruppe.wort} onClose={onClose} testId="gruppen-blatt">
      <ul className="vp-nw-tzl">
        {gruppe.teile.map((t) => (
          <li key={t.teil}>
            <button type="button" className={`vp-nw-tz is-${t.zustand}`} onClick={() => onTeil(t)} data-testid={`gruppen-teil-${t.teil}`}>
              <NwZeichen art={ZEICHEN[t.zustand]} />
              <span className="vp-nw-tz-name">{t.wort}</span>
              {t.zustand === 'offen' ? (
                <span className="vp-nw-tz-verb">{FESTHALTEN}</span>
              ) : (
                <>
                  {t.fakt && <span className="vp-nw-tz-fakt">{t.fakt}</span>}
                  <span className="vp-nw-tz-chev" aria-hidden="true">
                    <Icon name="chevron-right" size={16} />
                  </span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </NwBlatt>
  );
}

/**
 * „6 Fristen überfällig“ (§6.3, Mock `r2-U-frist`): dieselben Fristen wie in der Wiedervorlage, gleiche Arbeit gebündelt
 * („4 Bezugsbasen überprüfen“), je mit Datumsblock; darunter der Weg in die Wiedervorlage.
 */
export function FristenBlatt({
  offen,
  eintraege,
  onClose,
  springe,
}: {
  offen: boolean;
  eintraege: readonly Eintrag[];
  onClose: () => void;
  springe: (s: Sprung) => void;
}) {
  const zur = seitenSprung(energiemanagementRoute('wiedervorlage'));
  return (
    <NwBlatt open={offen} titel={`${eintraege.length} ${ueberfaelligWort(eintraege.length)}`} onClose={onClose} testId="fristen-blatt">
      <ul className="vp-fzl vp-nw-fristen">
        {buendel(eintraege).map((b) => {
          const inhalt = (
            <>
              <FristDatum {...b.frist} ton="ueber" />
              <span className="vp-fz-text">
                <span className="vp-fz-titel">
                  <Kennzeichentext text={b.aufgabe} />
                </span>
              </span>
              <span className="vp-fz-chev" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </>
          );
          return (
            <li key={b.key}>
              {b.sprung ? (
                <a className="vp-fz" href={b.sprung.hash} onClick={sprungKlick(b.sprung, springe)} data-testid={`frist-${b.key}`}>
                  {inhalt}
                </a>
              ) : (
                <div className="vp-fz">{inhalt}</div>
              )}
            </li>
          );
        })}
      </ul>
      <a className="vp-nw-link" href={zur.hash} onClick={sprungKlick(zur, springe)} data-testid="fristen-wiedervorlage">
        {IN_DER_WIEDERVORLAGE}
      </a>
    </NwBlatt>
  );
}

type Weg = 'dokument' | 'ort' | 'vermerk';
type Schritt = 'wie' | 'grund' | 'pruefen';

/**
 * Das Blatt eines Teils (§6.10 „Einen offenen Teil festhalten“, Entscheid 5): ein offener Teil wird festgehalten - als
 * Dokument, an seinem Ort oder als „Trifft bei uns zurzeit nicht zu“ mit Grund und der Person, die es entschieden hat
 * (höchstens drei Schritte, Prüfen am Ende). Ein Teil mit Vermerk zeigt den Grund und lässt ihn aufheben.
 */
export function TeilBlatt({
  teil,
  offen,
  onClose,
  onNavigate,
  onGeaendert,
  heute,
}: {
  teil: TeilStand;
  offen: boolean;
  onClose: () => void;
  onNavigate: (r: Route) => void;
  /** Ein Vermerk wurde festgehalten oder aufgehoben: der Überblick lädt neu. */
  onGeaendert: () => void;
  /** Der Tag der Route („30.04.2029“) - der Vermerk gilt ab heute (Entscheid 13). */
  heute: string;
}) {
  if (teil.vermerk && teil.zustand !== 'offen') {
    return <VermerkBlatt teil={teil} offen={offen} onClose={onClose} onGeaendert={onGeaendert} />;
  }
  return <FesthaltenBlatt teil={teil} offen={offen} onClose={onClose} onNavigate={onNavigate} onGeaendert={onGeaendert} heute={heute} />;
}

function FesthaltenBlatt({
  teil,
  offen,
  onClose,
  onNavigate,
  onGeaendert,
  heute,
}: {
  teil: TeilStand;
  offen: boolean;
  onClose: () => void;
  onNavigate: (r: Route) => void;
  onGeaendert: () => void;
  heute: string;
}) {
  const basis = `nw-tb-${useId().replace(/:/g, '')}`;
  const [weg, setWeg] = useState<Weg | null>(null);
  const [schritt, setSchritt] = useState<Schritt>('wie');
  const [satz, setSatz] = useState('');
  const [person, setPerson] = useState<string | null>(null);
  const [personen, setPersonen] = useState<EnergiemanagementPerson[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anlegen, setAnlegen] = useState(false);

  useEffect(() => {
    if (!offen) return;
    setWeg(null);
    setSchritt('wie');
    setSatz('');
    setPerson(null);
    setFehler(null);
  }, [offen, teil.teil]);

  useEffect(() => {
    if (schritt !== 'grund' || personen) return;
    let aktiv = true;
    api.energiemanagementPersonen().then(
      (r) => aktiv && setPersonen(r.personen.filter((p) => p.zustand === 'aktiv')),
      () => aktiv && setPersonen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [schritt, personen]);

  const lang = satz.trim().length;
  const satzFehler =
    lang < STARTWERTE.begruendung_zeichen_mindestens || lang > STARTWERTE.begruendung_zeichen_hoechstens ? E.BEGRUENDUNG_HINWEIS : null;
  const personName = personen?.find((p) => p.id === person)?.name ?? '';

  const optionen = [
    teil.dokumentArt
      ? { wert: 'dokument' as const, titel: ALS_DOKUMENT, zusatz: ALS_DOKUMENT_ZUSATZ }
      : { wert: 'ort' as const, titel: DORT_FESTHALTEN, zusatz: ORT_WORT[teil.teil] ?? null },
    { wert: 'vermerk' as const, titel: TRIFFT_NICHT_ZU_KARTE, zusatz: TRIFFT_NICHT_ZU_ZUSATZ },
  ];

  function weiter() {
    setFehler(null);
    if (schritt === 'wie') {
      if (weg === 'dokument') return setAnlegen(true);
      if (weg === 'ort') return onNavigate(teil.ort);
      if (weg === 'vermerk') return setSchritt('grund');
      return;
    }
    if (schritt === 'grund') {
      if (satzFehler) return setFehler(satzFehler);
      if (!person) return setFehler('Bitte wählen Sie die Person, die entschieden hat.');
      return setSchritt('pruefen');
    }
    void festhalten();
  }

  async function festhalten() {
    if (!person) return;
    setBusy(true);
    try {
      await api.energiemanagementTeilVermerkAnlegen({ teil: teil.teil, satz: satz.trim(), entschieden_von: person });
      onGeaendert();
      onClose();
    } catch (e) {
      setFehler(E.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  const vermerkWeg = weg === 'vermerk' && schritt !== 'wie';
  return (
    <>
      <NwBlatt
        open={offen && !anlegen}
        titel={`${teil.wort} festhalten`}
        onClose={onClose}
        testId="teil-blatt"
        fuss={
          <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
            <div className="vp-nw-knoepfe">
              <Button onClick={weiter} disabled={busy || (schritt === 'wie' && !weg)} fullWidth data-testid="teil-weiter">
                {schritt === 'pruefen' ? FESTHALTEN : WEITER}
              </Button>
              <Button variant="ghost" onClick={schritt === 'wie' ? onClose : () => setSchritt(schritt === 'pruefen' ? 'grund' : 'wie')}>
                {schritt === 'wie' ? ABBRECHEN : 'Zurück'}
              </Button>
            </div>
          </EinsichtRecht>
        }
      >
        {vermerkWeg && <SchrittAnzeige nr={schritt === 'grund' ? 2 : 3} von={3} />}
        {schritt === 'wie' && (
          <AntwortKarten frage={WIE_FESTHALTEN} optionen={optionen} wert={weg} onWahl={(w) => setWeg(w)} testid="teil-weg" />
        )}
        {schritt === 'grund' && (
          <>
            <div className="vp-nw-feld">
              <label className="vp-nw-frage" htmlFor={`${basis}-satz`}>
                {WARUM}
              </label>
              <textarea
                id={`${basis}-satz`}
                rows={3}
                value={satz}
                onChange={(e) => setSatz(e.target.value)}
                aria-invalid={fehler === satzFehler && !!satzFehler}
                data-testid="teil-satz"
              />
            </div>
            <VpPicker
              id={`${basis}-person`}
              label={WER}
              options={(personen ?? []).map((p) => ({ value: p.id, label: p.name, sub: p.funktion }))}
              value={person}
              onChange={(v) => setPerson(v)}
              loading={personen === null}
            />
            <HinweisZeile icon="info" titel={TRIFFT_NICHT_ZU} knopf={<ErklaerKnopf erklaerung={TRIFFT_NICHT_ZU_ERKLAERUNG} klein />} />
          </>
        )}
        {schritt === 'pruefen' && (
          <PruefZeilen
            testid="teil-pruefen"
            zeilen={[
              { etikett: 'Teil', wert: teil.wort },
              { etikett: 'Grund', wert: satz.trim(), onAendern: () => setSchritt('grund') },
              { etikett: 'Entschieden von', wert: personName, onAendern: () => setSchritt('grund') },
              { etikett: 'Ab', wert: heute },
            ]}
          />
        )}
        {fehler && (
          <p className="vp-nw-fehler" role="alert" data-testid="teil-fehler">
            {fehler}
          </p>
        )}
      </NwBlatt>
      {anlegen && teil.dokumentArt && (
        <DokumentAnlegenDialog
          vorArt={teil.dokumentArt}
          onClose={() => {
            setAnlegen(false);
            onClose();
          }}
          onAngelegt={(d) => {
            setAnlegen(false);
            onNavigate(dokumentRoute(d.id));
          }}
        />
      )}
    </>
  );
}

function VermerkBlatt({
  teil,
  offen,
  onClose,
  onGeaendert,
}: {
  teil: TeilStand;
  offen: boolean;
  onClose: () => void;
  onGeaendert: () => void;
}) {
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = teil.vermerk!;

  async function aufheben() {
    setBusy(true);
    setFehler(null);
    try {
      await api.energiemanagementTeilVermerkAufheben(v.id);
      onGeaendert();
      onClose();
    } catch (e) {
      setFehler(E.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open={offen}
      titel={teil.wort}
      onClose={onClose}
      testId="vermerk-blatt"
      fuss={
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button variant="outline" onClick={() => void aufheben()} disabled={busy} fullWidth data-testid="vermerk-aufheben">
            {AUFHEBEN}
          </Button>
        </EinsichtRecht>
      }
    >
      <HinweisZeile icon="check" titel={TRIFFT_NICHT_ZU_KARTE} knopf={<ErklaerKnopf erklaerung={TRIFFT_NICHT_ZU_ERKLAERUNG} klein />} testid="vermerk-status" />
      <Wortlaut absaetze={[[{ text: v.satz, neu: false }]]} label="Grund" testid="vermerk-satz" />
      <PruefZeilen
        zeilen={[
          { etikett: 'Entschieden von', wert: v.entschieden_von.name },
          { etikett: 'Ab', wert: standTag(v.entschieden_am) },
        ]}
      />
      {fehler && (
        <p className="vp-nw-fehler" role="alert">
          {fehler}
        </p>
      )}
    </NwBlatt>
  );
}
