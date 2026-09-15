import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type Bezugsflaeche,
  type Bezugsgroesse,
  type Kennzahl,
  type KennzahlFassung,
  type KennzahlRechenform,
  type KennzahlVorlageBezugsgroesse,
  type KennzahlVorlageMessstelle,
  type KennzahlVorschau,
  type Kostenstelle,
  type MessstelleRegisterZeile,
  type OrtsbaumAmStichtag,
  type Prozess,
  type StandortAmStichtag,
  type Unternehmen,
} from '../api';
import { currentUser } from '../auth';
import { UEMS_GELTUNGSBEREICH, UEMS_RECHENFORM, UEMS_VERANTWORTLICH, UEMS_VORLAGE, UEMS_ZWECK } from '../glossar';
import * as A from '../kennzahlAnlegen';
import { PERIODEN_NAME } from '../kennzahlKarte';
import { ANTEIL, RECHENFORMEN, ZUSAMMENFASSUNG } from '../uemsKennzahl';
import { GesamtwertDialog } from './GesamtwertDialog';
import { VpPicker } from './VpPicker';
import './Gesamtwert.css';
import './KennzahlAnlegen.css';

type OrtsDaten = {
  unternehmen: Unternehmen | null;
  standorte: StandortAmStichtag[];
  baeume: OrtsbaumAmStichtag[];
  prozesse: Prozess[];
  kostenstellen: Kostenstelle[];
};

async function ladeOrtsDaten(): Promise<OrtsDaten> {
  // Ohne Standorte gibt es keinen Ortsbaum — dann scheitert das Laden ganz. Unternehmen, Prozesse und Kostenstellen
  // sind eigene Gruppen der Auswahl: fehlt eine dieser Antworten, fehlt genau ihre Gruppe, nie ein Ort.
  const [unternehmen, standorte, prozesse, kostenstellen] = await Promise.all([
    api.unternehmen().catch(() => null),
    api.standorte(),
    api.prozesse().then((p) => p.prozesse, () => [] as Prozess[]),
    api.kostenstellen().then((k) => k.kostenstellen, () => [] as Kostenstelle[]),
  ]);
  const baeume = await Promise.all(standorte.standorte.map((s) => api.standortOrte(s.id).catch(() => null)));
  return {
    unternehmen,
    standorte: standorte.standorte,
    baeume: baeume.filter((b): b is OrtsbaumAmStichtag => b !== null),
    prozesse,
    kostenstellen,
  };
}

/** Die Quelle von „Kopieren“ an der Kennzahl-Seite (§5.2). */
export type KopieVon = { kennzahl: Kennzahl; fassungen: KennzahlFassung[] };

/**
 * Der Assistent „Kennzahl anlegen“ (UEMS AP-11 IP-14, §5.1) und „Kopieren“ (§5.2) im Rahmen des `GesamtwertDialog`
 * (PR 689): zentriertes `Modal`, dieselbe Schritt-Leiste, derselbe Fuß — fünf Schritte Vorlage · Menge · Bezugsgröße ·
 * Geltungsbereich · Vorschau, dann Fertig. Eine Zusammenfassung (§5.6) wählt in Schritt 2 Kennzahlen, Schritt 3 entfällt.
 *
 * ⚠ Vor „Anlegen“ wird NICHTS gespeichert (K1, K20): Schritt 5 ruft nur `POST /api/v1/kennzahlen/vorschau`
 * (Nur-Lese-Transaktion); `POST /api/v1/kennzahlen` fällt allein auf den Knopf „Anlegen“.
 * ⚠ Jeder Prüfsatz kommt aus dem Zwilling `uemsKennzahl.ts` über `kennzahlAnlegen.ts` — hier steht keine Regel.
 * ⚠ Der Hebel „Mehrere Messstellen?“ öffnet den Gesamtwert-Assistenten GESTAPELT darüber und kehrt mit dem neuen
 * Gesamtwert als Menge zurück; der Gesamtwert entsteht an der Anlage der ersten gewählten Messstelle.
 *
 * Render-only: jede Ableitung liegt im reinen `src/kennzahlAnlegen.ts`.
 */
