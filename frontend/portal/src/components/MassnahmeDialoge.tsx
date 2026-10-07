import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type Energieeinsatz,
  type Energieziel,
  type Kennzahl,
  type Massnahme,
  type MassnahmeSchaetzung,
  type StandortAmStichtag,
} from '../api';
import { herkunftSatz } from '../auditFeststellung';
import { benutzerApi, type BenutzerEintrag } from '../benutzer';
import { verantwortlichOptionen } from '../bewertung';
import type { BezugsbasisVergleich } from '../bezugsbasisVergleich';
import * as Z from '../energieziele';
import { NBSP } from '../format';
import { UEMS_ENERGIEZIEL, UEMS_MASSNAHME, UEMS_NORMGRENZE, UEMS_VERANTWORTLICH } from '../glossar';
import * as M from '../massnahmen';
import * as B from '../massnahmenBild';
import * as P from '../massnahmePlanen';
import { hashForRoute, massnahmeRoute } from '../nav';
import { useRoutenHeute } from '../routenUhr';
import { useIsPhone } from '../useIsPhone';
import { Ablehnung } from './EnergiezielDialoge';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';
import '../pages/Massnahmen.css';

// ------------------------------------------------------------------ Bausteine der Blätter

/** Ein Textfeld mit Beschriftung, Hilfe und Fehler (Muster `.feld` des Konzepts). */
export function TextFeld({
  id,
  label,
  wert,
  setze,
  hilfe,
  fehler,
  platzhalter,
  zeilen = 3,
  testid,
  labelDoppelt = false,
}: {
  id: string;
  label: string;
  /** Die Frage steht schon als Überschrift des Teils (am Rechner): die Beschriftung bleibt nur für Screenreader. */
  labelDoppelt?: boolean;
  wert: string;
  setze: (t: string) => void;
  hilfe?: string;
  fehler?: string | null;
  platzhalter?: string;
  zeilen?: number;
  testid?: string;
}) {
  return (
    <div className="vp-mn-feld">
      <label htmlFor={id} className={labelDoppelt ? 'vp-mn-label-doppelt' : undefined}>
        {label}
      </label>
      <textarea
        id={id}
        rows={zeilen}
        value={wert}
        placeholder={platzhalter}
        onChange={(x) => setze(x.target.value)}
        aria-invalid={!!fehler}
        aria-describedby={`${id}-hilfe`}
        data-testid={testid}
      />
      <p id={`${id}-hilfe`} className={fehler ? 'vp-mn-fehler' : 'vp-mn-hilfe'}>
        {fehler ?? hilfe}
      </p>
    </div>
  );
}

/** Antwort-Karten (`.wahl`): ein Radio als ganze Karte, mindestens 52 px hoch. */
export function Wahl<T extends string>({
  name,
  legende,
  wert,
  setze,
  optionen,
  quer = false,
  testid,
}: {
  name: string;
  legende: string;
  wert: T | null;
  setze: (w: T) => void;
  optionen: { wert: T; wort: string; satz?: string | null }[];
  quer?: boolean;
  testid?: string;
}) {
  return (
    <fieldset className={`vp-mn-wahl${quer ? ' is-quer' : ''}`} data-testid={testid}>
      <legend>{legende}</legend>
      {optionen.map((o) => (
        <label key={o.wert} className="vp-mn-wo" data-testid={testid ? `${testid}-${o.wert}` : undefined}>
          <input type="radio" name={name} value={o.wert} checked={wert === o.wert} onChange={() => setze(o.wert)} />
          <b>{o.wort}</b>
          {o.satz && <span>{o.satz}</span>}
        </label>
      ))}
    </fieldset>
  );
}

/** Die Schnellwahl (`.schnell`): Knöpfe mit `aria-pressed`, mindestens 40 px hoch. */
function Schnellwahl({ optionen, wert, setze, label }: { optionen: { wert: string; wort: string }[]; wert: string | null; setze: (w: string) => void; label: string }) {
  return (
    <div className="vp-mn-schnell" role="group" aria-label={label}>
      {optionen.map((o) => (
        <button key={o.wert} type="button" aria-pressed={wert === o.wert} onClick={() => setze(o.wert)}>
          {o.wort}
        </button>
      ))}
    </div>
  );
}

/** „Danach …“: was nach dem Schritt passiert, in einer leisen Karte. */
function Danach({ children }: { children: ReactNode }) {
  return (
    <div className="vp-mn-danach">
      <span>Danach</span>
      <span>{children}</span>
    </div>
  );
}

/** Die Knöpfe am Fuß eines Blatts: am Telefon Hauptknopf zuerst, „Abbrechen“ leise darunter (Modal `blatt`). */
function Fuss({ form, haupt, busy, onClose, testid, abbrechen = P.ABBRECHEN }: { form: string; haupt: string; busy: boolean; onClose: () => void; testid: string; abbrechen?: string }) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        {abbrechen}
      </Button>
      <Button type="submit" form={form} disabled={busy} data-testid={testid}>
        {haupt}
      </Button>
    </>
  );
}

/** „Heute“ der Route (eine Uhr, Befund 2, `routenUhr.ts`): der genannte Tag, sonst der gemerkte bzw. gelesene Abruf. */
function useHeute(tagHeute?: string): string | null {
  const routen = useRoutenHeute();
  return tagHeute ?? routen;
}

// ------------------------------------------------------------------ Kataloge des Planers

interface Kataloge {
  /** `null` = die Konten sind für diese Person nicht lesbar — dann ein Satz statt der Wahl. */
  benutzer: BenutzerEintrag[] | null;
  kennzahlen: Kennzahl[];
  standorte: StandortAmStichtag[];
  einsaetze: Energieeinsatz[];
  energieziele: Energieziel[];
}

