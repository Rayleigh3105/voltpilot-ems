import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  api,
  type EnergiemanagementAusschluss,
  type EnergiemanagementBeleg,
  type EnergiemanagementDokument,
  type EnergiemanagementFassung,
  type EnergiemanagementFassungEntwerfen,
  type EnergiemanagementPersonKurz,
  type StandortAmStichtag,
} from '../../api';
import * as E from '../../energiemanagementPortal';
import { SAETZE } from '../../energiemanagement';
import * as N from '../../nachweisDokumente';
import { useRollen } from '../../rollen';
import { pruefsummeLokal } from '../../uemsMessmittel';
import { PersonAnlegenDialog } from '../DokumentDialoge';
import { GrenzHinweis } from '../GrenzSatz';
import { VpDatePicker } from '../VpDatePicker';
import { VpPicker } from '../VpPicker';
import { ErklaerKnopf } from './ErklaerKnopf';
import type { Erklaerung } from './erklaerung';
import { NwBlatt } from './NwBlatt';
import { AntwortKarten, HinweisZeile, PruefZeilen, SchrittAnzeige, Umschalter, WahlChips, Wortlaut } from './NwSchritte';
import { NwTextfeld } from './NwTextfeld';
import { Stufen } from './Stufen';
import './NwSchritte.css';
import './NwZeilen.css';
import './NwDokumente.css';

/*
 * Die Blätter eines Dokuments (Konzept Nachweisen n1, Runde 2, §6.10; Entscheide 10 bis 12): neu fassen, freigeben -
 * mit einer oder zwei Personen, vorab gezeigt -, bestätigen oder ablehnen, bekannt machen, Überprüfung festhalten,
 * aufheben; dazu die Lese-Blätter Wortlaut, Fassungen und Original. Eine Frage je Schritt, höchstens 35 Wörter, Hilfe
 * nur hinter dem i-Knopf. Entschieden wird an der Route; „heute“ ist ihr Tag (`ueberpruefung.abruf`).
 */

const ABBRECHEN = 'Abbrechen';
const ZURUECK = 'Zurück';
const WEITER = 'Weiter';

/** Ein Blatt mit Formular: der Hauptknopf im Fuß sendet es ab, Enter auch. */
function BlattFormular({ id, testid, onSenden, children }: { id: string; testid: string; onSenden: () => void; children: ReactNode }) {
  return (
    <form
      id={id}
      className="vp-nw-schritt-inhalt"
      noValidate
      data-testid={testid}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSenden();
      }}
    >
      {children}
    </form>
  );
}

function Fuss({ form, primaer, busy, sekundaer, onSekundaer, testid }: { form: string; primaer: string; busy: boolean; sekundaer: string; onSekundaer: () => void; testid: string }) {
  return (
    <div className="vp-nw-blatt-fuss">
      <Button type="submit" form={form} disabled={busy} aria-busy={busy || undefined} data-testid={testid}>
        {primaer}
      </Button>
      <Button variant="ghost" onClick={onSekundaer}>
        {sekundaer}
      </Button>
    </div>
  );
}

function Ablehnung({ satz }: { satz: string | null }) {
  return satz ? (
    <p className="vp-nw-fehler" role="alert" data-testid="blatt-ablehnung">
      {satz}
    </p>
  ) : null;
}

const basisId = (prefix: string, id: string) => `${prefix}-${id.replace(/:/g, '')}`;

// ------------------------------------------------------------------ gemeinsame Teile