export function KennzahlAnlegenDialog({
  open,
  quelle = null,
  angemeldet,
  onClose,
  onAngelegt,
  onZurKennzahl,
}: {
  open: boolean;
  /** Gesetzt = „Kopieren“: Form, Name und Zweck kommen von dieser Kennzahl. */
  quelle?: KopieVon | null;
  /** Wer angemeldet ist — belegt „Verantwortlich“ vor. */
  angemeldet?: string;
  onClose: () => void;
  /** Die neue Kennzahl ist angelegt — der Wirt lädt seine Liste neu. */
  onAngelegt?: (kennzahl: Kennzahl) => void;
  onZurKennzahl?: (id: string) => void;
}) {
  const kopie = useMemo(() => (quelle ? A.kopieQuelle(quelle.kennzahl, quelle.fassungen) : null), [quelle]);
  const person = angemeldet ?? currentUser().name;

  const [schritt, setSchritt] = useState<A.Schritt>(1);
  const [entwurf, setEntwurf] = useState<A.Entwurf>(() => A.leererEntwurf(person, kopie));

  const [register, setRegister] = useState<MessstelleRegisterZeile[] | null>(null);
  const [registerFehler, setRegisterFehler] = useState(false);
  const [registerLauf, setRegisterLauf] = useState(0);
  const [bezug, setBezug] = useState<{ bezugsgroessen: Bezugsgroesse[]; bezugsflaechen: Bezugsflaeche[] } | null>(null);
  const [bezugFehler, setBezugFehler] = useState(false);
  const [ortsDaten, setOrtsDaten] = useState<OrtsDaten | null>(null);
  const [orteFehler, setOrteFehler] = useState(false);
  const [kennzahlen, setKennzahlen] = useState<Kennzahl[] | null>(null);
  const [kennzahlenFehler, setKennzahlenFehler] = useState(false);
  const [ladeLauf, setLadeLauf] = useState(0);

  const [vorschau, setVorschau] = useState<{ schluessel: string; antwort: KennzahlVorschau } | null>(null);
  const [vorschauFehler, setVorschauFehler] = useState<string | null>(null);
  const [vorschauLauf, setVorschauLauf] = useState(0);
  const [laeuft, setLaeuft] = useState(false);
  const [anlegenFehler, setAnlegenFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<Kennzahl | null>(null);
  const [gesamtwertAn, setGesamtwertAn] = useState<A.Anlage | null>(null);

  // Beim Öffnen: ein frischer Entwurf — nichts aus einem abgebrochenen Lauf bleibt stehen.
  useEffect(() => {
    if (!open) return;
    setSchritt(1);
    setEntwurf(A.leererEntwurf(person, kopie));
    setVorschau(null);
    setVorschauFehler(null);
    setAnlegenFehler(null);
    setErgebnis(null);
    setGesamtwertAn(null);
    // `person` ist je Sitzung fest; ein neuer Entwurf entsteht nur beim Öffnen oder mit einer anderen Quelle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kopie]);

  useEffect(() => {
    if (!open) return undefined;
    let aktiv = true;
    setBezug(null);
    setBezugFehler(false);
    setOrtsDaten(null);
    setOrteFehler(false);
    setKennzahlen(null);
    setKennzahlenFehler(false);
    api.bezugsgroessen().then(
      (b) => aktiv && setBezug(b),
      () => aktiv && setBezugFehler(true),
    );
    ladeOrtsDaten().then(
      (o) => aktiv && setOrtsDaten(o),
      () => aktiv && setOrteFehler(true),
    );
    api.kennzahlen().then(
      (k) => aktiv && setKennzahlen(k.kennzahlen),
      () => aktiv && setKennzahlenFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [open, ladeLauf]);

  // Das Register lädt getrennt: nach einem neuen Gesamtwert kommt es neu, ohne dass die Auswahl dazwischen leer wird.
  useEffect(() => {
    if (!open) return undefined;
    let aktiv = true;
    setRegisterFehler(false);
    api.messstellenRegister().then(
      (r) => aktiv && setRegister(r.register),
      () => aktiv && setRegisterFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [open, registerLauf]);

  const form = entwurf.rechenform;
  const woerter = A.schrittWoerter(form);
  const zeileVon = (kz: string | null) => (kz && register ? (register.find((z) => z.kennzeichen === kz) ?? null) : null);
  const mengeZeile = entwurf.menge.length === 1 ? zeileVon(entwurf.menge[0]) : null;
  const mengeSeite: A.Seite | null = mengeZeile ? { art: 'messstelle', zeile: mengeZeile } : null;
  let bezugSeite: A.Seite | null = null;
  if (form === ANTEIL) {
    const z = zeileVon(entwurf.bezug);
    bezugSeite = z ? { art: 'messstelle', zeile: z } : null;
  } else if (entwurf.bezug !== null) {
    const bg = bezug?.bezugsgroessen.find((b) => b.kennzeichen === entwurf.bezug);
    bezugSeite = bg ? { art: 'bezugsgroesse', bg } : null;
  }
  const paare = (kennzahlen ?? []).filter((k) => entwurf.paare.includes(k.kennzeichen));
  const pruefung =
    form === ZUSAMMENFASSUNG ? A.pruefePaare(paare) : form ? A.pruefeBerechnung(form, mengeSeite, bezugSeite, entwurf.periode) : null;

  const orte = useMemo(() => (ortsDaten ? A.geltungsOrte({ ...ortsDaten, messstellen: register ?? [] }) : null), [ortsDaten, register]);
  const ort = orte?.find((o) => o.wert === entwurf.geltung) ?? null;
  const eingangsOrte =
    form === ZUSAMMENFASSUNG
      ? paare.map((k) => A.eingangOrtKennzahl(k, orte ?? []))
      : [mengeSeite, bezugSeite].filter((s): s is A.Seite => s !== null).map((s) => A.eingangOrt(s, orte ?? []));
  const geltungFehler = ort ? A.pruefeGeltung(ort, eingangsOrte) : null;
  const rechte = ort ? A.rechteGeltung(ort) : null;

  // Der Name-VORSCHLAG folgt Vorlage und Geltungsbereich, bis der Kunde ihn selbst anfasst.
  useEffect(() => {
    if (entwurf.nameBeruehrt) return;
    const name = A.nameVorschlag(entwurf, kopie, ort);
    if (name !== entwurf.name) setEntwurf((e) => (e.nameBeruehrt ? e : { ...e, name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entwurf.wahl, entwurf.geltung, entwurf.nameBeruehrt, ort, kopie]);

  // Schritt 4 schlägt den Geltungsbereich vor — einmal, sichtbar, änderbar.
  useEffect(() => {
    if (schritt !== 4 || entwurf.geltung !== null || !orte) return;
    const w = A.geltungVorschlag(form, orte, mengeSeite, bezugSeite);
    if (w) setEntwurf((e) => (e.geltung === null ? { ...e, geltung: w } : e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, orte]);

  const anfrageJetzt = ort && form ? A.anfrage(entwurf, ort) : null;
  const vorschauSchluessel = anfrageJetzt ? JSON.stringify(anfrageJetzt) : null;
  useEffect(() => {
    if (schritt !== 5 || anfrageJetzt === null || vorschauSchluessel === null) return undefined;
    let aktiv = true;
    setVorschauFehler(null);
    api.kennzahlVorschau(anfrageJetzt).then(
      (antwort) => aktiv && setVorschau({ schluessel: vorschauSchluessel, antwort }),
      (e) => aktiv && setVorschauFehler(A.ablehnungSatz(e, A.VORSCHAU_FEHLER)),
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, vorschauSchluessel, vorschauLauf]);
  const vorschauAntwort = vorschau !== null && vorschau.schluessel === vorschauSchluessel ? vorschau.antwort : null;

  const anlegen = async () => {
    if (anfrageJetzt === null || !A.anlegenMoeglich(vorschauAntwort) || laeuft) return;
    setLaeuft(true);
    setAnlegenFehler(null);
    try {
      const neu = await api.kennzahlAnlegen(anfrageJetzt);
      setErgebnis(neu);
      onAngelegt?.(neu);
      setSchritt(6);
    } catch (e) {
      setAnlegenFehler(A.ablehnungSatz(e, A.ANLEGEN_FEHLER));
    } finally {
      setLaeuft(false);
    }
  };

  const setze = (patch: Partial<A.Entwurf>) => setEntwurf((e) => ({ ...e, ...patch }));

  return (
    <>
      <Modal open={open} onClose={onClose} title={schritt === 6 ? A.TITEL_FERTIG : kopie ? A.TITEL_KOPIE : A.TITEL} footer={Fuss()}>
        <div className="vp-gw vp-kza" data-testid="kennzahl-anlegen">
          <ol className="vp-steps" aria-label="Schritte">
            {woerter.map((wort, i) => {
              const n = i + 1;
              const state = n < schritt ? 'done' : n === schritt ? 'active' : 'todo';
              return (
                <li key={n} className={`vp-step vp-step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                  <span className="vp-step-num" aria-hidden="true">
                    {state === 'done' ? <Icon name="check" size={13} strokeWidth={3} /> : n}
                  </span>
                  <span className="vp-step-label">{wort}</span>
                </li>
              );
            })}
          </ol>

          {/* ⚠ Wie im GesamtwertDialog als FUNKTIONEN aufgerufen, nicht als `<Schritt/>` gerendert: eine je Render neu
              definierte Komponente würde ihre Picker bei jeder Auswahl neu mounten. */}
          {schritt === 1 && SchrittVorlage()}
          {schritt === 2 && (form === ZUSAMMENFASSUNG ? SchrittPaare() : SchrittMenge())}
          {schritt === 3 && SchrittBezug()}
          {schritt === 4 && SchrittGeltung()}
          {schritt === 5 && SchrittVorschau()}
          {schritt === 6 && SchrittFertig()}
        </div>
      </Modal>
      {gesamtwertAn && (
        <GesamtwertDialog
          open
          siteId={gesamtwertAn.id}
          onClose={() => setGesamtwertAn(null)}
          onGespeichert={(m) => {
            setEntwurf((e) => A.nachGesamtwert(e, m.kennzeichen));
            setRegisterLauf((n) => n + 1);
          }}
        />
      )}
    </>
  );

  // ---------------------------------------------------------------- Schritte

  function Kopf({ n, titel, sub }: { n: number; titel: string; sub?: string | null }) {
    return (
      <>
        <p className="vp-gw-eyebrow">{A.eyebrow(n, woerter[n - 1])}</p>
        <h3 className="vp-gw-title">{titel}</h3>
        {sub && <p className="vp-gw-sub">{sub}</p>}
      </>
    );
  }

  function SchrittVorlage() {
    if (kopie) {
      return (
        <>
          {Kopf({ n: 1, titel: A.kopieTitel(kopie), sub: A.KOPIE_SUB })}
          <div className="vp-gw-step-body">
            <div className="vp-kza-quelle" data-testid="kennzahl-kopie-quelle">
              <b>{kopie.name}</b>
              <small>
                {UEMS_RECHENFORM[kopie.rechenform]}
                {kopie.zweck ? ` · ${kopie.zweck}` : ''}
              </small>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        {Kopf({ n: 1, titel: A.S1_TITEL, sub: A.S1_SUB })}
        <div className="vp-gw-step-body">
          <div className="vp-kza-karten" role="radiogroup" aria-label={UEMS_VORLAGE}>
            {A.vorlagenKarten().map((k) => (
              <label key={k.wert} className={`vp-kza-karte${entwurf.wahl === k.wert ? ' is-gewaehlt' : ''}`}>
                <input
                  type="radio"
                  name="kennzahl-vorlage"
                  value={k.wert}
                  checked={entwurf.wahl === k.wert}
                  onChange={() => setEntwurf((e) => A.waehle(e, k.wert))}
                />
                <span>
                  <b>{k.titel}</b>
                  <small>{k.satz}</small>
                  {k.form && <em>{k.form}</em>}
                </span>
              </label>
            ))}
          </div>
          {entwurf.wahl === A.OHNE_VORLAGE && (
            <fieldset className="vp-kza-formen">
              <legend>{A.RECHENFORM_FRAGE}</legend>
              <div className="vp-kza-karten" role="radiogroup" aria-label={A.RECHENFORM_FRAGE}>
                {(RECHENFORMEN as KennzahlRechenform[]).map((f) => (
                  <label key={f} className={`vp-kza-karte${form === f ? ' is-gewaehlt' : ''}`}>
                    <input
                      type="radio"
                      name="kennzahl-rechenform"
                      value={f}
                      checked={form === f}
                      onChange={() => setEntwurf((e) => A.rechenformWaehlen(e, f))}
                    />
                    <span>
                      <b>{UEMS_RECHENFORM[f]}</b>
                      <small>{A.RECHENFORM_SATZ[f]}</small>
                    </span>
                  </label>
                ))}
              </div>
              {form === ANTEIL && (
                <label className="vp-kza-check">
                  <input type="checkbox" checked={entwurf.komplement} onChange={(ev) => setze({ komplement: ev.target.checked })} />
                  <span>{A.KOMPLEMENT_SATZ}</span>
                </label>
              )}
            </fieldset>
          )}
        </div>
      </>
    );
  }

  function SchrittMenge() {
    const er = A.mengeErwartung(entwurf);
    const auswahl = register ? A.messstellenAuswahl(register, er) : null;
    const anlage = register && entwurf.menge.length > 1 ? A.hebelAnlage(register, entwurf.menge) : null;
    return (
      <>
        {Kopf({ n: 2, titel: A.S2_TITEL[form ?? 'quotient'] })}
        <div className="vp-gw-step-body">
          <VpPicker
            label={woerter[1]}
            options={auswahl?.optionen ?? []}
            values={entwurf.menge}
            onChangeMany={(values) => setze({ menge: values, bezug: null, periode: null })}
            loading={register === null && !registerFehler}
            loadError={registerFehler ? A.LADEFEHLER : null}
            onRetry={() => setRegisterLauf((n) => n + 1)}
            placeholder="Messstelle oder Gesamtwert wählen …"
            searchPlaceholder="Messstelle suchen …"
            hint={auswahl ? A.erwartungHinweis(er?.satz ?? null, auswahl) : undefined}
          />
          {entwurf.menge.length > 1 && (
            <div className="vp-kza-hebel" role="status" data-testid="kennzahl-hebel-gesamtwert">
              <p>
                <b>{A.HEBEL_SATZ}</b>
              </p>
              <p>{A.EINE_MENGE}</p>
              {anlage ? (
                <>
                  {A.hebelOrt(anlage) && <p>{A.hebelOrt(anlage)}</p>}
                  <Button variant="outline" size="sm" onClick={() => setGesamtwertAn(anlage)}>
                    {A.HEBEL_KNOPF}
                  </Button>
                </>
              ) : (
                <p>{A.HEBEL_OHNE_ANLAGE}</p>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  function SchrittPaare() {
    const auswahl = kennzahlen ? A.kennzahlenAuswahl(kennzahlen) : null;
    return (
      <>
        {Kopf({ n: 2, titel: A.S2_TITEL.zusammenfassung, sub: A.RECHENFORM_SATZ.zusammenfassung })}
        <div className="vp-gw-step-body">
          <VpPicker
            label={woerter[1]}
            options={auswahl?.optionen ?? []}
            values={entwurf.paare}
            onChangeMany={(values) => setze({ paare: values })}
            loading={kennzahlen === null && !kennzahlenFehler}
            loadError={kennzahlenFehler ? A.LADEFEHLER : null}
            onRetry={() => setLadeLauf((n) => n + 1)}
            placeholder="Kennzahlen wählen …"
            searchPlaceholder="Kennzahl suchen …"
            error={pruefung?.fehler ? pruefung.satz : undefined}
            hint={pruefung?.hinweis ?? undefined}
          />
        </div>
      </>
    );
  }

  function SchrittBezug() {
    const istAnteil = form === ANTEIL;
    const er = A.bezugErwartung(entwurf);
    const auswahl = istAnteil
      ? register
        ? A.messstellenAuswahl(register, er as KennzahlVorlageMessstelle | null, entwurf.menge[0] ?? null)
        : null
      : bezug
        ? A.bezugsgroessenAuswahl(bezug.bezugsgroessen, bezug.bezugsflaechen, er as KennzahlVorlageBezugsgroesse | null)
        : null;
    const laedt = istAnteil ? register === null && !registerFehler : bezug === null && !bezugFehler;
    const fehlerLaden = istAnteil ? registerFehler : bezugFehler;
    return (
      <>
        {Kopf({ n: 3, titel: istAnteil ? A.S3_TITEL.anteil : A.S3_TITEL.quotient })}
        <div className="vp-gw-step-body">
          {mengeZeile && (
            <p className="vp-kza-kontext">
              {woerter[1]}: <b>{mengeZeile.name ? `${mengeZeile.kennzeichen} ${mengeZeile.name}` : mengeZeile.kennzeichen}</b> ·{' '}
              {mengeZeile.hauptgroesse.groesse} · {mengeZeile.hauptgroesse.richtung}
            </p>
          )}
          <VpPicker
            label={woerter[2]}
            options={auswahl?.optionen ?? []}
            value={entwurf.bezug}
            onChange={(v) => setze({ bezug: v, periode: null })}
            groups={istAnteil ? undefined : A.bezugsgroessenGruppen}
            loading={laedt}
            loadError={fehlerLaden ? A.LADEFEHLER : null}
            onRetry={() => (istAnteil ? setRegisterLauf((n) => n + 1) : setLadeLauf((n) => n + 1))}
            placeholder={istAnteil ? 'Messstelle oder Gesamtwert wählen …' : 'Bezugsgröße wählen …'}
            hint={auswahl ? A.erwartungHinweis(er?.satz ?? null, auswahl, istAnteil ? 'Messstellen' : 'Bezugsgrößen') : undefined}
            error={pruefung?.fehler ? pruefung.satz : undefined}
          />
          {pruefung?.hinweis && (
            <p className="vp-kza-ok" role="status" data-testid="kennzahl-periode-ok">
              <Icon name="check" size={16} strokeWidth={3} />
              <span>{pruefung.hinweis}</span>
            </p>
          )}
          {pruefung?.einheitAnzeige && <p className="vp-kza-fein">{A.einheitText(pruefung.einheitAnzeige)}</p>}
          {pruefung && pruefung.grundperiode !== null && (
            <fieldset className="vp-kza-perioden">
              <legend>{A.PERIODE_WUNSCH}</legend>
              <div className="vp-kza-seg" role="radiogroup" aria-label={A.PERIODE_WUNSCH}>
                {A.PERIODEN_WAHL.map((p) => {
                  const an = (entwurf.periode ?? pruefung.grundperiode) === p;
                  return (
                    <label key={p} className={an ? 'is-gewaehlt' : undefined}>
                      <input
                        type="radio"
                        name="kennzahl-periode"
                        value={p}
                        checked={an}
                        onChange={() => setze({ periode: p === pruefung.grundperiode ? null : p })}
                      />
                      <span>{PERIODEN_NAME[p]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      </>
    );
  }

  function SchrittGeltung() {
    return (
      <>
        {Kopf({ n: 4, titel: A.S4_TITEL })}
        <div className="vp-gw-step-body vp-kza-felder">
          <VpPicker
            label={UEMS_GELTUNGSBEREICH}
            options={orte ? A.geltungOptionen(orte) : []}
            value={entwurf.geltung}
            onChange={(v) => setze({ geltung: v })}
            loading={orte === null && !orteFehler}
            loadError={orteFehler ? A.LADEFEHLER : null}
            onRetry={() => setLadeLauf((n) => n + 1)}
            placeholder="Geltungsbereich wählen …"
            searchPlaceholder="Ort, Prozess oder Messstelle suchen …"
            error={geltungFehler ?? undefined}
          />
          {rechte?.text && (
            <div className="vp-kza-rechte" data-testid="kennzahl-rechte">
              <span>{A.RECHTE_TITEL}</span>
              <b>{rechte.text}</b>
              <small>{A.RECHTE_SATZ}</small>
            </div>
          )}
          <Input
            label={A.NAME}
            value={entwurf.name}
            onChange={(ev) => setze({ name: ev.target.value, nameBeruehrt: true })}
            hint={!entwurf.nameBeruehrt && entwurf.name ? A.NAME_AUS_VORLAGE : undefined}
            error={entwurf.nameBeruehrt && !entwurf.name.trim() ? A.PFLICHT : undefined}
          />
          <Input
            label={UEMS_VERANTWORTLICH}
            value={entwurf.verantwortlich}
            onChange={(ev) => setze({ verantwortlich: ev.target.value })}
            hint={entwurf.verantwortlich === person ? A.VERANTWORTLICH_HINT : undefined}
            error={!entwurf.verantwortlich.trim() ? A.PFLICHT : undefined}
          />
          <Input label={UEMS_ZWECK} value={entwurf.zweck} onChange={(ev) => setze({ zweck: ev.target.value, zweckBeruehrt: true })} />
        </div>
      </>
    );
  }

  function SchrittVorschau() {
    const zeilen = vorschauAntwort ? A.vorschauZeilen(vorschauAntwort) : [];
    return (
      <>
        {Kopf({ n: 5, titel: A.VORSCHAU, sub: A.S5_SUB })}
        <div className="vp-gw-step-body">
          {ort && (
            <dl className="vp-kza-kopf">
              {A.vorschauKopf(entwurf, ort, rechte?.text ?? null, vorschauAntwort).map((z) => (
                <div key={z.wort}>
                  <dt>{z.wort}</dt>
                  <dd>{z.wert}</dd>
                </div>
              ))}
            </dl>
          )}
          {vorschauFehler ? (
            <div className="vp-gw-error" role="alert">
              <p>{vorschauFehler}</p>
              <button type="button" className="vp-gw-fine" onClick={() => setVorschauLauf((n) => n + 1)}>
                Erneut rechnen
              </button>
            </div>
          ) : vorschauAntwort === null ? (
            <p className="vp-gw-hint" aria-busy="true">
              {A.VORSCHAU_LAEDT}
            </p>
          ) : vorschauAntwort.befunde.length > 0 ? (
            <ul className="vp-kza-befunde">
              {vorschauAntwort.befunde.map((b) => {
                const ziel = A.befundSchritt(b.code);
                return (
                  <li key={`${b.code}-${b.message}`}>
                    <p role="alert">{A.befundSatz(b)}</p>
                    <button type="button" className="vp-gw-fine" onClick={() => setSchritt(ziel)}>
                      {A.ZU_SCHRITT} {ziel} · {woerter[ziel - 1]}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <section className="vp-kza-vorschau" aria-label={A.PERIODEN_TITEL}>
              <h4>{A.PERIODEN_TITEL}</h4>
              {zeilen.length === 0 ? (
                <p className="vp-gw-hint">{A.OHNE_PERIODEN}</p>
              ) : (
                <ul>
                  {zeilen.map((z) => (
                    <li key={z.schluessel} data-testid="kennzahl-vorschau-periode">
                      <div className="vp-kza-p-kopf">
                        <b>{z.periode}</b>
                        <Badge variant={z.ton}>{z.zustand}</Badge>
                      </div>
                      <div className={`vp-kza-p-zahl${z.zahl === A.STRICH ? ' is-leer' : ''}`}>{z.zahl}</div>
                      {z.kennzeichen && <small>{z.kennzeichen}</small>}
                      {z.satz && <p>{z.satz}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {anlegenFehler && (
            <p className="vp-gw-error" role="alert">
              {anlegenFehler}
            </p>
          )}
        </div>
      </>
    );
  }

  function SchrittFertig() {
    return (
      <div className="vp-gw-step-body">
        <div className="vp-gw-done" data-testid="kennzahl-fertig">
          <div className="vp-gw-done-circle">
            <Icon name="check" size={30} strokeWidth={3} />
          </div>
          <h3>{ergebnis ? A.fertigSatz(ergebnis) : A.TITEL_FERTIG}</h3>
          {ergebnis && <p>{ergebnis.name}</p>}
          <p>{A.FERTIG_SUB}</p>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- Fuß

  function Fuss() {
    if (schritt === 6) {
      return (
        <div className="vp-gw-foot">
          {onZurKennzahl && ergebnis && (
            <Button variant="ghost" onClick={() => onZurKennzahl(ergebnis.id)}>
              {A.ZUR_KENNZAHL}
            </Button>
          )}
          <Button onClick={onClose}>{A.TITEL_FERTIG}</Button>
        </div>
      );
    }
    return (
      <div className="vp-gw-foot">
        {schritt === 1 ? (
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setSchritt((s) => A.voriger(s, form))}>
            Zurück
          </Button>
        )}
        {schritt === 5 ? (
          <Button onClick={anlegen} disabled={!A.anlegenMoeglich(vorschauAntwort) || laeuft}>
            {laeuft ? A.ANLEGEN_LAEUFT : A.ANLEGEN}
          </Button>
        ) : (
          <Button
            onClick={() => setSchritt((s) => A.naechster(s, form))}
            disabled={!A.weiterMoeglich(schritt, entwurf, pruefung, geltungFehler)}
          >
            Weiter
          </Button>
        )}
      </div>
    );
  }
}