function useKataloge() {
  const [daten, setDaten] = useState<Kataloge | null>(null);
  useEffect(() => {
    let aktiv = true;
    Promise.all([
      benutzerApi.liste().catch(() => null),
      api.kennzahlen().then((k) => k.kennzahlen, () => [] as Kennzahl[]),
      api.standorte().then((s) => s.standorte, () => [] as StandortAmStichtag[]),
      api.energieeinsaetze().then((e) => e.energieeinsaetze, () => [] as Energieeinsatz[]),
      api.energieziele({ zustand: 'offen' }).then((z) => z.energieziele, () => [] as Energieziel[]),
    ]).then(([benutzer, kennzahlen, standorte, einsaetze, energieziele]) => {
      if (aktiv) setDaten({ benutzer, kennzahlen, standorte, einsaetze, energieziele });
    });
    return () => {
      aktiv = false;
    };
  }, []);
  return daten;
}

/** Nur aktive Konten des Kundenbereichs (M1, RE3) — ein angelegtes, gesperrtes oder entferntes Konto trägt nichts. */
const aktiveKonten = (b: BenutzerEintrag[]) => verantwortlichOptionen(b.filter((x) => x.zustand === 'aktiv'));

/** Der Name einer Kennzahl ohne Kennzeichen (V6), sonst das Kennzeichen. */
const kennzahlName = (k: Pick<Kennzahl, 'name' | 'kennzeichen'> | undefined | null) => (k ? k.name || k.kennzeichen : null);

type Vorher = { art: 'aus' } | { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; v: BezugsbasisVergleich };

/** Der Vorher-Satz aus dem Vergleich-Leser: „März 2029 · 2,2 % mehr als erwartet“, sonst der Satz des Monats. */
function vorherSatz(vorher: Vorher, e: P.Entwurf): { kurz: string; lang: string | null } {
  const text = P.vorherText(e);
  if (vorher.art !== 'da') return { kurz: text, lang: null };
  const v = vorher.v;
  if (e.von === e.bis) {
    const m = v.monate.find((x) => x.periode === e.von);
    const d = m?.bereinigt.delta_prozent;
    if (m && d !== null && d !== undefined) {
      const kurz = `${text}, ${B.prozentBetrag(d)} ${Number(d) < 0 ? 'weniger' : 'mehr'} als erwartet`;
      return { kurz, lang: null };
    }
    return { kurz: text, lang: ohneMonat(m?.satz ?? null, text) };
  }
  const z = v.zeitraum;
  if (z.delta_prozent !== null) {
    return { kurz: `${text}, ${B.prozentBetrag(z.delta_prozent)} ${Number(z.delta_prozent) < 0 ? 'weniger' : 'mehr'} als erwartet`, lang: null };
  }
  return { kurz: text, lang: ohneMonat(z.satz, text) };
}

