import { Recht } from './Recht';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type Messkanal,
  type Messstelle,
  type MessstelleRegisterZeile,
  type MessstelleStellung,
  type OrtsbaumAmStichtag,
  type StandorteAmStichtag,
} from '../api';
import { jetztEingabe, kanalZeile, zeitpunktAus } from '../geraetEinstellungen';
import { UEMS_HAUPTGROESSE, UEMS_NEBENGROESSE } from '../glossar';
import {
  ablehnung,
  abschlussSatz,
  anlageOptionen,
  anlageWahlen,
  anlegenAnfrage,
  bearbeitenAnfrage,
  DIALOG_TITEL,
  einheitVon,
  ersterIdentitaetFehler,
  groesseAus,
  groesseOptionen,
  groesseSchluessel,
  groesseText,
  groesseWaehlen,
  HAUPT,
  HAUPTGROESSE_FEST,
  HAUPTGROESSE_GRUND,
  identitaetAus,
  identitaetPruefen,
  identitaetUnveraendert,
  kanalOptionen,
  KEINE_KOMPONENTE,
  kennzeichenHinweis,
  KNOPF,
  komponenteAus,
  komponenteName,
  komponenteOptionen,
  komponenteWert,
  laufendeQuelle,
  laufendSatz,
  leereGroesse,
  leereIdentitaet,
  LEERER_BESTAND,
  MEDIUM,
  OHNE_ANLAGE,
  ortAnfrage,
  ortHinweis,
  ortOptionen,
  ortWahlen,
  QUELLE_VORSPANN,
  quelleFolgenSatz,
  quellePruefen,
  quellZiele,
  richtungOptionen,
  SCHRITTE,
  stellungAnfrage,
  stellungOptionen,
  tagHinweis,
  unterzaehlerOptionen,
  vorschlagKnopf,
  wertartOptionen,
  ZUORDNUNG_REIHENFOLGE,
  zuordnungAus,
  zuordnungBestandAus,
  zuordnungPruefen,
  type DialogFeld,
  type GroesseEingabe,
  type Identitaet,
  type KomponenteWahl,
  type QuelleEingabe,
  type Schritt,
  type Zuordnung,
  type ZuordnungBestand,
} from '../messstelleDialog';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import './MessstelleDialog.css';

type Ansicht = Schritt | 'fertig';

const LEER_ORTE = () => 'Noch kein Standort angelegt.';
const LEER_UNTERZAEHLER = () => 'In dieser Anlage steht noch keine andere Messstelle.';
const LEER_ANLAGE_FEHLT = () => 'Wählen Sie zuerst die Anlage.';
const LEER_KOMPONENTEN = () => KEINE_KOMPONENTE;
const LEER_KANAELE = () => 'Diese Komponente meldet keine Messwerte.';

/**
 * Der Messstellen-Dialog (UEMS AP-04 IP-6, Mockups D1–D3): anlegen und bearbeiten im
 * zentrierten `Modal` (am Telefon Vollbild), drei Schritte — Identität · Zuordnung · Quelle.
 * Render-only: jede Regel, jeder Satz und jede Anfrage entsteht in `src/messstelleDialog.ts`.
 *
 * ⚠ JEDER SCHRITT SPEICHERT SEINEN TEIL über die Route, die es dafür gibt: „Weiter: Zuordnung“
 * legt die Messstelle an (ohne Ort ein ehrlicher Entwurf) bzw. schreibt Kennzeichen · Name ·
 * Notiz; „Weiter: Quelle“ schreibt Ort und Stellung ab dem Tag; „Fertigstellen“ bindet die
 * Quellen. Lehnt die Schnittstelle ab (zweiter Hauptzähler 409, Kennzeichen belegt 409 …), bleibt
 * der Dialog im Schritt, der Satz der FEHLER-Tabelle steht am Feld, und von DIESEM Schritt ist
 * nichts gespeichert. Nach dem ersten Speichern sind Art, Medium und Hauptgröße fest.
 *
 * Wer ihn öffnet (Register „Messstellen“, AP-04 IP-5), gibt `messstelleId` (bearbeiten) oder
 * `null` (anlegen) und optional den Standort als Vorgabe des Orts.
 */