/** Die Personen, die entscheiden können: bei Energiepolitik, Anwendungsbereich und Bestellung die Leitung am Tag (PA3). */
function useEntscheider(leitung: boolean, tag: string, neu: number) {
  const [personen, setPersonen] = useState<EnergiemanagementPersonKurz[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    setPersonen(null);
    const laden = leitung
      ? api.energiemanagementAufgaben(tag || undefined).then((a) => a.leitung)
      : api.energiemanagementPersonen().then((p) =>
          p.personen.filter((x) => x.zustand === 'aktiv').map((x) => ({ id: x.id, name: x.name, funktion: x.funktion, kuerzel: x.kuerzel, mit_konto: !!x.konto })),
        );
    laden.then(
      (liste) => aktiv && setPersonen(liste),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [leitung, tag, neu]);
  return { leitung, personen, fehler };
}

/** Wer hat entschieden? - eine Person im Energiemanagement, auch ohne Konto; ohne Leitung der Weg „Person anlegen“. */
function EntscheiderWahl({
  id,
  leitung: nurLeitung,
  tag,
  wert,
  setze,
  fehler,
  vorbelegen = true,
}: {
  id: string;
  /** Nur die Leitung am Tag (Freigabe von Energiepolitik, Anwendungsbereich, Bestellung - PA3). */
  leitung: boolean;
  tag: string;
  wert: string;
  setze: (id: string) => void;
  fehler?: string | null;
  vorbelegen?: boolean;
}) {
  const [neu, setNeu] = useState(0);
  const [anlegen, setAnlegen] = useState(false);
  const { leitung, personen, fehler: ladefehler } = useEntscheider(nurLeitung, tag, neu);
  useEffect(() => {
    if (!personen) return;
    if (wert && personen.some((p) => p.id === wert)) return;
    if (vorbelegen && personen.length === 1) setze(personen[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personen]);
  const ohneLeitung = leitung && personen !== null && personen.length === 0;
  return (
    <>
      {ohneLeitung ? (
        <p className="vp-nw-leise" data-testid="freigabe-ohne-leitung">
          {SAETZE.freigabe_ohne_leitung}
        </p>
      ) : (
        <VpPicker
          id={id}
          label="Wer hat entschieden?"
          options={(personen ?? []).map((p) => ({ value: p.id, label: `${p.name}, ${p.funktion}` }))}
          value={wert || null}
          onChange={setze}
          placeholder="Person wählen"
          loading={personen === null && !ladefehler}
          loadError={ladefehler}
          error={fehler ?? null}
          createLabel={E.KNOPF_PERSON}
          onCreate={() => setAnlegen(true)}
        />
      )}
      {ohneLeitung && (
        <Button variant="outline" onClick={() => setAnlegen(true)} data-testid="freigabe-person-anlegen">
          {E.KNOPF_PERSON}
        </Button>
      )}
      {anlegen && (
        <PersonAnlegenDialog
          leitung={leitung}
          ab={tag}
          onClose={() => setAnlegen(false)}
          onAngelegt={(p) => {
            setAnlegen(false);
            setze(p.id);
            setNeu((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

type TagArt = 'heute' | 'gestern' | 'anders';

/** Wann? - „Heute, 30.04.“, „Gestern“, „Anderer Tag“ (dann ein Tag bis heute); heute ist der Tag der Route. */
function TagWahl({ heute, wert, setze, mitGestern = true, min }: { heute: string; wert: string; setze: (tag: string) => void; mitGestern?: boolean; min?: string | null }) {
  const gestern = N.tagDavor(heute);
  const [art, setArt] = useState<TagArt>(wert === heute ? 'heute' : wert === gestern && mitGestern ? 'gestern' : 'anders');
  const optionen: { wert: TagArt; label: string }[] = [
    { wert: 'heute', label: N.heuteLabel(heute) },
    ...(mitGestern && (!min || gestern >= min) ? [{ wert: 'gestern' as const, label: 'Gestern' }] : []),
    { wert: 'anders', label: 'Anderer Tag' },
  ];
  return (
    <>
      <WahlChips
        frage="Wann?"
        optionen={optionen}
        wert={art}
        onWahl={(a) => {
          setArt(a);
          if (a === 'heute') setze(heute);
          if (a === 'gestern') setze(gestern);
        }}
        testid="tag-wahl"
      />
      {art === 'anders' && <VpDatePicker ariaLabel="Tag" value={wert || null} onChange={setze} max={heute} min={min ?? undefined} />}
    </>
  );
}

/** „Datei prüfen · wahlfrei“: die Prüfsumme entsteht im Browser; VoltPilot bekommt nur sie, nie die Datei (Entscheid 9). */
function DateiPruefen({ id, sha256, setze }: { id: string; sha256: string | null; setze: (sha: string | null, name: string | null) => void }) {
  const [rechnet, setRechnet] = useState(false);
  async function gewaehlt(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    try {
      setze(await pruefsummeLokal(datei), datei.name);
    } finally {
      setRechnet(false);
    }
  }
  return (
    <label className="vp-nw-hz vp-nw-datei" htmlFor={id} data-testid="datei-pruefen">
      <span className="vp-nw-hz-i" aria-hidden="true">
        <Icon name="lock" size={14} />
      </span>
      <span className="vp-nw-hz-t">
        <b>{rechnet ? 'Prüfsumme wird gebildet …' : sha256 ? 'Prüfsumme festgehalten' : 'Datei prüfen'}</b>
        {!sha256 && !rechnet && <span> · wahlfrei</span>}
      </span>
      <input id={id} type="file" className="vp-nw-unsichtbar" onChange={(e) => void gewaehlt(e.target.files)} />
    </label>
  );
}

/** Ein Original oder Verweis im Blatt: wo es liegt (Pflicht), Kennung, Stand vom, Datei prüfen. */
function OrtFelder({ basis, wert, setze, mitStand, fehler }: { basis: string; wert: E.VerweisEntwurf; setze: (v: E.VerweisEntwurf) => void; mitStand: boolean; fehler?: string | null }) {
  const teil = (t: Partial<E.VerweisEntwurf>) => setze({ ...wert, ...t });
  return (
    <>
      <NwTextfeld label="Wo liegt es?" wert={wert.ablage} onWert={(ablage) => teil({ ablage })} platzhalter="zum Beispiel QM-Laufwerk, Ordner Politik" fehler={fehler} hoechstens={200} testid={`${basis}-ablage`} />
      <div className="vp-nw-paar">
        <NwTextfeld label="Kennung" wert={wert.kennung} onWert={(kennung) => teil({ kennung })} hoechstens={200} testid={`${basis}-kennung`} />
        {mitStand && <VpDatePicker label="Stand vom" value={wert.datum || null} onChange={(datum) => teil({ datum })} />}
      </div>
      <DateiPruefen id={`${basis}-datei`} sha256={wert.sha256} setze={(sha256, name) => teil({ sha256, bezeichnung: wert.bezeichnung || name || '' })} />
    </>
  );
}

const belegAus = (v: E.VerweisEntwurf): EnergiemanagementBeleg | null =>
  v.ablage.trim() ? { ablage: v.ablage.trim(), bezeichnung: v.bezeichnung.trim() || null, kennung: v.kennung.trim() || null, adresse: v.adresse.trim() || null, sha256: v.sha256 } : null;

const verweisEntwurf = (v: { bezeichnung?: string | null; ablage?: string | null; kennung?: string | null; adresse?: string | null; fassungsangabe?: string | null; datum?: string | null; sha256?: string | null } | null | undefined): E.VerweisEntwurf =>
  v
    ? { bezeichnung: v.bezeichnung ?? '', ablage: v.ablage ?? '', kennung: v.kennung ?? '', adresse: v.adresse ?? '', fassungsangabe: v.fassungsangabe ?? '', datum: v.datum ?? '', sha256: v.sha256 ?? null }
    : E.LEERER_VERWEIS;

// ------------------------------------------------------------------ Erklärungen der Blätter (Entscheid 24)

export const FREIGEBEN_ERKLAERUNG: Erklaerung = {
  frage: 'Was heißt freigeben?',
  klartext: 'Eine berechtigte Person entscheidet, dass etwas ab jetzt gilt; VoltPilot hält fest, wer entschieden und wer eingetragen hat.',
  beiIhnen: 'Die neue Fassung gilt sofort, die alte ist überholt und bleibt lesbar.',
  nichtVerwechseln: 'Bei Energiepolitik und Anwendungsbereich entscheidet die Leitung.',
  fachwort: 'Freigabe (Lenkung)',
};

export const ZWEI_PERSONEN_ERKLAERUNG: Erklaerung = {
  frage: 'Wer darf bestätigen?',
  klartext: 'Bei Ihnen bestätigt eine zweite Person jede Freigabe: wer Kundenadministrator oder Energiemanager ist.',
  beiIhnen: null,
  nichtVerwechseln: 'Wer beantragt hat, bestätigt nicht selbst.',
  fachwort: 'Vier-Augen-Prinzip',
};

// ------------------------------------------------------------------ Neu fassen (DK2)

type GrundArt = 'beschluss' | 'audit' | 'eigen';
type GrundOption = { value: string; label: string; sub?: string; begruendung: string; beschluss: string | null };

/** Die Gründe zur Wahl: Beschlüsse freigegebener Managementbewertungen (MG6) bzw. Hinweise interner Audits. */
function useGruende(art: GrundArt | null) {
  const [optionen, setOptionen] = useState<GrundOption[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    if (art !== 'beschluss' && art !== 'audit') return;
    let aktiv = true;
    setOptionen(null);
    setFehler(null);
    const laden: Promise<GrundOption[]> =
      art === 'beschluss'
        ? api.berichte().then(async (r) => {
            const mbs = r.berichte.filter((b) => b.vorlage === 'managementbewertung' && b.neueste_nr !== null && b.archiviert_am === null);
            const alle = await Promise.all(mbs.map((b) => api.managementbewertung(b.kennung).then((m) => ({ b, m }))));
            return alle.flatMap(({ b, m }) =>
              m.beschluesse.map((x) => ({
                value: x.kennung,
                label: `Beschluss ${x.nr} · ${b.zeitraum_text}`,
                sub: x.wortlaut.length > 60 ? `${x.wortlaut.slice(0, 57)} …` : x.wortlaut,
                begruendung: `Beschluss ${x.nr} der Managementbewertung ${b.zeitraum_text}: ${x.wortlaut}`.slice(0, 500),
                beschluss: x.kennung,
              })),
            );
          })
        : api.energiemanagementAudits().then(async (p) => {
            const mit = p.audits.filter((a) => a.hinweise > 0);
            const alle = await Promise.all(mit.map((a) => api.energiemanagementAudit(a.id)));
            return alle.flatMap((a) =>
              a.hinweise.map((h) => ({
                value: `${a.audit.id}/${h.nr}`,
                label: `Hinweis ${h.nr} · ${a.audit.titel}`,
                sub: h.wortlaut.length > 60 ? `${h.wortlaut.slice(0, 57)} …` : h.wortlaut,
                begruendung: `Hinweis aus dem ${a.audit.titel}: ${h.wortlaut}`.slice(0, 500),
                beschluss: null,
              })),
            );
          });
    laden.then(
      (o) => aktiv && setOptionen(o),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [art]);
  return { optionen, fehler };
}

interface FassungStand {
  form: 'wortlaut' | 'verweis';
  wortlaut: string;
  verweis: E.VerweisEntwurf;
  standortIds: string[];
  traeger: string[];
  ausschluesse: EnergiemanagementAusschluss[];
  grundArt: GrundArt | null;
  grundWahl: string | null;
  begruendung: string;
  beschluss: string | null;
}

function useStandorte() {
  const [standorte, setStandorte] = useState<StandortAmStichtag[]>([]);
  useEffect(() => {
    let aktiv = true;
    api.standorte().then((s) => aktiv && setStandorte(s.standorte.filter((st) => st.zustand !== 'archiviert')), () => undefined);
    return () => {
      aktiv = false;
    };
  }, []);
  return standorte;
}

/**
 * Ausschlüsse des Anwendungsbereichs (Entscheid 12): ein Standort mit Begründung (10 bis 500 Zeichen). Die Route prüft,
 * dass der Standort zum Unternehmen gehört; Anlagen und Prozesse bleiben dem Betrachtungsumfang der Bewertung.
 */
function AusschlussFelder({ basis, standorte, wert, setze }: { basis: string; standorte: StandortAmStichtag[]; wert: EnergiemanagementAusschluss[]; setze: (a: EnergiemanagementAusschluss[]) => void }) {
  return (
    <fieldset className="vp-nw-feldsatz" data-testid={`${basis}-ausschluesse`}>
      <legend className="vp-nw-frage">Ausschlüsse</legend>
      {wert.map((a, i) => (
        <div key={i} className="vp-nw-ausschluss">
          <VpPicker
            id={`${basis}-aus-${i}`}
            ariaLabel="Ausgeschlossener Standort"
            options={standorte.map((s) => ({ value: s.id, label: s.name, sub: s.kurzzeichen }))}
            value={a.verweis || null}
            onChange={(verweis) => setze(wert.map((x, j) => (j === i ? { ...x, verweis } : x)))}
            placeholder="Standort wählen"
          />
          <NwTextfeld label="Warum?" wert={a.begruendung} onWert={(begruendung) => setze(wert.map((x, j) => (j === i ? { ...x, begruendung } : x)))} hoechstens={500} />
          <button type="button" className="vp-nw-aendern" onClick={() => setze(wert.filter((_, j) => j !== i))}>
            Entfernen
          </button>
        </div>
      ))}
      <button type="button" className="vp-nw-aendern vp-nw-links" onClick={() => setze([...wert, { art: 'standort', verweis: '', begruendung: '' }])} data-testid={`${basis}-ausschluss-neu`}>
        {wert.length ? 'Weiteren Ausschluss' : 'Keine · Ausschluss festhalten'}
      </button>
    </fieldset>
  );
}

/** Prüft eine Fassung vor dem Absenden - dieselben Regeln wie `energiemanagementPortal.fassungKoerper`. */
function fassungKoerper(s: FassungStand, art: string, nr: number) {
  const r = E.fassungKoerper(
    { form: s.form, wortlaut: s.wortlaut, verweis: s.verweis, standortIds: s.standortIds, traeger: s.traeger, begruendung: s.begruendung },
    art,
    nr,
  );
  if ('fehler' in r) return r;
  const ausschluesse = s.ausschluesse.filter((a) => a.verweis || a.begruendung.trim());
  const ausFehler = ausschluesse.some((a) => !a.verweis || E.begruendungFehler(a.begruendung));
  if (art === 'anwendungsbereich' && ausFehler) return { fehler: { ausschluesse: 'Bitte nennen Sie je Ausschluss den Standort und begründen Sie mit 10 bis 500 Zeichen.' } };
  const koerper: EnergiemanagementFassungEntwerfen = { ...(r.koerper as EnergiemanagementFassungEntwerfen) };
  if (art === 'anwendungsbereich') koerper.anwendungsbereich = { standort_ids: s.standortIds, traeger: s.traeger, ausschluesse: ausschluesse.map((a) => ({ ...a, begruendung: a.begruendung.trim() })) };
  if (s.beschluss) koerper.beschluss_kennung = s.beschluss;
  return { koerper };
}

/**
 * Neu fassen (§6.10, DK2): Schritt 1 der neue Wortlaut oder Verweis und „Warum?“ (Beschluss, Hinweis aus einem Audit,
 * eigener Grund); beim Anwendungsbereich Standorte, Energieträger und Ausschlüsse (Entscheid 12). Schritt 2 „Prüfen“
 * zeigt nur das Neue hinterlegt und fragt: als Entwurf speichern oder gleich freigeben. Ein offener Entwurf wird
 * überschrieben (dieselbe Nr.), ein offener Antrag nicht.
 */
export function NeuFassenBlatt({
  dokument,
  vierAugen,
  onClose,
  onGespeichert,
  onFreigeben,
}: {
  dokument: EnergiemanagementDokument;
  vierAugen: boolean | null;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
  /** „Gleich freigeben“: der Entwurf ist gespeichert, das Freigeben-Blatt übernimmt. */
  onFreigeben: (d: EnergiemanagementDokument, nr: number) => void;
}) {
  const basis = basisId('nf', useId());
  const rollen = useRollen();
  const standorte = useStandorte();
  const offen = N.offeneFassung(dokument);
  const vorlage = offen ?? N.gueltigeFassung(dokument);
  const nr = offen?.status === 'entwurf' ? offen.nr : Math.max(0, ...dokument.fassungen.map((f) => f.nr)) + 1;
  const anwendungsbereich = dokument.art === 'anwendungsbereich';
  const [schritt, setSchritt] = useState(1);
  const [s, setS] = useState<FassungStand>(() => ({
    form: vorlage?.form ?? (dokument.klasse === 'nachweis' ? 'verweis' : 'wortlaut'),
    wortlaut: vorlage?.wortlaut ?? '',
    verweis: verweisEntwurf(vorlage?.verweis),
    standortIds: vorlage?.anwendungsbereich?.standorte.map((x) => x.id) ?? [],
    traeger: vorlage?.anwendungsbereich?.traeger ?? [],
    ausschluesse: vorlage?.anwendungsbereich?.ausschluesse ?? [],
    grundArt: offen?.beschluss_kennung ? 'beschluss' : offen?.begruendung ? 'eigen' : null,
    grundWahl: offen?.beschluss_kennung ?? null,
    begruendung: offen?.status === 'entwurf' ? (offen.begruendung ?? '') : '',
    beschluss: offen?.beschluss_kennung ?? null,
  }));
  const [gleich, setGleich] = useState<'entwurf' | 'freigeben'>('entwurf');
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gruende = useGruende(s.grundArt);
  const setze = (t: Partial<FassungStand>) => setS((alt) => ({ ...alt, ...t }));
  const darfFreigeben = rollen.darf(E.RECHT_FREIGEBEN, dokument.bezug.standort?.id ?? null);
  const pflichtGrund = nr >= 2;

  const neu = useMemo(() => {
    if (s.form !== 'wortlaut') return null;
    const g = N.gueltigeFassung(dokument);
    return N.wortlautMitNeuem(g?.form === 'wortlaut' ? (g.wortlaut ?? null) : null, s.wortlaut);
  }, [s.form, s.wortlaut, dokument]);

  function pruefen(): boolean {
    const r = fassungKoerper(s, dokument.art, nr);
    if ('fehler' in r) {
      setFehler(r.fehler ?? {});
      return false;
    }
    setFehler({});
    return true;
  }

  async function speichern() {
    const r = fassungKoerper(s, dokument.art, nr);
    if ('fehler' in r) {
      setFehler(r.fehler ?? {});
      setSchritt(1);
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      const d = await api.energiemanagementFassungEntwerfen(dokument.id, r.koerper);
      const entwurf = N.offeneFassung(d);
      if (gleich === 'freigeben' && entwurf) onFreigeben(d, entwurf.nr);
      else onGespeichert(d);
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  const grundZeile = s.grundArt === 'eigen' || !s.grundWahl ? s.begruendung.trim() : (gruende.optionen?.find((o) => o.value === s.grundWahl)?.label ?? s.begruendung);
  const titel = schritt === 1 ? 'Neu fassen' : 'Prüfen';

  return (
    <NwBlatt
      open
      titel={titel}
      onClose={onClose}
      breit
      testId="neu-fassen-blatt"
      fuss={
        schritt === 1 ? (
          <Fuss form={`${basis}-form`} primaer={WEITER} busy={false} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="neu-fassen-weiter" />
        ) : (
          <Fuss form={`${basis}-form`} primaer={gleich === 'freigeben' ? WEITER : 'Entwurf speichern'} busy={busy} sekundaer={ZURUECK} onSekundaer={() => setSchritt(1)} testid="neu-fassen-speichern" />
        )
      }
    >
      <BlattFormular id={`${basis}-form`} testid="neu-fassen-form" onSenden={() => (schritt === 1 ? pruefen() && setSchritt(2) : void speichern())}>
        <p className="vp-nw-leise">Fassung {nr}</p>
        <SchrittAnzeige nr={schritt} von={2} />
        {schritt === 1 ? (
          <>
            <Umschalter
              label="Form"
              optionen={[
                { wert: 'wortlaut', label: 'Text' },
                { wert: 'verweis', label: 'Verweis' },
              ]}
              wert={s.form}
              onWahl={(form) => setze({ form })}
              testid="neu-fassen-form-wahl"
            />
            {s.form === 'wortlaut' ? (
              <NwTextfeld label="Wortlaut" wert={s.wortlaut} onWert={(wortlaut) => setze({ wortlaut })} mehrzeilig fehler={fehler.wortlaut} hoechstens={20000} testid="neu-fassen-wortlaut" />
            ) : (
              <OrtFelder basis={`${basis}-verweis`} wert={s.verweis} setze={(verweis) => setze({ verweis })} mitStand fehler={fehler.verweis} />
            )}
            {anwendungsbereich && (
              <>
                <VpPicker
                  id={`${basis}-standorte`}
                  label="Standorte"
                  options={standorte.map((x) => ({ value: x.id, label: x.name, sub: x.kurzzeichen }))}
                  values={s.standortIds}
                  onChangeMany={(standortIds) => setze({ standortIds })}
                  error={fehler.standorte ?? null}
                />
                <VpPicker
                  id={`${basis}-traeger`}
                  label="Energieträger"
                  options={E.TRAEGER.map((t) => ({ value: t, label: t }))}
                  values={s.traeger}
                  onChangeMany={(traeger) => setze({ traeger })}
                  error={fehler.traeger ?? null}
                />
                <AusschlussFelder basis={basis} standorte={standorte} wert={s.ausschluesse} setze={(ausschluesse) => setze({ ausschluesse })} />
                {fehler.ausschluesse && <p className="vp-nw-fehler" role="alert">{fehler.ausschluesse}</p>}
              </>
            )}
            <WahlChips
              frage={pflichtGrund ? 'Warum?' : 'Warum? · wahlfrei'}
              optionen={[
                { wert: 'audit', label: 'Hinweis aus einem Audit' },
                { wert: 'beschluss', label: 'Beschluss' },
                { wert: 'eigen', label: 'Eigener Grund' },
              ]}
              wert={s.grundArt}
              onWahl={(grundArt) => setze({ grundArt, grundWahl: null, beschluss: null, begruendung: grundArt === 'eigen' ? s.begruendung : '' })}
              fehler={!s.grundArt ? fehler.begruendung : null}
              testid="neu-fassen-grund"
            />
            {(s.grundArt === 'beschluss' || s.grundArt === 'audit') && (
              <VpPicker
                id={`${basis}-grund`}
                ariaLabel={s.grundArt === 'beschluss' ? 'Beschluss' : 'Hinweis'}
                options={(gruende.optionen ?? []).map((o) => ({ value: o.value, label: o.label, sub: o.sub }))}
                value={s.grundWahl}
                onChange={(grundWahl) => {
                  const o = gruende.optionen?.find((x) => x.value === grundWahl);
                  setze({ grundWahl, begruendung: o?.begruendung ?? '', beschluss: o?.beschluss ?? null });
                }}
                placeholder={s.grundArt === 'beschluss' ? 'Beschluss wählen' : 'Hinweis wählen'}
                loading={gruende.optionen === null && !gruende.fehler}
                loadError={gruende.fehler}
                emptyText={() => (s.grundArt === 'beschluss' ? 'Keine freigegebene Managementbewertung mit Beschluss.' : 'Kein Audit mit Hinweis.')}
                error={s.grundArt && !s.grundWahl ? (fehler.begruendung ?? null) : null}
              />
            )}
            {s.grundArt === 'eigen' && (
              <NwTextfeld label="Ihr Grund" wert={s.begruendung} onWert={(begruendung) => setze({ begruendung })} mehrzeilig fehler={fehler.begruendung} hoechstens={500} testid="neu-fassen-begruendung" />
            )}
          </>
        ) : (
          <>
            {s.form === 'wortlaut' && neu ? (
              neu.neueSaetze.length > 0 ? (
                <Wortlaut absaetze={[neu.neueSaetze.map((t, i) => ({ text: i < neu.neueSaetze.length - 1 ? `${t} ` : t, neu: true }))]} testid="neu-fassen-neu" />
              ) : (
                <Wortlaut absaetze={neu.absaetze} testid="neu-fassen-neu" />
              )
            ) : (
              <PruefZeilen zeilen={[{ etikett: 'Original', wert: [s.verweis.ablage, s.verweis.kennung].filter(Boolean).join(' · '), onAendern: () => setSchritt(1) }]} />
            )}
            <PruefZeilen zeilen={grundZeile ? [{ etikett: 'Grund', wert: grundZeile, onAendern: () => setSchritt(1) }] : []} testid="neu-fassen-pruefen" />
            {darfFreigeben ? (
              <AntwortKarten
                label="Wie weiter?"
                optionen={[
                  { wert: 'entwurf', titel: 'Als Entwurf speichern', zusatz: offen?.status === 'entwurf' ? `ersetzt Entwurf ${offen.nr}` : null },
                  { wert: 'freigeben', titel: vierAugen ? 'Gleich beantragen' : 'Gleich freigeben' },
                ]}
                wert={gleich}
                onWahl={setGleich}
                testid="neu-fassen-weiter-wahl"
              />
            ) : (
              <HinweisZeile icon="users" titel="Freigeben: eine berechtigte Person" knopf={<ErklaerKnopf klein erklaerung={FREIGEBEN_ERKLAERUNG} />} />
            )}
          </>
        )}
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Freigeben, beantragen (DK3, DK4, Entscheid 11)

/**
 * Fassung n freigeben bzw. Freigabe beantragen (§6.10, Entscheid 11): die Vier-Augen-Einstellung steht VORAB im Blatt -
 * „Eine Person gibt frei“ oder „Zwei Personen prüfen“ mit den Stufen Entwurf · Beantragt · Bestätigt - statt erst nach
 * einem roten Fehlversuch (Befund 6). Wer hat entschieden, wann, warum; wahlfrei das unterschriebene Original dieser
 * Fassung (Entscheid 10).
 */
export function FreigebenBlatt({
  dokument,
  fassung,
  vierAugen,
  onClose,
  onGespeichert,
}: {
  dokument: EnergiemanagementDokument;
  fassung: EnergiemanagementFassung;
  vierAugen: boolean | null;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
}) {
  const basis = basisId('fg', useId());
  const heute = N.heuteDerRoute(dokument, fassung.eingetragen.am.slice(0, 10));
  const [beantragen, setBeantragen] = useState(!!vierAugen);
  const [von, setVon] = useState('');
  const [tag, setTag] = useState(heute);
  const [begruendung, setBegruendung] = useState(fassung.begruendung && fassung.begruendung.trim().length >= 10 ? fassung.begruendung : '');
  const [mitOriginal, setMitOriginal] = useState(false);
  const [original, setOriginal] = useState<E.VerweisEntwurf>(() => verweisEntwurf(fassung.original ?? null));
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBeantragen(!!vierAugen), [vierAugen]);

  async function senden() {
    const f: E.Feldfehler = {};
    if (!von) f.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
    const b = E.begruendungFehler(begruendung);
    if (b) f.begruendung = b;
    const orig = mitOriginal ? belegAus(original) : null;
    if (mitOriginal && !orig && (original.kennung || original.sha256)) f.original = 'Bitte nennen Sie, wo das Original liegt.';
    setFehler(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    setSatz(null);
    const koerper = { entschieden_von: von, entschieden_am: tag || null, begruendung: begruendung.trim(), ...(orig ? { original: orig } : {}) };
    try {
      const d = beantragen
        ? await api.energiemanagementFassungBeantragen(dokument.id, fassung.nr, koerper)
        : await api.energiemanagementFassungFreigeben(dokument.id, fassung.nr, koerper);
      onGespeichert(d);
    } catch (err) {
      // Hat sich die Einstellung inzwischen geändert, sagt es die Route - das Blatt schaltet um, ohne roten Fehlversuch.
      if (E.ablehnungCode(err) === 'vieraugen_beantragen') setBeantragen(true);
      else if (E.ablehnungCode(err) === 'vieraugen_aus') setBeantragen(false);
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  const titel = beantragen ? 'Freigabe beantragen' : `Fassung ${fassung.nr} freigeben`;
  return (
    <NwBlatt
      open
      titel={titel}
      onClose={onClose}
      testId="freigeben-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer={titel} busy={busy} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="freigeben-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="freigeben-form" onSenden={() => void senden()}>
        {beantragen && (
          <Stufen
            stufen={[
              { titel: 'Entwurf', datum: E.tagText(fassung.eingetragen.am), zustand: 'done' },
              { titel: 'Beantragt', datum: 'heute', zustand: 'an' },
              { titel: 'Bestätigt', datum: 'zweite Person', zustand: 'offen' },
            ]}
          />
        )}
        <HinweisZeile
          icon="users"
          titel={beantragen ? 'Zwei Personen prüfen' : 'Eine Person gibt frei'}
          knopf={<ErklaerKnopf klein erklaerung={beantragen ? ZWEI_PERSONEN_ERKLAERUNG : FREIGEBEN_ERKLAERUNG} />}
          testid="freigeben-personen"
        />
        <EntscheiderWahl id={`${basis}-person`} leitung={E.leitungsPflicht(dokument.art)} tag={tag} wert={von} setze={setVon} fehler={fehler.entschiedenVon} />
        <TagWahl heute={heute} wert={tag} setze={setTag} />
        <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} mehrzeilig fehler={fehler.begruendung} hoechstens={500} testid="freigeben-begruendung" />
        {fassung.form === 'wortlaut' &&
          (mitOriginal ? (
            <OrtFelder basis={`${basis}-original`} wert={original} setze={setOriginal} mitStand={false} fehler={fehler.original} />
          ) : (
            <button type="button" className="vp-nw-aendern vp-nw-links" onClick={() => setMitOriginal(true)} data-testid="freigeben-original">
              Original festhalten · wahlfrei
            </button>
          ))}
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

/**
 * Die zweite Person (Entscheid 11): bestätigen oder ablehnen - mit Begründung beim Ablehnen. Danach ist ein neuer
 * Entwurf möglich; die gültige Fassung bleibt. Wer beantragt hat, sieht dieses Blatt nie (die Seite zeigt keinen Knopf).
 */
export function BestaetigenBlatt({
  dokument,
  fassung,
  onClose,
  onGespeichert,
}: {
  dokument: EnergiemanagementDokument;
  fassung: EnergiemanagementFassung;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
}) {
  const basis = basisId('bs', useId());
  const [antwort, setAntwort] = useState<'bestaetigen' | 'ablehnen'>('bestaetigen');
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden() {
    const ab = antwort === 'ablehnen';
    const b = ab || begruendung.trim() ? E.begruendungFehler(begruendung) : null;
    setFehler(b);
    if (b) return;
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(
        ab
          ? await api.energiemanagementFassungAblehnen(dokument.id, fassung.nr, begruendung.trim())
          : await api.energiemanagementFassungFreigeben(dokument.id, fassung.nr, begruendung.trim() ? { begruendung: begruendung.trim() } : {}),
      );
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open
      titel={`Fassung ${fassung.nr} bestätigen`}
      onClose={onClose}
      testId="bestaetigen-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer={antwort === 'ablehnen' ? 'Ablehnen' : 'Bestätigen'} busy={busy} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="bestaetigen-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="bestaetigen-form" onSenden={() => void senden()}>
        <Stufen
          stufen={[
            { titel: 'Entwurf', datum: E.tagText(fassung.eingetragen.am), zustand: 'done' },
            { titel: 'Beantragt', datum: fassung.freigabe?.akteur.name ?? null, zustand: 'done' },
            { titel: 'Bestätigt', datum: 'Sie', zustand: 'an' },
          ]}
        />
        <PruefZeilen zeilen={[{ etikett: 'Entschieden', wert: [fassung.entschieden_von?.name, E.tagText(fassung.entschieden_am)].filter(Boolean).join(' · ') }]} />
        <AntwortKarten
          label="Ihre Antwort"
          optionen={[
            { wert: 'bestaetigen', titel: 'Bestätigen', zusatz: `Fassung ${fassung.nr} gilt dann` },
            { wert: 'ablehnen', titel: 'Ablehnen', zusatz: 'mit Grund' },
          ]}
          wert={antwort}
          onWahl={setAntwort}
          testid="bestaetigen-wahl"
        />
        {antwort === 'ablehnen' && <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} mehrzeilig fehler={fehler} hoechstens={500} testid="bestaetigen-begruendung" />}
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Bekannt machen (DK6, Entscheid 12)

const WEGE: { wert: string; label: string }[] = [
  { wert: 'aushang', label: 'Aushang' },
  { wert: 'intranet', label: 'Intranet' },
  { wert: 'unterweisung', label: 'Unterweisung' },
  { wert: 'besprechung', label: 'Besprechung' },
  { wert: 'e_mail', label: 'E-Mail' },
  { wert: 'weiterer', label: 'Anderer Weg' },
];

/**
 * Bekannt machen (Entscheid 12): an wen, wie (ein oder mehrere Wege), wann. VoltPilot verschickt nichts; festgehalten
 * wird die Mitteilung - je Weg ein Eintrag, zusammen eine Bekanntmachung. „Später“ schließt ohne Eintrag.
 */
export function BekanntmachenBlatt({
  dokument,
  onClose,
  onGespeichert,
}: {
  dokument: EnergiemanagementDokument;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
}) {
  const basis = basisId('bk', useId());
  const g = N.gueltigeFassung(dokument);
  const heute = N.heuteDerRoute(dokument, '');
  const vorschlaege = N.kreisVorschlaege(dokument.eintraege);
  const [kreis, setKreis] = useState<string | null>(vorschlaege[0] ?? null);
  const [anderer, setAnderer] = useState('');
  const [wege, setWege] = useState<string[]>([]);
  const [wegWortlaut, setWegWortlaut] = useState('');
  const [tag, setTag] = useState(heute);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ANDERE = '__andere__';

  async function senden() {
    const an = kreis === ANDERE ? anderer.trim() : (kreis ?? '');
    const f: E.Feldfehler = {};
    if (!an) f.kreis = 'Bitte nennen Sie, wem Sie es bekannt gemacht haben.';
    if (!wege.length) f.wege = 'Bitte wählen Sie mindestens einen Weg.';
    if (wege.includes('weiterer') && !wegWortlaut.trim()) f.weg = 'Bitte beschreiben Sie den anderen Weg.';
    setFehler(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    setSatz(null);
    let d: EnergiemanagementDokument | null = null;
    try {
      // Ein Eintrag je Weg (DK6); die Seite liest sie als eine Mitteilung. Bricht einer ab, steht, was schon festgehalten ist.
      for (const weg of wege) {
        d = await api.energiemanagementBekanntmachen(dokument.id, { kreis: an, weg, am: tag || null, ...(weg === 'weiterer' ? { weg_wortlaut: wegWortlaut.trim() } : {}) });
      }
      if (d) onGespeichert(d);
    } catch (err) {
      setSatz(d ? `${E.ablehnungSatz(err)} Festgehalten ist schon: ${N.wegeText(N.bekanntmachungen(d.eintraege)[0]?.wege ?? [])}.` : E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open
      titel="Bekannt machen"
      onClose={onClose}
      testId="bekanntmachen-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer="Festhalten" busy={busy} sekundaer="Später" onSekundaer={onClose} testid="bekanntmachen-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="bekanntmachen-form" onSenden={() => void senden()}>
        {g && <p className="vp-nw-leise">Fassung {g.nr}</p>}
        <WahlChips frage="An wen?" optionen={[...vorschlaege.map((k) => ({ wert: k, label: k })), { wert: ANDERE, label: 'Andere' }]} wert={kreis} onWahl={setKreis} fehler={kreis !== ANDERE ? fehler.kreis : null} testid="bekanntmachen-kreis" />
        {kreis === ANDERE && <NwTextfeld label="Wem?" wert={anderer} onWert={setAnderer} fehler={fehler.kreis} hoechstens={200} testid="bekanntmachen-kreis-text" />}
        <WahlChips frage="Wie?" mehrfach optionen={WEGE} werte={wege} onWahl={setWege} fehler={fehler.wege} testid="bekanntmachen-wege" />
        {wege.includes('weiterer') && <NwTextfeld label="Welcher Weg?" wert={wegWortlaut} onWert={setWegWortlaut} fehler={fehler.weg} hoechstens={200} />}
        <TagWahl heute={heute} wert={tag} setze={setTag} mitGestern={false} min={g?.entschieden_am ?? null} />
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Überprüfung festhalten (DK5)

/**
 * Überprüfung festhalten (§6.10): „Gilt Rev. 4 noch?“ - „Ja, bleibt“ hält „geprüft, bleibt“ fest und die nächste Prüfung
 * beginnt neu; „Nein, neuer Stand“ führt zu „Neu fassen“. Wer hat entschieden, warum.
 */
export function UeberpruefungBlatt({
  dokument,
  onClose,
  onGespeichert,
  onNeuFassen,
}: {
  dokument: EnergiemanagementDokument;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
  onNeuFassen: () => void;
}) {
  const basis = basisId('up', useId());
  const g = N.gueltigeFassung(dokument);
  const heute = N.heuteDerRoute(dokument, '');
  const jahr = N.naechstePruefungJahr(heute, dokument.ueberpruefung_monate);
  const [antwort, setAntwort] = useState<'bleibt' | 'neu'>('bleibt');
  const [von, setVon] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden() {
    if (antwort === 'neu') return onNeuFassen();
    const r = E.geprueftKoerper({ entschiedenVon: von, entschiedenAm: '', begruendung });
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(await api.energiemanagementDokumentGeprueft(dokument.id, r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open
      titel="Überprüfung festhalten"
      onClose={onClose}
      testId="ueberpruefung-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer={antwort === 'neu' ? 'Neu fassen' : 'Festhalten'} busy={busy} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="ueberpruefung-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="ueberpruefung-form" onSenden={() => void senden()}>
        <AntwortKarten
          frage={N.ueberpruefungFrage(g)}
          optionen={[
            { wert: 'bleibt', titel: 'Ja, bleibt', zusatz: jahr ? `nächste Prüfung ${jahr}` : null },
            { wert: 'neu', titel: 'Nein, neuer Stand' },
          ]}
          wert={antwort}
          onWahl={setAntwort}
          testid="ueberpruefung-wahl"
        />
        {antwort === 'bleibt' && (
          <>
            <EntscheiderWahl id={`${basis}-person`} leitung={false} tag={heute} wert={von} setze={setVon} fehler={fehler.entschiedenVon} vorbelegen={false} />
            <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} mehrzeilig platzhalter="zum Beispiel: mit der Jahresplanung durchgesehen" fehler={fehler.begruendung} hoechstens={500} testid="ueberpruefung-begruendung" />
          </>
        )}
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Aufheben (DK8, Entscheid 12)

/** Aufheben (Entscheid 12): wer, wann, warum - das Dokument bleibt mit allen Fassungen lesbar; danach ändert sich nichts. */
export function AufhebenBlatt({
  dokument,
  onClose,
  onGespeichert,
}: {
  dokument: EnergiemanagementDokument;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
}) {
  const basis = basisId('ah', useId());
  const heute = N.heuteDerRoute(dokument, '');
  const [von, setVon] = useState('');
  const [tag, setTag] = useState(heute);
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden() {
    const f: E.Feldfehler = {};
    if (!von) f.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
    const b = E.begruendungFehler(begruendung);
    if (b) f.begruendung = b;
    setFehler(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(await api.energiemanagementDokumentAufheben(dokument.id, { entschieden_von: von, am: tag || null, begruendung: begruendung.trim() }));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open
      titel="Aufheben"
      onClose={onClose}
      testId="aufheben-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer="Aufheben" busy={busy} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="aufheben-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="aufheben-form" onSenden={() => void senden()}>
        <HinweisZeile icon="lock" titel="Bleibt lesbar" zusatz="ändert sich danach nie mehr" />
        <EntscheiderWahl id={`${basis}-person`} leitung={false} tag={tag} wert={von} setze={setVon} fehler={fehler.entschiedenVon} vorbelegen={false} />
        <TagWahl heute={heute} wert={tag} setze={setTag} />
        <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} mehrzeilig fehler={fehler.begruendung} hoechstens={500} testid="aufheben-begruendung" />
        <Ablehnung satz={satz} />
        <GrenzHinweis />
      </BlattFormular>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Lese-Blätter: Wortlaut, Fassungen, Original, Grund

/** Der ganze Wortlaut einer Fassung in Lese-Schrift, das Neue hinterlegt. */
export function WortlautBlatt({ dokument, fassung, onClose }: { dokument: EnergiemanagementDokument; fassung: EnergiemanagementFassung; onClose: () => void }) {
  const vorige = N.vorigeFassung(dokument, fassung);
  const r = N.wortlautMitNeuem(vorige?.form === 'wortlaut' ? (vorige.wortlaut ?? null) : null, fassung.wortlaut ?? '');
  return (
    <NwBlatt open titel={`Wortlaut · Fassung ${fassung.nr}`} onClose={onClose} breit testId="wortlaut-blatt">
      <div className="vp-nw-schritt-inhalt">
        <Wortlaut absaetze={r.absaetze} label={`Wortlaut der Fassung ${fassung.nr}`} />
        {r.neueSaetze.length > 0 && <p className="vp-nw-leise">Neu in Fassung {fassung.nr}: hinterlegt</p>}
        <GrenzHinweis />
      </div>
    </NwBlatt>
  );
}

/** Die Fassungs-Zeitleiste: neueste zuerst, „gilt“ in Navy, „überholt“ bleibt lesbar; Antippen zeigt den Wortlaut. */
export function FassungenBlatt({ dokument, onClose }: { dokument: EnergiemanagementDokument; onClose: () => void }) {
  const [offen, setOffen] = useState<number | null>(null);
  const zeilen = N.fassungsZeitleiste(dokument);
  return (
    <NwBlatt open titel={`Fassungen · ${zeilen.length}`} onClose={onClose} breit testId="fassungen-blatt">
      <ol className="vp-nw-zeitleiste">
        {zeilen.map((z) => {
          const f = dokument.fassungen.find((x) => x.nr === z.nr)!;
          return (
            <li key={z.nr} className={`is-${z.ton}`} data-testid={`fassung-${z.nr}`}>
              <button type="button" className="vp-nw-zeitleiste-k" aria-expanded={offen === z.nr} onClick={() => setOffen(offen === z.nr ? null : z.nr)}>
                <span className="vp-nw-zeitleiste-p" aria-hidden="true" />
                <span className="vp-nw-zeitleiste-t">
                  <b>
                    Fassung {z.nr} · {z.wort}
                  </b>
                  <span>{[z.datum, z.person].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              {offen === z.nr && (
                <div className="vp-nw-zeitleiste-inhalt">
                  {f.form === 'wortlaut' ? (
                    <Wortlaut absaetze={N.saetze(f.wortlaut ?? '').map((a) => a.map((t, i) => ({ text: i < a.length - 1 ? `${t} ` : t, neu: false })))} />
                  ) : (
                    <p className="vp-nw-leise">{[f.verweis?.ablage, f.verweis?.kennung, f.verweis?.fassungsangabe].filter(Boolean).join(' · ')}</p>
                  )}
                  {z.grund && <p className="vp-nw-leise">Grund: {z.grund}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <GrenzHinweis />
    </NwBlatt>
  );
}

type PruefErgebnis = { art: 'gleich' | 'anders' | 'ohne'; name: string } | null;

/**
 * Wo das Original liegt (Entscheid 9, 10): Ablage, Kennung, Stand; „Original prüfen“ bildet die Prüfsumme einer
 * gewählten Datei im Browser und vergleicht sie mit der festgehaltenen - VoltPilot sieht die Datei nie. „Öffnen“ nur bei
 * einer `https:`-Adresse.
 */
export function OriginalBlatt({ original, onClose }: { original: N.OriginalBild; onClose: () => void }) {
  const id = basisId('og', useId());
  const [ergebnis, setErgebnis] = useState<PruefErgebnis>(null);
  const [rechnet, setRechnet] = useState(false);
  async function pruefe(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    try {
      const sha = await pruefsummeLokal(datei);
      setErgebnis({ art: !original.sha256 ? 'ohne' : sha === original.sha256 ? 'gleich' : 'anders', name: datei.name });
    } finally {
      setRechnet(false);
    }
  }
  return (
    <NwBlatt open titel="Original" onClose={onClose} testId="original-blatt">
      <div className="vp-nw-schritt-inhalt">
        <PruefZeilen
          zeilen={[
            { etikett: original.verweis ? 'Geführt in' : 'Liegt in', wert: original.ablage },
            ...(original.bezeichnung ? [{ etikett: 'Bezeichnung', wert: original.bezeichnung }] : []),
            ...(original.kennung || original.stand ? [{ etikett: 'Kennung', wert: [original.kennung, original.stand].filter(Boolean).join(' · ') }] : []),
            { etikett: 'Zu', wert: `Fassung ${original.fassung}` },
          ]}
          testid="original-zeilen"
        />
        <OriginalKnoepfe original={original} id={id} rechnet={rechnet} onDatei={(l) => void pruefe(l)} />
        {ergebnis && (
          <p className={`vp-nw-status${ergebnis.art === 'anders' ? ' is-warn' : ''}`} role="status" data-testid="original-ergebnis">
            {ergebnis.art === 'gleich' ? 'Dieselbe Datei' : ergebnis.art === 'anders' ? 'Eine andere Datei' : 'Keine Prüfsumme festgehalten'}
            <span className="vp-nw-status-sub">· {ergebnis.name}</span>
          </p>
        )}
        <GrenzHinweis />
      </div>
    </NwBlatt>
  );
}

/** „Original prüfen“ (Datei wählen, Prüfsumme im Browser) und „Öffnen“ (nur `https:`) als ruhige Knöpfe. */
export function OriginalKnoepfe({ original, id, rechnet, onDatei }: { original: N.OriginalBild; id: string; rechnet: boolean; onDatei: (l: FileList | null) => void }) {
  return (
    <div className="vp-nw-wg">
      <label className="vp-nw-wg-k" htmlFor={`${id}-datei`} data-testid="original-pruefen">
        <Icon name="lock" size={16} />
        <span>{rechnet ? 'Wird geprüft …' : 'Original prüfen'}</span>
        <input id={`${id}-datei`} type="file" className="vp-nw-unsichtbar" onChange={(e) => onDatei(e.target.files)} />
      </label>
      {original.oeffnen && (
        <a className="vp-nw-wg-k" href={original.oeffnen} target="_blank" rel="noopener noreferrer" data-testid="original-oeffnen">
          <Icon name="link" size={16} />
          <span>Öffnen</span>
        </a>
      )}
    </div>
  );
}

/** Der Grund einer Fassung im ganzen Wortlaut - hinter dem i-Zeichen der Fußnote „Grund: Beschluss 3“. */
export function GrundBlatt({ fassung, onClose }: { fassung: EnergiemanagementFassung; onClose: () => void }) {
  return (
    <NwBlatt open titel={`Grund · Fassung ${fassung.nr}`} onClose={onClose} testId="grund-blatt">
      <div className="vp-nw-schritt-inhalt">
        <p className="vp-nw-zitat">{fassung.begruendung}</p>
        {fassung.beschluss_kennung && <p className="vp-nw-leise">{fassung.beschluss_kennung}</p>}
      </div>
    </NwBlatt>
  );
}