/** „März 2029: nicht bewertbar …“ hinter „März 2029.“ ohne den Monat ein zweites Mal. */
function ohneMonat(satz: string | null, monat: string): string | null {
  if (!satz) return null;
  const rest = satz.startsWith(`${monat}: `) ? satz.slice(monat.length + 2) : satz;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// ------------------------------------------------------------------ Maßnahme planen (§6.9)

/**
 * „Maßnahme planen“ (Verbessern-Konzept v1 §6.9, Richtungsfrage 9.3 A): am Telefon vier kurze Schritte in einem Blatt,
 * am Rechner dieselben Fragen in einem Dialog mit der Zusammenfassung rechts, die mitwächst. Vorbelegung am Energieziel
 * (Kennzahl, Energieziel), an einer Abweichung (Kennzahl, Monate) und aus dem Energiemanagement (Herkunft). Prozent
 * rechnet die Route in kWh im Jahr um (Entscheid 13), „Weiß ich noch nicht“ lässt die Zahl weg (Entscheid 12).
 * Ablehnungen vor dem Senden: höchstens zwölf abgeschlossene Monate Vorher, eine Zahl nur mit Kennzahl.
 */
export function MassnahmeAnlegenDialog({
  vorbelegung,
  onClose,
  onAngelegt,
  tagHeute,
}: {
  vorbelegung: M.MassnahmeVorbelegung;
  onClose: () => void;
  onAngelegt: (m: Massnahme) => void;
  /** Der Tag der Route; ohne liest der Planer den Abruf der Liste. */
  tagHeute?: string;
}) {
  const heute = useHeute(tagHeute);
  return heute ? (
    <Planer vorbelegung={vorbelegung} onClose={onClose} onAngelegt={onAngelegt} heute={heute} />
  ) : (
    <Modal open onClose={onClose} title={P.TITEL} blatt breit>
      <p className="vp-mn-leise" aria-busy="true">
        Wird vorbereitet …
      </p>
    </Modal>
  );
}

function Planer({
  vorbelegung,
  onClose,
  onAngelegt,
  heute,
}: {
  vorbelegung: M.MassnahmeVorbelegung;
  onClose: () => void;
  onAngelegt: (m: Massnahme) => void;
  heute: string;
}) {
  const basis = `mp-${useId().replace(/:/g, '')}`;
  const telefon = useIsPhone();
  const daten = useKataloge();
  const [e, setE] = useState<P.Entwurf>(() => P.entwurfAus(vorbelegung, heute));
  const [schritt, setSchritt] = useState<P.Schritt>(1);
  const [zeigen, setZeigen] = useState<P.Fehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vorher, setVorher] = useState<Vorher>({ art: 'aus' });
  const [andererMonat, setAndererMonat] = useState(false);
  const [andererTag, setAndererTag] = useState(false);
  const [schaetzung, setSchaetzung] = useState<MassnahmeSchaetzung | null>(null);
  const setze = (teil: Partial<P.Entwurf>) => setE((alt) => ({ ...alt, ...teil }));

  const kennzahlen = (daten?.kennzahlen ?? []).filter((k) => P.mitBasis(k) || k.id === vorbelegung.kennzahl);
  const kennzahl = kennzahlen.find((k) => k.id === e.kennzahl) ?? null;
  const zieleDerKennzahl = (daten?.energieziele ?? []).filter((z) => z.kennzahl.id === e.kennzahl);
  const energieziel = (daten?.energieziele ?? []).find((z) => z.id === e.energieziel) ?? null;

  // Ohne Kennzahl mit Basis bleibt „gemessen“ nicht die Vorgabe (Vorbelegung von Hand).
  useEffect(() => {
    if (!daten || vorbelegung.kennzahl) return;
    if (e.art === 'gemessen' && !daten.kennzahlen.some(P.mitBasis)) setze({ art: P.artAus(vorbelegung, false) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daten]);

  // Läuft für die gewählte Kennzahl genau ein Energieziel, steht es vorbelegt - wie bisher (§5.4).
  useEffect(() => {
    if (vorbelegung.energieziel || !daten) return;
    setE((alt) => ({ ...alt, energieziel: alt.art === 'gemessen' && zieleDerKennzahl.length === 1 ? zieleDerKennzahl[0].id : '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.kennzahl, e.art, daten]);

  // Vorher: der Vergleich-Leser über die gewählten Monate (die Kopie bildet erst die Route).
  useEffect(() => {
    if (e.art !== 'gemessen' || !e.kennzahl || e.von > e.bis) {
      setVorher({ art: 'aus' });
      return;
    }
    let aktiv = true;
    setVorher({ art: 'laedt' });
    api.bezugsbasisVergleich(e.kennzahl, { von: e.von, bis: e.bis }).then(
      (v) => aktiv && setVorher({ art: 'da', v }),
      () => aktiv && setVorher({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [e.art, e.kennzahl, e.von, e.bis]);

  // Entscheid 13: die Umrechnung in kWh im Jahr liest die Route (dieselbe Rechnung wie beim Anlegen).
  const prozent = e.art === 'gemessen' && !e.weissNicht ? P.prozentAusEingabe(e.prozent) : null;
  useEffect(() => {
    if (!prozent || !e.kennzahl) {
      setSchaetzung(null);
      return;
    }
    let aktiv = true;
    const t = window.setTimeout(() => {
      api.massnahmeSchaetzung(e.kennzahl, prozent).then(
        (s) => aktiv && setSchaetzung(s),
        () => aktiv && setSchaetzung(null),
      );
    }, 250);
    return () => {
      aktiv = false;
      window.clearTimeout(t);
    };
  }, [prozent, e.kennzahl]);

  const person = daten?.benutzer?.find((b) => b.sub === e.verantwortlich) ?? null;
  const vor = vorherSatz(vorher, e);
  const kwhJahr = schaetzung?.kwh_jahr ? B.rund(schaetzung.kwh_jahr) : null;
  const zusammen = P.zusammenfassung(e, {
    kennzahl: kennzahlName(kennzahl),
    energieziel: energieziel ? B.energiezielText(energieziel.kennzeichen, energieziel.wortlaut) : null,
    person: person ? (person.anzeigename ?? person.sub) : null,
    vorher: e.art === 'gemessen' ? vor.kurz : null,
    kwhJahr,
  });
  const herkunft =
    herkunftSatz(vorbelegung.herkunft, vorbelegung.herkunftKennung ?? null) ?? P.herkunftZeile(vorbelegung);
  const unter = [
    herkunft,
    energieziel ? `für das ${B.energiezielName(energieziel.kennzeichen)}` : null,
    vorbelegung.kennzahl && kennzahl ? kennzahlName(kennzahl) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  function weiter() {
    const f = P.pruefen(e, schritt, heute);
    setZeigen(f);
    const erstes = Object.keys(f)[0];
    if (erstes) {
      document.getElementById(`${basis}-${erstes}`)?.focus();
      return;
    }
    setSchritt((s) => (Math.min(4, s + 1) as P.Schritt));
  }

  async function senden(ev?: FormEvent) {
    ev?.preventDefault();
    const f = P.pruefen(e, 4, heute);
    setZeigen(f);
    const erstes = Object.keys(f)[0] as keyof P.Fehler | undefined;
    if (erstes) {
      // Am Telefon zum Schritt mit dem ersten Fehler zurück.
      const zu: Record<keyof P.Fehler, P.Schritt> = { titel: 1, kennzahl: 1, prozent: 2, kwh: 2, wortlaut: 2, monate: 2, verantwortlich: 3, termin: 3 };
      if (telefon) setSchritt(zu[erstes]);
      if (erstes === 'monate') setAndererMonat(true);
      if (erstes === 'termin') setAndererTag(false);
      requestAnimationFrame(() => document.getElementById(`${basis}-${erstes}`)?.focus());
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onAngelegt(await api.massnahmeAnlegen(P.anfrage(e, vorbelegung, vorbelegung.einstufungFassung)));
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const vorschlaege = P.terminVorschlaege(heute);
  const terminGewaehlt = vorschlaege.some((v) => v.wert === e.termin) ? e.termin : andererTag ? P.ANDERER_TAG : null;
  const einsaetze = (daten?.einsaetze ?? []).filter((x) => !x.beendet_am || x.id === vorbelegung.einsatz);

  const teil1 = (
    <div className={`vp-mn-teil${schritt === 1 ? ' is-aktiv' : ''}`} data-testid="planen-teil-1">
      <h3 className="vp-mn-teil-titel">
        <span className="vp-mn-nr">1</span>
        Was ist zu tun?
      </h3>
      <TextFeld
        id={`${basis}-titel`}
        label="Was ist zu tun?"
        wert={e.titel}
        setze={(t) => setze({ titel: t })}
        hilfe="Ein Satz, den jeder im Werk versteht."
        fehler={zeigen.titel}
        zeilen={2}
        testid="planen-titel"
        labelDoppelt
      />
      <Wahl
        name={`${basis}-art`}
        legende="Wie zeigt sich die Wirkung?"
        wert={e.art}
        setze={(a) => setze({ art: a, ...(a !== 'gemessen' ? { prozent: '' } : { kwh: '' }) })}
        optionen={(['gemessen', 'nicht_gemessen', 'organisatorisch'] as const)
          .filter((a) => a !== 'gemessen' || kennzahlen.length > 0 || !daten)
          .map((a) => ({
            wert: a,
            wort: P.ART_WAHL[a].wort,
            satz: a === 'gemessen' && kennzahl && vorbelegung.kennzahl ? `${kennzahlName(kennzahl)}${energieziel ? ' - wie beim Energieziel' : ''}` : P.ART_WAHL[a].satz,
          }))}
        testid="planen-art"
      />
      {e.art === 'gemessen' && !vorbelegung.kennzahl && (
        <VpPicker
          id={`${basis}-kennzahl`}
          label="An welcher Kennzahl?"
          options={kennzahlen.map((k) => ({ value: k.id, label: kennzahlName(k) ?? k.kennzeichen }))}
          loading={!daten}
          value={e.kennzahl || null}
          onChange={(v) => setze({ kennzahl: v ?? '' })}
          hint="Nur Kennzahlen mit freigegebener Bezugsbasis: ohne sie gibt es nichts, wogegen VoltPilot messen kann."
          error={zeigen.kennzahl ?? null}
        />
      )}
      {e.art !== 'gemessen' && (
        <VpPicker
          id={`${basis}-standort`}
          label="Wo?"
          options={[{ value: '', label: M.UNTERNEHMEN }, ...(daten?.standorte ?? []).map((s) => ({ value: s.id, label: s.name }))]}
          loading={!daten}
          value={e.standort}
          onChange={(v) => setze({ standort: v ?? '' })}
        />
      )}
    </div>
  );

  const teil2 = (
    <div className={`vp-mn-teil${schritt === 2 ? ' is-aktiv' : ''}`} data-testid="planen-teil-2">
      <h3 className="vp-mn-teil-titel">
        <span className="vp-mn-nr">2</span>
        {P.SCHRITT_FRAGE[2]}
      </h3>
      {e.titel.trim() && <p className="vp-mn-unter vp-mn-nur-telefon">{e.titel.trim()}</p>}
      {e.art === 'gemessen' && (
        <div className="vp-mn-feld">
          <label htmlFor={`${basis}-prozent`} className="vp-mn-label-doppelt">
            Wie viel weniger Energie erwarten Sie?
          </label>
          <div className="vp-mn-prozent">
            <div className="vp-mn-prozent-feld">
              <input
                id={`${basis}-prozent`}
                inputMode="decimal"
                value={e.weissNicht ? '' : e.prozent}
                disabled={e.weissNicht}
                onChange={(x) => setze({ prozent: x.target.value })}
                aria-invalid={!!zeigen.prozent}
                aria-describedby={`${basis}-prozent-hilfe`}
                data-testid="planen-prozent"
              />
              <span>% weniger als erwartet</span>
            </div>
            <Schnellwahl
              label="Schätzung"
              optionen={[{ wert: 'weiss_nicht', wort: P.WEISS_NICHT }]}
              wert={e.weissNicht ? 'weiss_nicht' : null}
              setze={() => setze({ weissNicht: !e.weissNicht })}
            />
          </div>
          <p
            id={`${basis}-prozent-hilfe`}
            className={zeigen.prozent || schaetzung?.grund === 'kennzahl_ohne_bezugsbasis' ? 'vp-mn-fehler' : 'vp-mn-hilfe'}
            data-testid="planen-umrechnung"
          >
            {zeigen.prozent ??
              (schaetzung?.grund === 'kennzahl_ohne_bezugsbasis'
                ? M.ABLEHNUNG.kennzahl_ohne_bezugsbasis
                : e.weissNicht
                ? 'Ohne Zahl misst VoltPilot trotzdem: nach der Umsetzung steht da, was beobachtet wurde.'
                : schaetzung?.kwh_jahr
                  ? `Entspricht rund ${B.rund(schaetzung.kwh_jahr)}${NBSP}kWh im Jahr - gerechnet mit ${B.ganz(schaetzung.grundlage_kwh!)}${NBSP}kWh in ${Z.zielperiodeText(schaetzung.grundlage_monate)}.`
                  : schaetzung?.grund === 'monate_fehlen'
                    ? `In kWh im Jahr umrechnen lässt sich das erst mit zwölf gemessenen Monaten (bisher ${schaetzung.monate_mit_wert}).`
                    : 'Eine Stelle nach dem Komma. VoltPilot rechnet die Zahl in kWh im Jahr um.')}
          </p>
        </div>
      )}
      {e.art === 'nicht_gemessen' && (
        <div className="vp-mn-feld">
          <label htmlFor={`${basis}-kwh`} className="vp-mn-label-doppelt">
            Wie viel weniger Energie erwarten Sie?
          </label>
          <div className="vp-mn-prozent">
            <div className="vp-mn-prozent-feld">
              <input
                id={`${basis}-kwh`}
                inputMode="numeric"
                value={e.weissNicht ? '' : e.kwh}
                disabled={e.weissNicht}
                onChange={(x) => setze({ kwh: x.target.value })}
                aria-invalid={!!zeigen.kwh}
                aria-describedby={`${basis}-kwh-hilfe`}
                data-testid="planen-kwh"
              />
              <span>kWh im Jahr, geschätzt</span>
            </div>
            <Schnellwahl
              label="Schätzung"
              optionen={[{ wert: 'weiss_nicht', wort: P.WEISS_NICHT }]}
              wert={e.weissNicht ? 'weiss_nicht' : null}
              setze={() => setze({ weissNicht: !e.weissNicht })}
            />
          </div>
          <p id={`${basis}-kwh-hilfe`} className={zeigen.kwh ? 'vp-mn-fehler' : 'vp-mn-hilfe'}>
            {zeigen.kwh ?? 'Eine Schätzung - ohne Kennzahl misst VoltPilot nichts nach. Sie steht nie neben gemessenen Werten in einer Summe.'}
          </p>
        </div>
      )}
      <TextFeld
        id={`${basis}-wortlaut`}
        label={e.art === 'organisatorisch' ? 'Was soll sich ändern?' : 'Warum erwarten Sie das?'}
        wert={e.wortlaut}
        setze={(t) => setze({ wortlaut: t })}
        platzhalter={
          e.art === 'organisatorisch'
            ? 'Zum Beispiel: Jede Freigabe einer Bezugsbasis nennt die zuständige Person.'
            : 'Zum Beispiel: Die Pumpen laufen heute immer mit voller Drehzahl, auch wenn die Maschinen stehen.'
        }
        hilfe="Pflicht, ein bis zwei Sätze. Das steht später neben der Wirkung."
        fehler={zeigen.wortlaut}
        testid="planen-wortlaut"
      />
      {e.art === 'nicht_gemessen' && einsaetze.length > 0 && (
        <VpPicker
          id={`${basis}-einsatz`}
          label="Wo spart sie? (Energieeinsatz, wahlfrei)"
          options={[{ value: '', label: 'keiner' }, ...einsaetze.map((x) => ({ value: x.id, label: x.name || x.kennzeichen }))]}
          loading={!daten}
          value={e.einsatz}
          onChange={(v) => setze({ einsatz: v ?? '' })}
        />
      )}
      {e.art === 'gemessen' && (
        <div className="vp-mn-danach" data-testid="planen-vorher">
          <span>Vorher</span>
          <span>
            <b>{vor.kurz}</b>. {vor.lang ? `${vor.lang} ` : ''}Ab dem Monat nach der Umsetzung vergleicht VoltPilot zwölf Monate lang.{' '}
            {!andererMonat && (
              <button type="button" className="vp-mn-sprung" onClick={() => setAndererMonat(true)} data-testid="planen-anderer-monat">
                {P.ANDERER_MONAT}
              </button>
            )}
          </span>
        </div>
      )}
      {e.art === 'gemessen' && andererMonat && (
        <div className="vp-ez-periode">
          <VpPicker
            id={`${basis}-monate`}
            label="Vorher: erster Monat"
            options={P.vorherVonMonate(heute, e.von)}
            value={e.von}
            onChange={(v) => v && setze({ von: v, bis: P.bisZu(v, e.bis, heute) })}
            search="nie"
          />
          <VpPicker
            id={`${basis}-bis`}
            label="Vorher: letzter Monat"
            options={P.vorherBisMonate(heute, e.von, e.bis)}
            value={e.bis}
            onChange={(v) => setze({ bis: v ?? e.bis })}
            error={zeigen.monate ?? null}
            search="nie"
          />
        </div>
      )}
      {e.art === 'gemessen' && zieleDerKennzahl.length > 1 && !vorbelegung.energieziel && (
        <VpPicker
          id={`${basis}-energieziel`}
          label={`Für welches ${UEMS_ENERGIEZIEL}? (wahlfrei)`}
          options={[{ value: '', label: 'keines' }, ...zieleDerKennzahl.map((z) => ({ value: z.id, label: B.energiezielText(z.kennzeichen, z.wortlaut) }))]}
          value={e.energieziel}
          onChange={(v) => setze({ energieziel: v ?? '' })}
        />
      )}
    </div>
  );

  const teil3 = (
    <div className={`vp-mn-teil${schritt === 3 ? ' is-aktiv' : ''}`} data-testid="planen-teil-3">
      <h3 className="vp-mn-teil-titel">
        <span className="vp-mn-nr">3</span>
        {P.SCHRITT_FRAGE[3]}
      </h3>
      {e.titel.trim() && <p className="vp-mn-unter vp-mn-nur-telefon">{e.titel.trim()}</p>}
      {daten?.benutzer === null ? (
        <p className="vp-mn-fehler">{`Die Konten Ihres Kundenbereichs sind gerade nicht abrufbar - ohne ${UEMS_VERANTWORTLICH} lässt sich nichts anlegen.`}</p>
      ) : (
        <VpPicker
          id={`${basis}-verantwortlich`}
          label="Wer kümmert sich?"
          options={daten ? aktiveKonten(daten.benutzer!) : []}
          loading={!daten}
          value={e.verantwortlich || null}
          onChange={(v) => setze({ verantwortlich: v ?? '' })}
          hint="Aus den aktiven Konten Ihres Kundenbereichs. Die Person sieht die Maßnahme in ihrer Wiedervorlage."
          error={zeigen.verantwortlich ?? null}
        />
      )}
      <div className="vp-mn-feld">
        <span className="vp-mn-frage" id={`${basis}-termin-frage`}>
          Bis wann?
        </span>
        <Schnellwahl
          label="Bis wann?"
          optionen={[...vorschlaege, { wert: P.ANDERER_TAG, wort: P.ANDERER_TAG }]}
          wert={terminGewaehlt}
          setze={(w) => {
            if (w === P.ANDERER_TAG) {
              setAndererTag(true);
              return;
            }
            setAndererTag(false);
            setze({ termin: w });
          }}
        />
        {andererTag && (
          <VpDatePicker id={`${basis}-termin`} label="Termin" value={e.termin} onChange={(v) => setze({ termin: v })} min={heute} error={zeigen.termin ?? null} />
        )}
        <p className={zeigen.termin && !andererTag ? 'vp-mn-fehler' : 'vp-mn-hilfe'} id={andererTag ? undefined : `${basis}-termin`} tabIndex={-1}>
          {zeigen.termin && !andererTag ? zeigen.termin : e.termin ? P.terminSatz(e.termin, heute) : 'Ein Tag, an dem die Umsetzung gemeldet sein soll.'}
        </p>
      </div>
    </div>
  );

  const pruef = (
    <div className="vp-mn-pruef" data-testid="planen-zusammenfassung">
      <h3>
        <span className="vp-mn-nr">4</span>
        So wird sie angelegt
      </h3>
      <dl className="vp-mn-pz">
        {zusammen.map((z) => (
          <div key={z.titel}>
            <dt>{z.titel}</dt>
            <dd>
              {z.wert}
              {z.klein && <small>{z.klein}</small>}
            </dd>
            <button type="button" className="vp-mn-sprung vp-mn-nur-telefon" onClick={() => setSchritt(z.schritt)}>
              {P.AENDERN}
            </button>
          </div>
        ))}
      </dl>
      <p className="vp-mn-leise">{P.DANACH}</p>
      <Ablehnung satz={satz} />
      <div className="vp-mn-planer-knoepfe">
        <Button type="submit" form={`${basis}-form`} disabled={busy || !daten} fullWidth data-testid="massnahme-anlegen-senden">
          {P.KNOPF_ANLEGEN}
        </Button>
        {telefon ? (
          <Button variant="ghost" onClick={() => setSchritt(3)} fullWidth>
            {P.ZURUECK}
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose} fullWidth>
            {P.ABBRECHEN}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={telefon ? P.SCHRITT_FRAGE[schritt] : P.TITEL} blatt breit>
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-anlegen" data-schritt={schritt}>
        <div className="vp-mn-schritt" aria-live="polite">
          <div className="vp-mn-schritt-zeile">
            <span>
              Schritt <b>{schritt} von 4</b>
            </span>
            <span>{P.SCHRITT_WORT[schritt]}</span>
          </div>
          <div className="vp-mn-schritt-leiste" aria-hidden="true">
            {P.SCHRITTE.map((s) => (
              <i key={s} className={s <= schritt ? 'is-an' : undefined} />
            ))}
          </div>
        </div>
        {unter && <p className="vp-mn-unter" data-testid="massnahme-herkunft-vorbelegt">{unter}</p>}
        <div className="vp-mn-planer" data-schritt={schritt}>
          <div className="vp-mn-planer-teile">
            {teil1}
            {teil2}
            {teil3}
            <div className={`vp-mn-teil is-pruefen${schritt === 4 ? ' is-aktiv' : ''}`}>{pruef}</div>
          </div>
          <div className="vp-mn-planer-rechts">{pruef}</div>
        </div>
        {schritt < 4 && (
          <div className="vp-mn-planer-knoepfe vp-mn-nur-telefon">
            <Button onClick={weiter} fullWidth data-testid="planen-weiter">
              {P.WEITER}
            </Button>
            <Button variant="ghost" fullWidth onClick={() => (schritt === 1 ? onClose() : setSchritt((s) => (s - 1) as P.Schritt))}>
              {schritt === 1 ? P.ABBRECHEN : P.ZURUECK}
            </Button>
          </div>
        )}
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * Der Einstieg „Maßnahme planen“ - am Energieziel, am Energieeinsatz, an Feststellung, Audit und Managementbewertung;
 * IP-18 öffnet den Planer aus dem Abschluss einer Abweichung. Nur mit `verbesserung.verwalten`; danach ein Sprung zur
 * Seite.
 */
export function MassnahmeAnlegen({
  vorbelegung,
  standort,
  onAngelegt,
  variante = 'outline',
}: {
  vorbelegung: M.MassnahmeVorbelegung;
  /** Der Standort für die Rechte-Prüfung am Knopf; `null` = am Unternehmen. */
  standort?: string | null;
  onAngelegt?: (m: Massnahme) => void;
  variante?: 'outline' | 'primary';
}) {
  const [offen, setOffen] = useState(false);
  const [angelegt, setAngelegt] = useState<Massnahme | null>(null);
  return (
    <div className="vp-ez-aktionen" data-testid={`massnahme-anlegen-einstieg-${vorbelegung.herkunft}`}>
      <Recht aktion="verbesserung.verwalten" standort={standort}>
        <Button
          variant={variante}
          size="sm"
          iconLeft={<Icon name="plus" size={15} />}
          onClick={() => setOffen(true)}
          data-testid="massnahme-anlegen-knopf"
        >
          {P.TITEL}
        </Button>
      </Recht>
      {angelegt && !onAngelegt && (
        <p className="vp-ez-leise" role="status" data-testid="massnahme-angelegt">
          {`${UEMS_MASSNAHME} ${angelegt.kennzeichen} angelegt — `}
          <a href={hashForRoute(massnahmeRoute(angelegt.id))}>{`${UEMS_MASSNAHME} ${angelegt.kennzeichen} öffnen`}</a>
        </p>
      )}
      {offen && (
        <MassnahmeAnlegenDialog
          vorbelegung={vorbelegung}
          onClose={() => setOffen(false)}
          onAngelegt={(m) => {
            setOffen(false);
            setAngelegt(m);
            onAngelegt?.(m);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Umsetzung melden (§6.9)

/**
 * „Umsetzung melden“ (§6.9, M6): ein Blatt - der Tag per Schnellwahl („Heute, 30.04.“, „Gestern“, „Anderer Tag“) mit
 * der Uhr der Route, ein Satz, was gemacht wurde, und was danach passiert. Einmalig; nie vor dem Anlegen, nie in der
 * Zukunft.
 */
export function MassnahmeUmgesetztDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mu-${useId().replace(/:/g, '')}`;
  const heute = massnahme.frist.abruf;
  const gestern = (() => {
    const d = new Date(`${heute}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const [am, setAm] = useState(heute);
  const [anderer, setAnderer] = useState(false);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ am?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const angelegt = massnahme.angelegt_am;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(!M.tagNichtInZukunft(am, heute) ? { am: 'Der Tag der Umsetzung liegt nie in der Zukunft.' } : {}),
      ...(am < angelegt ? { am: `Umgesetzt wird nach dem Planen am ${Z.tag(angelegt)}.` } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: 'Ein Satz mit mindestens zehn Zeichen, was gemacht wurde.' } : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(fehler.am ? `${basis}-am` : `${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.massnahmeUmgesetzt(massnahme.id, { am, begruendung: begruendung.trim() }));
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const optionen = [
    { wert: heute, wort: `Heute, ${Z.tag(heute).slice(0, 6)}` },
    ...(gestern >= angelegt ? [{ wert: gestern, wort: 'Gestern' }] : []),
    { wert: P.ANDERER_TAG, wort: P.ANDERER_TAG },
  ];
  return (
    <Modal
      open
      blatt
      onClose={onClose}
      title={B.KNOPF_UMSETZUNG}
      footer={<Fuss form={`${basis}-form`} haupt="Als umgesetzt melden" busy={busy} onClose={onClose} testid="massnahme-umgesetzt-senden" />}
    >
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-umgesetzt">
        <p className="vp-mn-unter">{massnahme.titel}</p>
        <div className="vp-mn-feld">
          <span className="vp-mn-frage">Wann war sie fertig?</span>
          <Schnellwahl
            label="Wann war sie fertig?"
            optionen={optionen}
            wert={anderer ? P.ANDERER_TAG : am}
            setze={(w) => {
              if (w === P.ANDERER_TAG) {
                setAnderer(true);
                return;
              }
              setAnderer(false);
              setAm(w);
            }}
          />
          {anderer && <VpDatePicker id={`${basis}-am`} label="umgesetzt am" value={am} onChange={setAm} min={angelegt} max={heute} error={zeigen.am ?? null} />}
          {zeigen.am && !anderer && (
            <p className="vp-mn-fehler" id={`${basis}-am`} tabIndex={-1}>
              {zeigen.am}
            </p>
          )}
        </div>
        <TextFeld
          id={`${basis}-begruendung`}
          label="Was wurde gemacht?"
          wert={begruendung}
          setze={setBegruendung}
          hilfe="Steht später im Verlauf. Mindestens zehn Zeichen."
          fehler={zeigen.begruendung}
          testid="massnahme-umgesetzt-text"
        />
        <Danach>
          {massnahme.art === 'gemessen'
            ? `Die ${UEMS_MASSNAHME} ist dann nicht mehr änderbar. Ab dem Monat nach der Umsetzung vergleicht VoltPilot zwölf Monate lang mit der Bezugsbasis.`
            : `Die ${UEMS_MASSNAHME} ist dann nicht mehr änderbar. Ohne Kennzahl wird nichts gemessen - Sie schließen sie mit einem Satz ab, sobald klar ist, ob sie hält.`}
        </Danach>
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/** „Verwerfen“ (M6): mit Begründung - endgültig, nie gelöscht. */
export function MassnahmeVerwerfenDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mv-${useId().replace(/:/g, '')}`;
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!Z.begruendungOk(begruendung)) {
      setZeigen('Ein Satz mit mindestens zehn Zeichen, warum sie wegfällt.');
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setZeigen(null);
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.massnahmeVerwerfen(massnahme.id, { begruendung: begruendung.trim() }));
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      blatt
      onClose={onClose}
      title="Verwerfen"
      footer={<Fuss form={`${basis}-form`} haupt="Verwerfen" busy={busy} onClose={onClose} testid="massnahme-verwerfen-senden" />}
    >
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-verwerfen">
        <p className="vp-mn-unter">{massnahme.titel}</p>
        <TextFeld
          id={`${basis}-begruendung`}
          label="Warum fällt sie weg?"
          wert={begruendung}
          setze={setBegruendung}
          hilfe="Eine verworfene Maßnahme bleibt mit Verlauf lesbar und wird nie gelöscht."
          fehler={zeigen}
        />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/** Ein Kommentar im Verlauf (M7): 1–2 000 Zeichen, an geplant und umgesetzt; nichts wird geändert oder gelöscht. */
export function MassnahmeKommentarDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mk-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const t = text.trim();
    if (!t || t.length > M.KOMMENTAR_MAX) {
      setZeigen(M.ABLEHNUNG.text_ungueltig);
      document.getElementById(`${basis}-text`)?.focus();
      return;
    }
    setBusy(true);
    setZeigen(null);
    try {
      onFertig(await api.massnahmeKommentar(massnahme.id, { text: t }));
    } catch (x) {
      setZeigen(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      blatt
      onClose={onClose}
      title="Kommentar schreiben"
      footer={<Fuss form={`${basis}-form`} haupt="Kommentar speichern" busy={busy} onClose={onClose} testid="massnahme-kommentar-senden" />}
    >
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-kommentar">
        <p className="vp-mn-unter">{massnahme.titel}</p>
        <TextFeld
          id={`${basis}-text`}
          label="Was gibt es Neues?"
          wert={text}
          setze={setText}
          hilfe="Steht im Verlauf, mit Ihrem Namen und Datum. Ändert keine Zahl."
          fehler={zeigen}
          testid="massnahme-kommentar-text"
        />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * „Ändern“ (M6), solange geplant: Titel, Termin, Verantwortlich, erwartete Wirkung - mit Begründung. V7: die Richtung
 * steht als Wort („3 % weniger“ · „3 % mehr“) und bleibt beim Ändern, wie sie war. Mit Kennzahl in Prozent (die Route
 * rechnet neu in kWh um), ohne Kennzahl die Schätzung in kWh im Jahr; organisatorisch nur der Wortlaut.
 */
export function MassnahmeAendernDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mae-${useId().replace(/:/g, '')}`;
  const daten = useKataloge();
  const gemessen = massnahme.art === 'gemessen';
  const pVorher = massnahme.erwartete_wirkung_prozent;
  const betragVorher = pVorher === null ? '' : String(Math.abs(Number(pVorher))).replace('.', ',');
  const [titel, setTitel] = useState(massnahme.titel);
  const [termin, setTermin] = useState(massnahme.termin);
  const [verantwortlich, setVerantwortlich] = useState(massnahme.verantwortlich.sub);
  const [betrag, setBetrag] = useState(betragVorher);
  const [richtung, setRichtung] = useState<'weniger' | 'mehr'>(pVorher !== null && Number(pVorher) > 0 ? 'mehr' : 'weniger');
  const kwhVorher = massnahme.erwartete_einsparung && !gemessen ? massnahme.erwartete_einsparung.kwh_jahr : '';
  const [kwh, setKwh] = useState(kwhVorher);
  const [wortlaut, setWortlaut] = useState(massnahme.erwartete_wirkung_wortlaut);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ titel?: string; zahl?: string; kwh?: string; wortlaut?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const b = gemessen && betrag.trim() ? P.prozentAusEingabe(betrag) : null;
    // V7: die Zahl der Eingabe ist ein Betrag; die Richtung kommt aus dem Wort, nie aus einem Vorzeichen.
    const wert = b === null ? null : Math.abs(b) * (richtung === 'mehr' ? 1 : -1);
    const k = !gemessen && massnahme.art === 'nicht_gemessen' && String(kwh).trim() ? P.kwhAusEingabe(String(kwh)) : null;
    const fehler = {
      ...(!titel.trim() ? { titel: `Bitte geben Sie der ${UEMS_MASSNAHME} einen Titel.` } : {}),
      ...(gemessen && betrag.trim() && (b === null || b === 0) ? { zahl: 'Eine Zahl zwischen 0 und 100 mit höchstens einer Stelle nach dem Komma.' } : {}),
      ...(massnahme.art === 'nicht_gemessen' && String(kwh).trim() && k === null ? { kwh: 'Eine ganze Zahl in kWh im Jahr.' } : {}),
      ...(!M.wortlautOk(wortlaut) ? { wortlaut: 'Bitte in einem Satz.' } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: 'Ein Satz mit mindestens zehn Zeichen, warum Sie ändern.' } : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) return;
    setBusy(true);
    setSatz(null);
    try {
      const text = begruendung.trim();
      let m = massnahme;
      const aenderung = {
        ...(titel.trim() !== massnahme.titel ? { titel: titel.trim() } : {}),
        ...(termin !== massnahme.termin ? { termin } : {}),
        ...(wortlaut.trim() !== massnahme.erwartete_wirkung_wortlaut ? { erwartete_wirkung_wortlaut: wortlaut.trim() } : {}),
        ...(wert !== null && (pVorher === null || wert !== Number(pVorher)) ? { erwartete_wirkung_prozent: wert } : {}),
        ...(k !== null && String(k) !== String(kwhVorher) ? { erwartete_einsparung_kwh_jahr: k } : {}),
      };
      if (Object.keys(aenderung).length) m = await api.massnahmeAendern(massnahme.id, { ...aenderung, begruendung: text });
      if (verantwortlich !== massnahme.verantwortlich.sub) m = await api.massnahmeVerantwortlicher(massnahme.id, { benutzer: verantwortlich, begruendung: text });
      onFertig(m);
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const konten = daten?.benutzer ? aktiveKonten(daten.benutzer) : [];
  const mitBisher = konten.some((k) => k.value === massnahme.verantwortlich.sub)
    ? konten
    : [{ value: massnahme.verantwortlich.sub, label: massnahme.verantwortlich.name }, ...konten];

  return (
    <Modal
      open
      blatt
      onClose={onClose}
      title="Ändern"
      footer={<Fuss form={`${basis}-form`} haupt="Änderung speichern" busy={busy} onClose={onClose} testid="massnahme-aendern-senden" />}
    >
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-aendern">
        <Input id={`${basis}-titel`} label="Was ist zu tun?" value={titel} onChange={(x) => setTitel(x.target.value)} error={zeigen.titel ?? null} />
        <VpDatePicker id={`${basis}-termin`} label="Bis wann?" value={termin} onChange={setTermin} min={massnahme.frist.abruf} />
        <VpPicker
          id={`${basis}-verantwortlich`}
          label="Wer kümmert sich?"
          options={mitBisher}
          loading={!daten}
          value={verantwortlich}
          onChange={(v) => setVerantwortlich(v ?? massnahme.verantwortlich.sub)}
          disabled={daten?.benutzer === null}
        />
        {gemessen && (
          <div className="vp-mn-feld">
            <label htmlFor={`${basis}-zahl`}>Was soll es bringen?</label>
            <div className="vp-mn-prozent">
              <div className="vp-mn-prozent-feld">
                <input
                  id={`${basis}-zahl`}
                  inputMode="decimal"
                  value={betrag}
                  onChange={(x) => setBetrag(x.target.value)}
                  aria-invalid={!!zeigen.zahl}
                  data-testid="massnahme-aendern-zahl"
                />
                <span>{`% ${richtung} als erwartet`}</span>
              </div>
              <Schnellwahl
                label="Richtung"
                optionen={[
                  { wert: 'weniger', wort: 'weniger' },
                  { wert: 'mehr', wort: 'mehr' },
                ]}
                wert={richtung}
                setze={(w) => setRichtung(w as 'weniger' | 'mehr')}
              />
            </div>
            <p className={zeigen.zahl ? 'vp-mn-fehler' : 'vp-mn-hilfe'}>{zeigen.zahl ?? 'VoltPilot rechnet die Zahl neu in kWh im Jahr um.'}</p>
          </div>
        )}
        {massnahme.art === 'nicht_gemessen' && (
          <div className="vp-mn-feld">
            <label htmlFor={`${basis}-kwh`}>Wie viel weniger Energie erwarten Sie?</label>
            <div className="vp-mn-prozent-feld">
              <input id={`${basis}-kwh`} inputMode="numeric" value={kwh} onChange={(x) => setKwh(x.target.value)} aria-invalid={!!zeigen.kwh} />
              <span>kWh im Jahr, geschätzt</span>
            </div>
            {zeigen.kwh && <p className="vp-mn-fehler">{zeigen.kwh}</p>}
          </div>
        )}
        <TextFeld
          id={`${basis}-wortlaut`}
          label={massnahme.art === 'organisatorisch' ? 'Was soll sich ändern?' : 'Warum erwarten Sie das?'}
          wert={wortlaut}
          setze={setWortlaut}
          fehler={zeigen.wortlaut}
          zeilen={2}
        />
        <TextFeld
          id={`${basis}-begruendung`}
          label="Warum ändern Sie?"
          wert={begruendung}
          setze={setBegruendung}
          hilfe="Steht im Verlauf. Mindestens zehn Zeichen."
          fehler={zeigen.begruendung}
          zeilen={2}
        />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