export function MessstelleDialog({
  open,
  messstelleId = null,
  standortId = null,
  heute,
  jetzt,
  schritt,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  /** `null`: anlegen; sonst die Messstelle, die bearbeitet wird. */
  messstelleId?: string | null;
  /** Vorgabe des Orts beim Anlegen (§5.1 „Vorgabe: Standort“) — der Standort, aus dem geöffnet wird. */
  standortId?: string | null;
  /** Der Tag heute (JJJJ-MM-TT); ohne: aus `jetzt` in Europe/Berlin. */
  heute?: string;
  /** Jetzt (ISO) — Vorgabe von „Gilt ab“ der Quelle; ohne: die Uhr beim Öffnen. */
  jetzt?: string;
  /**
   * Beim Bearbeiten: der Schritt, mit dem der Dialog öffnet — „Quelle zuordnen“ aus den Werten öffnet Schritt 3
   * (UEMS AP-13 IP-6). Jeder Schritt speichert beim Bearbeiten seinen Teil; beim Anlegen öffnet er immer mit Schritt 1.
   */
  schritt?: Schritt;
  onClose: () => void;
  /** Ein Schritt hat gespeichert — der Wirt lädt das Register neu. Kommt je Schritt. */
  onGespeichert?: (m: Messstelle) => void;
}) {
  const fassung = messstelleId ? 'bearbeiten' : 'anlegen';
  const basis = `vp-msd-${useId().replace(/:/g, '')}`;
  const feldId = (f: string) => `${basis}-${f}`;

  const [uhr, setUhr] = useState(() => {
    const t = jetzt ?? new Date().toISOString();
    return { jetzt: t, heute: heute ?? jetztEingabe(t).datum };
  });
  const [ansicht, setAnsicht] = useState<Ansicht>(1);
  const [gespeichert, setGespeichert] = useState<Messstelle | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [vorschlag, setVorschlag] = useState<string | null>(null);
  const [identitaet, setIdentitaet] = useState<Identitaet>(() => leereIdentitaet(null));
  const [bestand, setBestand] = useState<ZuordnungBestand>(LEERER_BESTAND);
  const [zuordnung, setZuordnung] = useState<Zuordnung>(() => zuordnungAus(LEERER_BESTAND, uhr.heute, null));
  const [ortBeruehrt, setOrtBeruehrt] = useState(false);
  const [quelle, setQuelle] = useState<QuelleEingabe>(() => ({ komponente: '', kanaele: {}, ...jetztEingabe(uhr.jetzt) }));
  const [gebunden, setGebunden] = useState<string[]>([]);
  const [versucht, setVersucht] = useState<Record<Schritt, boolean>>({ 1: false, 2: false, 3: false });
  const [serverFehler, setServerFehler] = useState<Partial<Record<DialogFeld, string>>>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [orteFehler, setOrteFehler] = useState(false);
  const [baeume, setBaeume] = useState<Record<string, OrtsbaumAmStichtag>>({});
  const [register, setRegister] = useState<MessstelleRegisterZeile[]>([]);
  const [komponenten, setKomponenten] = useState<KomponenteWahl[] | null>(null);
  const [kanaele, setKanaele] = useState<Messkanal[] | null>(null);

  // Beim Öffnen: alles frisch — Vorschlag bzw. die gespeicherte Messstelle, Standorte mit ihren
  // Ortsbäumen und das Register von heute (Hauptzähler, „Unterzähler von“).
  useEffect(() => {
    if (!open) return undefined;
    let aktiv = true;
    const t = jetzt ?? new Date().toISOString();
    const tag = heute ?? jetztEingabe(t).datum;
    setUhr({ jetzt: t, heute: tag });
    setAnsicht(messstelleId ? (schritt ?? 1) : 1);
    setGespeichert(null);
    setLadeFehler(null);
    setVorschlag(null);
    setIdentitaet(leereIdentitaet(null));
    setBestand(LEERER_BESTAND);
    setZuordnung(zuordnungAus(LEERER_BESTAND, tag, null));
    setOrtBeruehrt(false);
    setQuelle({ komponente: '', kanaele: {}, ...jetztEingabe(t) });
    setGebunden([]);
    setVersucht({ 1: false, 2: false, 3: false });
    setServerFehler({});
    setAllgemein(null);
    setBusy(false);
    setStandorte(null);
    setOrteFehler(false);
    setBaeume({});
    setRegister([]);
    setKomponenten(null);
    setKanaele(null);

    if (messstelleId) {
      api.messstelle(messstelleId).then(
        (m) => {
          if (!aktiv) return;
          const b = zuordnungBestandAus(m, tag);
          setGespeichert(m);
          setIdentitaet(identitaetAus(m));
          setBestand(b);
          setZuordnung(zuordnungAus(b, tag, null));
        },
        () => aktiv && setLadeFehler('Die Messstelle konnte nicht geladen werden. Bitte versuchen Sie es erneut.'),
      );
    } else {
      api.kennzeichenVorschlag().then(
        (v) => {
          if (!aktiv) return;
          setVorschlag(v.kennzeichen);
          setIdentitaet((f) => (f.kennzeichen === '' ? { ...f, kennzeichen: v.kennzeichen } : f));
        },
        () => undefined,
      );
    }
    api.standorte().then(
      (s) => {
        if (!aktiv) return;
        setStandorte(s);
        for (const st of s.standorte.filter((x) => x.zustand !== 'archiviert')) {
          api.standortOrte(st.id).then(
            (baum) => aktiv && setBaeume((alt) => ({ ...alt, [st.id]: baum })),
            () => undefined,
          );
        }
      },
      () => aktiv && setOrteFehler(true),
    );
    api.messstellenRegister().then(
      (r) => aktiv && setRegister(r.register),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
    // `heute`/`jetzt` sind Stellschrauben der Tests — sie gelten ab dem Öffnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messstelleId]);

  // §5.1 „Vorgabe: Standort“ — solange niemand den Ort angefasst hat.
  useEffect(() => {
    if (!standorte || ortBeruehrt || fassung !== 'anlegen' || !standortId) return;
    const s = standorte.standorte.find((x) => x.id === standortId && x.zustand !== 'archiviert');
    if (s) setZuordnung((z) => (z.ort ? z : { ...z, ort: s.kurzzeichen }));
  }, [standorte, standortId, ortBeruehrt, fassung]);

  const hauptFest = gespeichert !== null;
  const identModus = hauptFest ? 'bearbeiten' : 'anlegen';
  const identFehler = identitaetPruefen(identitaet, identModus);
  const zuordnungFehler = zuordnungPruefen(zuordnung);
  const kennzeichen = gespeichert?.kennzeichen ?? (identitaet.kennzeichen || vorschlag || '');

  const orte = useMemo(() => (standorte ? ortWahlen(standorte, baeume) : []), [standorte, baeume]);
  const ortWahl = orte.find((o) => o.kurzzeichen === zuordnung.ort) ?? null;
  const alleAnlagen = useMemo(() => (standorte ? anlageWahlen(standorte, null) : []), [standorte]);
  const anlagen = useMemo(
    () => (standorte ? anlageWahlen(standorte, ortWahl?.standortId ?? null) : []),
    [standorte, ortWahl?.standortId],
  );
  const anlage = alleAnlagen.find((a) => a.id === zuordnung.anlage) ?? null;
  const anlageName = (id: string) => alleAnlagen.find((a) => a.id === id)?.name ?? null;

  // Die Komponenten des Schritts Quelle: die Anlage der Stellung, sonst die des Standorts vom Ort.
  const quellAnlagen = anlage ? [anlage] : ortWahl ? anlagen.filter((a) => a.standortId === ortWahl.standortId) : [];
  const quellAnlagenSchluessel = quellAnlagen.map((a) => a.id).join(',');
  useEffect(() => {
    if (!open || ansicht !== 3) return undefined;
    let aktiv = true;
    setKomponenten(null);
    void Promise.all(
      quellAnlagen.map((a) =>
        api.siteEntities(a.id).then(
          (r) => r.entities.map((entity): KomponenteWahl => ({ anlageId: a.id, anlageName: a.name, entity })),
          () => [] as KomponenteWahl[],
        ),
      ),
    ).then((listen) => aktiv && setKomponenten(listen.flat()));
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ansicht, quellAnlagenSchluessel]);

  useEffect(() => {
    const ziel = komponenteAus(quelle.komponente);
    if (!open || !ziel) {
      setKanaele(null);
      return undefined;
    }
    let aktiv = true;
    setKanaele(null);
    api.komponenteMesskanaele(ziel.anlageId, ziel.entityId).then(
      (l) => aktiv && setKanaele(l.messkanaele),
      () => aktiv && setKanaele([]),
    );
    return () => {
      aktiv = false;
    };
  }, [open, quelle.komponente]);

  // ------------------------------------------------------------------ Hilfen

  function fokus(feld: string | null) {
    if (!feld) return;
    // Nach dem Rendern der Fehlertexte, damit der Screenreader den Satz mitliest.
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  function loesche(...felder: DialogFeld[]) {
    setServerFehler((s) => {
      if (!felder.some((f) => f in s)) return s;
      const rest = { ...s };
      for (const f of felder) delete rest[f];
      return rest;
    });
    setAllgemein(null);
  }

  function setzeIdentitaet(patch: Partial<Identitaet>, ...felder: DialogFeld[]) {
    setIdentitaet((f) => ({ ...f, ...patch }));
    loesche(...felder);
  }

  function setzeZuordnung(patch: Partial<Zuordnung>, ...felder: DialogFeld[]) {
    setZuordnung((z) => ({ ...z, ...patch }));
    loesche(...felder);
  }

  function setzeQuelle(patch: Partial<QuelleEingabe>, ...felder: DialogFeld[]) {
    setQuelle((q) => ({ ...q, ...patch }));
    loesche(...felder);
  }

  function abgelehnt(err: unknown, schritt: Schritt) {
    const a = ablehnung(err instanceof ApiError ? err : null, { schritt, anlageName });
    if (a.feld) {
      setServerFehler((s) => ({ ...s, [a.feld!]: a.satz }));
      fokus(schritt === 3 && a.feld === 'kanal' ? 'kanal' : a.feld);
    } else {
      setAllgemein(a.satz);
    }
  }

  function merke(m: Messstelle) {
    setGespeichert(m);
    onGespeichert?.(m);
  }

  // ----------------------------------------------------------------- Schritte

  async function weiterIdentitaet() {
    if (busy) return;
    setVersucht((v) => ({ ...v, 1: true }));
    setAllgemein(null);
    const erster = ersterIdentitaetFehler(identFehler);
    if (erster) {
      fokus(erster);
      return;
    }
    setBusy(true);
    try {
      if (!gespeichert) {
        const m = await api.messstelleAnlegen(anlegenAnfrage(identitaet, vorschlag));
        setIdentitaet((f) => ({ ...f, kennzeichen: m.kennzeichen }));
        merke(m);
      } else if (!identitaetUnveraendert(identitaet, gespeichert)) {
        merke({ ...gespeichert, ...(await api.messstelleBearbeiten(gespeichert.id, bearbeitenAnfrage(identitaet, gespeichert))) });
      }
      setAnsicht(2);
    } catch (err) {
      abgelehnt(err, 1);
    } finally {
      setBusy(false);
    }
  }

  async function weiterZuordnung() {
    if (busy || !gespeichert) return;
    setVersucht((v) => ({ ...v, 2: true }));
    setAllgemein(null);
    const erster = ZUORDNUNG_REIHENFOLGE.find((f) => zuordnungFehler[f]);
    if (erster) {
      fokus(erster);
      return;
    }
    setBusy(true);
    let b = bestand;
    try {
      const o = ortAnfrage(zuordnung, b);
      if (o) {
        merke(await api.messstelleOrtAendern(gespeichert.id, o));
        b = { ...b, ort: zuordnung.ort, ortAb: zuordnung.gueltigAb };
        setBestand(b);
      }
      const s = stellungAnfrage(zuordnung, b);
      if (s) {
        merke(await api.messstelleStellungAendern(gespeichert.id, s));
        b = {
          ...b,
          anlage: s.anlage,
          stellung: s.stellung,
          unterzaehlerVon: s.unterzaehler_von ?? '',
          stellungAb: s.gueltig_ab,
        };
        setBestand(b);
      }
      setAnsicht(3);
    } catch (err) {
      abgelehnt(err, 2);
    } finally {
      setBusy(false);
    }
  }

  async function fertigstellen() {
    if (busy || !gespeichert) return;
    setVersucht((v) => ({ ...v, 3: true }));
    setAllgemein(null);
    const offen = {
      ...quelle,
      kanaele: Object.fromEntries(Object.entries(quelle.kanaele).filter(([s]) => !gebunden.includes(s))),
    };
    const u = quellePruefen(offen, identitaet.nebengroessen);
    if (!komponenteAus(quelle.komponente) || (u.fehler.kanal && !u.fehler.zeitpunkt && gebunden.length > 0)) {
      setAnsicht('fertig');
      return;
    }
    if (u.fehler.kanal || u.fehler.zeitpunkt) {
      fokus(u.fehler.kanal ? 'kanal' : 'zeitpunkt');
      return;
    }
    setBusy(true);
    try {
      for (const a of u.anfragen) {
        await api.messstelleQuelleBinden(gespeichert.id, a);
        const schluessel = a.groesse ? groesseSchluessel(a.groesse) : HAUPT;
        setGebunden((g) => [...g, schluessel]);
      }
      onGespeichert?.(gespeichert);
      setAnsicht('fertig');
    } catch (err) {
      abgelehnt(err, 3);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ Render

  return (
    <Modal open={open} onClose={onClose} title={DIALOG_TITEL[fassung]} footer={fuss()}>
      <div className="vp-msd" data-testid="messstelle-dialog">
        {ansicht !== 'fertig' && (
          <ol className="vp-steps" aria-label="Schritte">
            {SCHRITTE.map((label, i) => {
              const n = (i + 1) as Schritt;
              const state = n < ansicht ? 'done' : n === ansicht ? 'active' : 'todo';
              return (
                <li
                  key={label}
                  className={`vp-step vp-step-${state}`}
                  aria-current={state === 'active' ? 'step' : undefined}
                >
                  <span className="vp-step-num" aria-hidden="true">
                    {state === 'done' ? <Icon name="check" size={13} strokeWidth={3} /> : n}
                  </span>
                  <span className="vp-step-label">{label}</span>
                </li>
              );
            })}
          </ol>
        )}
        {ladeFehler ? (
          <div className="vp-alert vp-alert-err" role="alert">
            {ladeFehler}
          </div>
        ) : ansicht === 1 ? (
          schrittIdentitaet()
        ) : ansicht === 2 ? (
          schrittZuordnung()
        ) : ansicht === 3 ? (
          schrittQuelle()
        ) : (
          fertig()
        )}
        {allgemein && (
          <div className="vp-alert vp-alert-err" role="alert">
            {allgemein}
          </div>
        )}
      </div>
    </Modal>
  );

  // ⚠ Die Schritte werden als FUNKTIONEN aufgerufen, nicht als `<Schritt/>` gerendert — eine je
  // Render neu definierte Komponente würde ihre Picker bei jeder Auswahl neu mounten.

  function groesseFelder(
    praefix: string,
    e: GroesseEingabe,
    setze: (g: GroesseEingabe) => void,
    fehler: Partial<Record<'groesse' | 'richtung' | 'wertart', string>>,
  ) {
    const haupt = praefix === 'haupt';
    const id = (f: string) => feldId(haupt ? f : f === 'groesse' ? praefix : `${praefix}-${f}`);
    const einheit = einheitVon(e.groesse);
    return (
      <div className="vp-msd-groesse">
        <VpPicker
          id={id('groesse')}
          label={haupt ? `${UEMS_HAUPTGROESSE} *` : 'Größe *'}
          placeholder="Größe wählen"
          options={groesseOptionen()}
          value={e.groesse || null}
          onChange={(v) => setze(groesseWaehlen(e, v))}
          error={fehler.groesse}
        />
        <VpPicker
          id={id('richtung')}
          label="Richtung *"
          placeholder={e.groesse ? 'Richtung wählen' : 'Erst die Größe wählen'}
          options={richtungOptionen(e.groesse)}
          value={e.richtung || null}
          onChange={(v) => setze({ ...e, richtung: v })}
          disabled={!e.groesse}
          hint={einheit ? `Einheit: ${einheit}` : undefined}
          error={fehler.richtung}
        />
        <VpPicker
          id={id('wertart')}
          label="Wertart *"
          placeholder={e.groesse ? 'Wertart wählen' : 'Erst die Größe wählen'}
          options={wertartOptionen(e.groesse)}
          value={e.wertart || null}
          onChange={(v) => setze({ ...e, wertart: v })}
          disabled={!e.groesse}
          error={fehler.wertart}
        />
      </div>
    );
  }

  function schrittIdentitaet() {
    if (fassung === 'bearbeiten' && !gespeichert) {
      return <p className="vp-msd-vorspann">Die Messstelle wird geladen …</p>;
    }
    const zeigen = versucht[1];
    const haupt = groesseAus(identitaet.hauptgroesse);
    const hinweis = kennzeichenHinweis(identitaet.kennzeichen, vorschlag, identModus);
    const zurueckZumVorschlag = vorschlagKnopf(identitaet.kennzeichen, vorschlag, identModus);
    return (
      <div className="vp-msd-stapel">
        {fassung === 'anlegen' && gespeichert && (
          <p className="vp-msd-vorspann">
            {abschlussSatz(gespeichert, { fassung, quelleGebunden: false, quelleVorhanden: false })}
          </p>
        )}
        <Input
          id={feldId('kennzeichen')}
          label={identModus === 'anlegen' ? 'Kennzeichen' : 'Kennzeichen *'}
          value={identitaet.kennzeichen}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setzeIdentitaet({ kennzeichen: e.target.value }, 'kennzeichen')}
          hint={hinweis ?? undefined}
          error={serverFehler.kennzeichen ?? (zeigen ? identFehler.felder.kennzeichen : undefined)}
        />
        {zurueckZumVorschlag && vorschlag && (
          <div className="vp-msd-links">
            <Button variant="ghost" size="sm" onClick={() => setzeIdentitaet({ kennzeichen: vorschlag }, 'kennzeichen')}>
              {zurueckZumVorschlag}
            </Button>
          </div>
        )}
        <Input
          id={feldId('name')}
          label="Name *"
          value={identitaet.name}
          autoComplete="off"
          onChange={(e) => setzeIdentitaet({ name: e.target.value }, 'name')}
          error={serverFehler.name ?? (zeigen ? identFehler.felder.name : undefined)}
        />
        <div className="vp-msd-fest">
          <span className="vp-msd-fest-label">Medium</span>
          <span className="vp-msd-fest-wert">{MEDIUM}</span>
        </div>
        {hauptFest ? (
          <div className="vp-msd-fest">
            <span className="vp-msd-fest-label">{UEMS_HAUPTGROESSE}</span>
            <span className="vp-msd-fest-wert">{haupt ? groesseText(haupt) : '—'}</span>
            <span className="vp-msd-grund">{HAUPTGROESSE_FEST}</span>
          </div>
        ) : (
          <>
            {groesseFelder(
              'haupt',
              identitaet.hauptgroesse,
              (g) => setzeIdentitaet({ hauptgroesse: g }),
              zeigen ? identFehler.felder : {},
            )}
            <p className="vp-msd-grund">{HAUPTGROESSE_GRUND}</p>
          </>
        )}
        {identitaet.nebengroessen.map((n, i) => {
          const fest = groesseAus(n);
          return (
            <div key={i} className="vp-msd-neben">
              <div className="vp-msd-neben-kopf">
                <span className="vp-msd-neben-titel">
                  {UEMS_NEBENGROESSE} {i + 1}
                </span>
                {!hauptFest && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setzeIdentitaet({ nebengroessen: identitaet.nebengroessen.filter((_, j) => j !== i) })
                    }
                  >
                    {KNOPF.entfernen}
                  </Button>
                )}
              </div>
              {hauptFest ? (
                <span className="vp-msd-fest-wert">{fest ? groesseText(fest) : `${n.groesse} · ${n.richtung}`}</span>
              ) : (
                groesseFelder(
                  `neben-${i}`,
                  n,
                  (g) =>
                    setzeIdentitaet({ nebengroessen: identitaet.nebengroessen.map((x, j) => (j === i ? g : x)) }),
                  {},
                )
              )}
              {!hauptFest && zeigen && identFehler.neben[i] && (
                <p className="vp-msd-fehler">{identFehler.neben[i]}</p>
              )}
            </div>
          );
        })}
        {!hauptFest && (
          <div className="vp-msd-links">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setzeIdentitaet({ nebengroessen: [...identitaet.nebengroessen, leereGroesse()] })}
            >
              {KNOPF.nebengroesse}
            </Button>
          </div>
        )}
        <Input
          id={feldId('notiz')}
          label="Notiz"
          value={identitaet.notiz}
          onChange={(e) => setzeIdentitaet({ notiz: e.target.value })}
        />
      </div>
    );
  }

  function schrittZuordnung() {
    const lokal = versucht[2] ? zuordnungFehler : {};
    const fehler = (f: DialogFeld & keyof typeof zuordnungFehler) => serverFehler[f] ?? lokal[f];
    return (
      <div className="vp-msd-stapel">
        <VpPicker
          id={feldId('ort')}
          label="Ort"
          placeholder="Ort wählen"
          options={ortOptionen(orte)}
          value={zuordnung.ort || null}
          onChange={(v) => {
            setOrtBeruehrt(true);
            const neu = orte.find((o) => o.kurzzeichen === v) ?? null;
            const bleibt = !zuordnung.anlage || !standorte
              ? true
              : anlageWahlen(standorte, neu?.standortId ?? null).some((a) => a.id === zuordnung.anlage);
            setzeZuordnung(bleibt ? { ort: v } : { ort: v, anlage: '', stellung: '', unterzaehlerVon: '' }, 'ort');
          }}
          loading={!standorte && !orteFehler}
          loadError={orteFehler ? 'Die Orte konnten nicht geladen werden.' : null}
          emptyText={LEER_ORTE}
          hint={ortHinweis(ortWahl, kennzeichen)}
          error={fehler('ort')}
        />
        <VpPicker
          id={feldId('anlage')}
          label="Anlage"
          placeholder="Anlage wählen"
          options={anlageOptionen(anlagen)}
          value={zuordnung.anlage || null}
          onChange={(v) => setzeZuordnung({ anlage: v, unterzaehlerVon: '' }, 'anlage', 'stellung', 'unterzaehlerVon')}
          loading={!standorte && !orteFehler}
          hint="In welchem elektrischen Baum steht die Messstelle? Ohne Anlage bleibt sie ohne Stellung."
          error={fehler('anlage')}
        />
        <VpPicker
          id={feldId('stellung')}
          label="Elektrische Stellung"
          placeholder="Stellung wählen"
          options={stellungOptionen(register, anlage, gespeichert?.id ?? null)}
          value={zuordnung.stellung || null}
          onChange={(v) =>
            setzeZuordnung(
              { stellung: v as MessstelleStellung, ...(v !== 'Unterzähler' ? { unterzaehlerVon: '' } : {}) },
              'stellung',
              'unterzaehlerVon',
            )
          }
          error={fehler('stellung')}
        />
        {zuordnung.stellung === 'Unterzähler' && (
          <VpPicker
            id={feldId('unterzaehlerVon')}
            label="Unterzähler von *"
            placeholder="Messstelle wählen"
            options={
              zuordnung.anlage ? unterzaehlerOptionen(register, zuordnung.anlage, gespeichert?.kennzeichen ?? null) : []
            }
            emptyText={zuordnung.anlage ? LEER_UNTERZAEHLER : LEER_ANLAGE_FEHLT}
            value={zuordnung.unterzaehlerVon || null}
            onChange={(v) => setzeZuordnung({ unterzaehlerVon: v }, 'unterzaehlerVon', 'stellung')}
            error={fehler('unterzaehlerVon')}
          />
        )}
        {(zuordnung.ort || zuordnung.anlage) && (
          <VpDatePicker
            id={feldId('gueltigAb')}
            label="Gilt ab *"
            value={zuordnung.gueltigAb}
            onChange={(v) => setzeZuordnung({ gueltigAb: v }, 'gueltigAb')}
            hint={tagHinweis(zuordnung.gueltigAb, uhr.heute) ?? undefined}
            error={fehler('gueltigAb')}
          />
        )}
      </div>
    );
  }

  function schrittQuelle() {
    const ziele = quellZiele(identitaet, gespeichert, uhr.jetzt);
    const offen = ziele.filter((z) => !z.laufend && !gebunden.includes(z.schluessel));
    const lokal = versucht[3]
      ? quellePruefen(
          { ...quelle, kanaele: Object.fromEntries(Object.entries(quelle.kanaele).filter(([s]) => !gebunden.includes(s))) },
          identitaet.nebengroessen,
        ).fehler
      : {};
    const komponente = komponenten?.find((k) => komponenteWert(k.anlageId, k.entity.id) === quelle.komponente) ?? null;
    const messwerte = offen.flatMap((z) => {
      const k = kanaele?.find((x) => x.kanal === quelle.kanaele[z.schluessel]);
      return k ? [kanalZeile(k).name] : [];
    });
    const zeit = zeitpunktAus(quelle.datum, quelle.uhrzeit);
    const folgen =
      komponente && messwerte.length && 'iso' in zeit
        ? quelleFolgenSatz({
            kennzeichen,
            zeitpunkt: zeit.iso,
            jetzt: uhr.jetzt,
            komponente: komponenteName(komponente.entity),
            messwerte,
          })
        : null;
    return (
      <div className="vp-msd-stapel">
        <p className="vp-msd-vorspann">{QUELLE_VORSPANN}</p>
        {ziele
          .filter((z) => z.laufend || gebunden.includes(z.schluessel))
          .map((z) => (
            <div key={z.schluessel} className="vp-msd-fest">
              <span className="vp-msd-fest-label">{z.label}</span>
              <span className="vp-msd-fest-wert">
                {gebunden.includes(z.schluessel) ? 'Die Quelle ist gebunden.' : laufendSatz(z.laufend!, uhr.jetzt)}
              </span>
            </div>
          ))}
        {offen.length > 0 &&
          (quellAnlagen.length === 0 ? (
            <p className="vp-msd-grund">{OHNE_ANLAGE}</p>
          ) : (
            <>
              <VpPicker
                id={feldId('komponente')}
                label="Komponente"
                placeholder="Komponente wählen"
                options={komponenteOptionen(komponenten ?? [])}
                loading={komponenten === null}
                emptyText={LEER_KOMPONENTEN}
                value={quelle.komponente || null}
                onChange={(v) => setzeQuelle({ komponente: v, kanaele: {} }, 'kanal')}
              />
              {quelle.komponente &&
                offen.map((z, i) => (
                  <VpPicker
                    key={z.schluessel}
                    id={feldId(i === 0 ? 'kanal' : `kanal-${i}`)}
                    label={z.label}
                    placeholder="Messwert wählen"
                    options={kanaele ? kanalOptionen(kanaele, z.groesse, kennzeichen || null, z.rolle) : []}
                    loading={kanaele === null}
                    emptyText={LEER_KANAELE}
                    value={quelle.kanaele[z.schluessel] || null}
                    onChange={(v) => setzeQuelle({ kanaele: { ...quelle.kanaele, [z.schluessel]: v } }, 'kanal')}
                    error={i === 0 ? (serverFehler.kanal ?? lokal.kanal) : undefined}
                  />
                ))}
              {quelle.komponente && (
                <div className="vp-msd-zeit">
                  <VpDatePicker
                    id={feldId('zeitpunkt')}
                    label="Gilt ab *"
                    value={quelle.datum}
                    onChange={(v) => setzeQuelle({ datum: v }, 'zeitpunkt')}
                    error={serverFehler.zeitpunkt ?? lokal.zeitpunkt}
                  />
                  <VpTimePicker
                    label="Uhrzeit *"
                    value={quelle.uhrzeit}
                    onChange={(v) => setzeQuelle({ uhrzeit: v }, 'zeitpunkt')}
                  />
                </div>
              )}
              {folgen && (
                <p className="vp-msd-folgen" data-testid="messstelle-folgen">
                  <span className="vp-msd-folgen-titel">Was geschieht</span>
                  {folgen}
                </p>
              )}
            </>
          ))}
      </div>
    );
  }

  function fertig() {
    if (!gespeichert) return null;
    const vorhanden = laufendeQuelle(gespeichert.fuehrende_quelle, uhr.jetzt) !== null;
    return (
      <div className="vp-msd-fertig" role="status">
        <Icon name="check" size={20} />
        <span>{abschlussSatz(gespeichert, { fassung, quelleGebunden: gebunden.length > 0, quelleVorhanden: vorhanden })}</span>
      </div>
    );
  }

  function fuss() {
    if (ansicht === 'fertig') {
      return <Button onClick={onClose}>{KNOPF.schliessen}</Button>;
    }
    const zurueck =
      ansicht === 1 ? (
        <Button variant="ghost" className="vp-msd-zurueck" onClick={onClose}>
          {gespeichert && fassung === 'anlegen' ? KNOPF.schliessen : KNOPF.abbrechen}
        </Button>
      ) : (
        <Button
          variant="ghost"
          className="vp-msd-zurueck"
          disabled={busy}
          onClick={() => {
            setAllgemein(null);
            setAnsicht((ansicht - 1) as Schritt);
          }}
        >
          {KNOPF.zurueck}
        </Button>
      );
    const ladend = fassung === 'bearbeiten' && !gespeichert;
    return (
      // Die Knöpfe stehen direkt im Fuß des Modals: am Telefon stapelt er sie in voller Breite.
      <>
        {zurueck}
        {ansicht === 1 && (
          <Recht aktion="messstelle.bearbeiten"><Button onClick={() => void weiterIdentitaet()} disabled={busy || ladend || ladeFehler !== null}>
            {busy ? KNOPF.speichert : KNOPF.weiterZuordnung}
          </Button></Recht>
        )}
        {ansicht === 2 && (
          <Recht aktion="messstelle.bearbeiten"><Button onClick={() => void weiterZuordnung()} disabled={busy}>
            {busy ? KNOPF.speichert : KNOPF.weiterQuelle}
          </Button></Recht>
        )}
        {ansicht === 3 && (
          <>
            <Button variant="ghost" onClick={() => setAnsicht('fertig')} disabled={busy}>
              {KNOPF.spaeter}
            </Button>
            <Recht aktion="messstelle.quelle"><Button onClick={() => void fertigstellen()} disabled={busy}>
              {busy ? KNOPF.speichert : KNOPF.fertig}
            </Button></Recht>
          </>
        )}
      </>
    );
  }
}
