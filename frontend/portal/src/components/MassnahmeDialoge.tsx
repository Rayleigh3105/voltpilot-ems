import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Energieeinsatz, type Energieziel, type Kennzahl, type Massnahme, type StandortAmStichtag } from '../api';
import { benutzerApi, type BenutzerEintrag } from '../benutzer';
import { heute, verantwortlichOptionen } from '../bewertung';
import { basisZeile, monatsOptionen, type BezugsbasisVergleich } from '../bezugsbasisVergleich';
import * as Z from '../energieziele';
import { UEMS_AUSGANGSLAGE, UEMS_ENERGIEZIEL, UEMS_ENERGIEZIELE, UEMS_ERWARTETE_WIRKUNG, UEMS_MASSNAHME, UEMS_MESSGRUNDLAGE, UEMS_NORMGRENZE, UEMS_TERMIN, UEMS_VERANTWORTLICH } from '../glossar';
import * as M from '../massnahmen';
import { hashForRoute, massnahmeRoute } from '../nav';
import { Ablehnung, Begruendung } from './EnergiezielDialoge';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

const ABBRECHEN = 'Abbrechen';

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

/** Energieleistungskennzahlen: eine laufende Bezugsbasis mit freigegebener Fassung (M2). */
const mitBasis = (k: Kennzahl) => k.bezugsbasis?.freigabe_status === 'freigegeben';

type Vorschau = { art: 'aus' } | { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; v: BezugsbasisVergleich };

/**
 * Die Vorschau der Ausgangslage (M2): der Vergleich-Leser über die gewählten Monate — Basis-Zeile mit der Methode der
 * Fassung (M3, ein Satz, keine Wahl) und der Satz des Lesers. Gespeichert wird die Kopie erst an der Route.
 */
function AusgangslageVorschau({ vorschau, von, bis }: { vorschau: Vorschau; von: string; bis: string }) {
  if (vorschau.art === 'aus') return null;
  if (vorschau.art === 'laedt') return <p className="vp-ez-leise">{`${UEMS_AUSGANGSLAGE} wird gelesen …`}</p>;
  if (vorschau.art === 'fehler') return <p className="vp-ez-leise">{M.VORSCHAU_FEHLT}</p>;
  const { v } = vorschau;
  const satz = von === bis ? (v.monate.find((m) => m.periode === von)?.satz ?? v.zeitraum.satz) : v.zeitraum.satz;
  return (
    <div className="vp-ez-basis" data-testid="massnahme-ausgangslage-vorschau">
      {v.bezugsbasis && <p data-testid="massnahme-methode">{`${M.METHODE_HINWEIS} ${basisZeile(v)}`}</p>}
      <p>
        <strong>{`${UEMS_AUSGANGSLAGE} ${M.monateText(von, bis)}: `}</strong>
        {satz}
      </p>
    </div>
  );
}

/**
 * „Maßnahme anlegen“ (AP-18 §5.4, M1–M4, E2 = A). Öffnet vorbelegt — aus einer Abweichung (Herkunft, Kennung,
 * Kennzahl, Monate des Anlasses; IP-18), aus einem Energieziel, am Energieeinsatz — oder leer von Hand. Titel,
 * Verantwortlich aus den aktiven Konten, Termin, Messgrundlage (Kennzahl mit Vorschau der Ausgangslage ODER die
 * sichtbare Wahl „ohne Messgrundlage“ mit dem Satz aus §5.9), Standort nur ohne Messgrundlage, Einsatz und Energieziel
 * als Vorschlag, erwartete Wirkung als Wortlaut (Pflicht) und als Zahl nur mit Messgrundlage — ohne ist sie gesperrt.
 */
export function MassnahmeAnlegenDialog({
  vorbelegung,
  onClose,
  onAngelegt,
  tagHeute = heute(),
}: {
  vorbelegung: M.MassnahmeVorbelegung;
  onClose: () => void;
  onAngelegt: (m: Massnahme) => void;
  tagHeute?: string;
}) {
  const basis = `ma-${useId().replace(/:/g, '')}`;
  const daten = useKataloge();
  const [e, setE] = useState<M.MassnahmeEntwurf>(() => M.entwurfAus(vorbelegung, tagHeute));
  const [zeigen, setZeigen] = useState<M.EntwurfFehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vorschau, setVorschau] = useState<Vorschau>({ art: 'aus' });
  const setze = (teil: Partial<M.MassnahmeEntwurf>) => setE((alt) => ({ ...alt, ...teil }));
  const zahl = M.zahlErlaubt(e);

  useEffect(() => {
    if (e.wahl !== 'mit' || !e.kennzahl || e.von > e.bis) {
      setVorschau({ art: 'aus' });
      return;
    }
    let aktiv = true;
    setVorschau({ art: 'laedt' });
    api.bezugsbasisVergleich(e.kennzahl, { von: e.von, bis: e.bis }).then(
      (v) => aktiv && setVorschau({ art: 'da', v }),
      () => aktiv && setVorschau({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [e.wahl, e.kennzahl, e.von, e.bis]);

  // Vorschlag (§5.4): läuft für die gewählte Kennzahl genau ein Energieziel, steht es vorbelegt — wählbar bleibt es.
  const zieleDerKennzahl = (daten?.energieziele ?? []).filter((z) => e.wahl === 'mit' && z.kennzahl.id === e.kennzahl);
  useEffect(() => {
    if (vorbelegung.energieziel || !daten) return;
    setE((alt) => ({ ...alt, energieziel: zieleDerKennzahl.length === 1 ? zieleDerKennzahl[0].id : '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.kennzahl, e.wahl, daten]);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = M.pruefen(e);
    setZeigen(fehler);
    const erstes = Object.keys(fehler)[0];
    if (erstes) {
      document.getElementById(`${basis}-${erstes}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onAngelegt(await api.massnahmeAnlegen(M.anfrage(e, vorbelegung, e.einsatz === vorbelegung.einsatz ? vorbelegung.einstufungFassung : undefined)));
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const kennzahlen = (daten?.kennzahlen ?? []).filter((k) => mitBasis(k) || k.id === vorbelegung.kennzahl);
  const monate = monatsOptionen(M.letzterAbgeschlossenerMonat(tagHeute), 36);
  const einsaetze = (daten?.einsaetze ?? []).filter((x) => !x.beendet_am || x.id === vorbelegung.einsatz);
  const herkunft = vorbelegung.herkunft !== 'von_hand' ? `${M.HERKUNFT_WORT[vorbelegung.herkunft]}${vorbelegung.herkunftKennung ? ` ${vorbelegung.herkunftKennung}` : ''}` : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={M.KNOPF_ANLEGEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy || !daten} data-testid="massnahme-anlegen-senden">
            {M.KNOPF_ANLEGEN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-anlegen">
        {herkunft && (
          <p className="vp-ez-leise" data-testid="massnahme-herkunft-vorbelegt">
            {herkunft}
          </p>
        )}
        <Input id={`${basis}-titel`} label="Titel" value={e.titel} onChange={(x) => setze({ titel: x.target.value })} error={zeigen.titel ?? null} />
        {daten?.benutzer === null ? (
          <p className="vp-ez-fehler">{`Die Konten Ihres Kundenbereichs sind gerade nicht abrufbar — ohne ${UEMS_VERANTWORTLICH} lässt sich nichts anlegen.`}</p>
        ) : (
          <VpPicker
            id={`${basis}-verantwortlich`}
            label={UEMS_VERANTWORTLICH}
            options={daten ? aktiveKonten(daten.benutzer!) : []}
            loading={!daten}
            value={e.verantwortlich || null}
            onChange={(v) => setze({ verantwortlich: v ?? '' })}
            hint="Aus den aktiven Konten Ihres Kundenbereichs. Verantwortung verleiht kein Recht."
            error={zeigen.verantwortlich ?? null}
          />
        )}
        <VpDatePicker id={`${basis}-termin`} label={UEMS_TERMIN} value={e.termin} onChange={(v) => setze({ termin: v })} error={zeigen.termin ?? null} />

        <fieldset className="vp-ez-periode" data-testid="massnahme-messgrundlage-wahl">
          <legend>{UEMS_MESSGRUNDLAGE}</legend>
          <div className="vp-ez-wahl" role="radiogroup" aria-label={UEMS_MESSGRUNDLAGE}>
            {(['mit', 'ohne'] as const).map((w) => (
              <label key={w} className="vp-ez-wahl-punkt">
                <input
                  type="radio"
                  name={`${basis}-wahl`}
                  value={w}
                  checked={e.wahl === w}
                  onChange={() => setze(w === 'ohne' ? { wahl: w, wirkungZahl: '' } : { wahl: w })}
                  data-testid={`massnahme-wahl-${w}`}
                />
                {w === 'mit' ? M.WAHL_MIT : M.WAHL_OHNE}
              </label>
            ))}
          </div>
          {e.wahl === 'mit' ? (
            <>
              {daten && kennzahlen.length === 0 && <p className="vp-ez-leise">{M.KEINE_KENNZAHL}</p>}
              <VpPicker
                id={`${basis}-kennzahl`}
                label="Kennzahl"
                options={kennzahlen.map((k) => ({ value: k.id, label: `${k.kennzeichen} ${k.name}` }))}
                loading={!daten}
                value={e.kennzahl || null}
                onChange={(v) => setze({ kennzahl: v ?? '' })}
                hint="Nur Kennzahlen mit freigegebener Bezugsbasis. Der Standort ist der der Kennzahl."
                error={zeigen.kennzahl ?? null}
              />
              <VpPicker id={`${basis}-monate`} label={`${UEMS_AUSGANGSLAGE}: erster Monat`} options={monate} value={e.von} onChange={(v) => setze({ von: v ?? e.von })} />
              <VpPicker id={`${basis}-bis`} label={`${UEMS_AUSGANGSLAGE}: letzter Monat`} options={monate} value={e.bis} onChange={(v) => setze({ bis: v ?? e.bis })} error={zeigen.monate ?? null} />
              <AusgangslageVorschau vorschau={vorschau} von={e.von} bis={e.bis} />
            </>
          ) : (
            <>
              <p className="vp-ez-basis" data-testid="massnahme-ohne-satz">
                {M.OHNE_HINWEIS}
              </p>
              <VpPicker
                id={`${basis}-standort`}
                label="Standort"
                options={[{ value: '', label: M.UNTERNEHMEN }, ...(daten?.standorte ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                loading={!daten}
                value={e.standort}
                onChange={(v) => setze({ standort: v ?? '' })}
              />
            </>
          )}
        </fieldset>

        <VpPicker
          id={`${basis}-einsatz`}
          label="Energieeinsatz (wahlfrei)"
          options={[{ value: '', label: 'keiner' }, ...einsaetze.map((x) => ({ value: x.id, label: `${x.kennzeichen} ${x.name}` }))]}
          loading={!daten}
          value={e.einsatz}
          onChange={(v) => setze({ einsatz: v ?? '' })}
        />
        {e.wahl === 'mit' && (
          <VpPicker
            id={`${basis}-energieziel`}
            label={`${UEMS_ENERGIEZIEL} (wahlfrei)`}
            options={[
              { value: '', label: 'keines' },
              ...(daten?.energieziele ?? [])
                .filter((z) => z.kennzahl.id === e.kennzahl || z.id === vorbelegung.energieziel)
                .map((z) => ({ value: z.id, label: `${z.kennzeichen} ${z.wortlaut}` })),
            ]}
            loading={!daten}
            value={e.energieziel}
            onChange={(v) => setze({ energieziel: v ?? '' })}
            hint={`Vorschlag: die laufenden ${UEMS_ENERGIEZIELE} dieser Kennzahl.`}
          />
        )}

        <Input
          id={`${basis}-wirkungZahl`}
          label={`${UEMS_ERWARTETE_WIRKUNG} in % weniger, als die Bezugsbasis erwarten lässt (wahlfrei)`}
          inputMode="decimal"
          value={e.wirkungZahl}
          disabled={!zahl}
          onChange={(x) => setze({ wirkungZahl: x.target.value })}
          hint={zahl ? 'Eine Stelle nach dem Komma. Ein negativer Wert heißt „mehr“.' : M.ZAHL_GESPERRT}
          error={zeigen.wirkungZahl ?? null}
          data-testid="massnahme-wirkung-zahl"
        />
        <div className="vp-ez-feld">
          <label className="vp-ez-label" htmlFor={`${basis}-wirkungWortlaut`}>
            {`${UEMS_ERWARTETE_WIRKUNG} — Wortlaut`}
          </label>
          <textarea
            id={`${basis}-wirkungWortlaut`}
            rows={2}
            value={e.wirkungWortlaut}
            onChange={(x) => setze({ wirkungWortlaut: x.target.value })}
            aria-invalid={!!zeigen.wirkungWortlaut}
            placeholder="zum Beispiel: Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion."
          />
          <p className={zeigen.wirkungWortlaut ? 'vp-ez-fehler' : 'vp-ez-leise'}>{zeigen.wirkungWortlaut ?? 'Pflicht — was soll sich ändern und warum.'}</p>
        </div>
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * Der Einstieg „Maßnahme anlegen“ (§5.4) — im Register (von Hand), an der Energieziel-Seite, am Energieeinsatz; IP-18
 * öffnet den Dialog aus dem Abschluss einer Abweichung. Nur mit `verbesserung.verwalten`; danach ein Sprung zur Seite.
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
        <Button variant={variante} size="sm" onClick={() => setOffen(true)} data-testid="massnahme-anlegen-knopf">
          {M.KNOPF_ANLEGEN}
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

/** „umgesetzt melden“ (M6): der Tag nie in der Zukunft, nie vor dem Anlegen, mit Begründung — einmalig. */
export function MassnahmeUmgesetztDialog({
  massnahme,
  onClose,
  onFertig,
  tagHeute = heute(),
}: {
  massnahme: Massnahme;
  onClose: () => void;
  onFertig: (m: Massnahme) => void;
  tagHeute?: string;
}) {
  const basis = `mu-${useId().replace(/:/g, '')}`;
  const [am, setAm] = useState(tagHeute);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ am?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(!M.tagNichtInZukunft(am, tagHeute) ? { am: 'Der Tag der Umsetzung liegt nie in der Zukunft.' } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      if (fehler.begruendung) document.getElementById(`${basis}-begruendung`)?.focus();
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

  return (
    <Modal
      open
      onClose={onClose}
      title={`${massnahme.kennzeichen} ${M.KNOPF_UMGESETZT}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="massnahme-umgesetzt-senden">
            {M.KNOPF_UMGESETZT}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-umgesetzt">
        <p className="vp-ez-leise">Einmalig: danach lässt sich die {UEMS_MASSNAHME} nicht mehr ändern. Die Wirkung zählt ab dem Monat nach der Umsetzung.</p>
        <VpDatePicker id={`${basis}-am`} label="umgesetzt am" value={am} onChange={setAm} min={massnahme.angelegt_am} max={tagHeute} error={zeigen.am ?? null} />
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/** „verwerfen“ (M6): mit Begründung — endgültig, nie gelöscht. */
export function MassnahmeVerwerfenDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mv-${useId().replace(/:/g, '')}`;
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!Z.begruendungOk(begruendung)) {
      setZeigen(Z.BEGRUENDUNG_HINWEIS);
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
      onClose={onClose}
      title={`${massnahme.kennzeichen} ${M.KNOPF_VERWERFEN}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="massnahme-verwerfen-senden">
            {M.KNOPF_VERWERFEN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-verwerfen">
        <p className="vp-ez-leise">Eine verworfene {UEMS_MASSNAHME} bleibt mit Verlauf lesbar und wird nie gelöscht.</p>
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * „ändern“ (M6), solange geplant: Titel, Termin, Verantwortlich, erwartete Wirkung — mit Begründung. Die Zahl nur mit
 * Messgrundlage; die Messgrundlage selbst und ihre Ausgangslage bleiben (IP-10 baut das Ändern der Kopie nicht).
 */
export function MassnahmeAendernDialog({ massnahme, onClose, onFertig }: { massnahme: Massnahme; onClose: () => void; onFertig: (m: Massnahme) => void }) {
  const basis = `mae-${useId().replace(/:/g, '')}`;
  const daten = useKataloge();
  const zahlErlaubt = massnahme.messgrundlage !== null;
  const zahlVorher = massnahme.erwartete_wirkung_prozent === null ? '' : Z.zielwertText(massnahme.erwartete_wirkung_prozent).split(' ')[0];
  const [titel, setTitel] = useState(massnahme.titel);
  const [termin, setTermin] = useState(massnahme.termin);
  const [verantwortlich, setVerantwortlich] = useState(massnahme.verantwortlich.sub);
  const [zahl, setZahl] = useState(zahlVorher);
  const [wortlaut, setWortlaut] = useState(massnahme.erwartete_wirkung_wortlaut);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ titel?: string; zahl?: string; wortlaut?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const wert = zahlErlaubt && zahl.trim() ? M.wirkungAusEingabe(zahl) : null;
    const fehler = {
      ...(!titel.trim() ? { titel: `Bitte geben Sie der ${UEMS_MASSNAHME} einen Titel.` } : {}),
      ...(zahlErlaubt && zahl.trim() && wert === null ? { zahl: 'Eine Zahl zwischen 0 und 100 mit höchstens einer Nachkommastelle.' } : {}),
      ...(!M.wortlautOk(wortlaut) ? { wortlaut: `Bitte beschreiben Sie die ${UEMS_ERWARTETE_WIRKUNG} in einem Satz.` } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
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
        ...(wert !== null && zahl !== zahlVorher ? { erwartete_wirkung_prozent: wert } : {}),
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
      onClose={onClose}
      title={`${massnahme.kennzeichen} ${M.KNOPF_AENDERN}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="massnahme-aendern-senden">
            {M.KNOPF_AENDERN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-aendern">
        <Input id={`${basis}-titel`} label="Titel" value={titel} onChange={(x) => setTitel(x.target.value)} error={zeigen.titel ?? null} />
        <VpDatePicker id={`${basis}-termin`} label={UEMS_TERMIN} value={termin} onChange={setTermin} />
        <VpPicker
          id={`${basis}-verantwortlich`}
          label={UEMS_VERANTWORTLICH}
          options={mitBisher}
          loading={!daten}
          value={verantwortlich}
          onChange={(v) => setVerantwortlich(v ?? massnahme.verantwortlich.sub)}
          disabled={daten?.benutzer === null}
        />
        <Input
          id={`${basis}-zahl`}
          label={`${UEMS_ERWARTETE_WIRKUNG} in % weniger, als die Bezugsbasis erwarten lässt`}
          inputMode="decimal"
          value={zahl}
          disabled={!zahlErlaubt}
          onChange={(x) => setZahl(x.target.value)}
          hint={zahlErlaubt ? 'Eine Stelle nach dem Komma.' : M.ZAHL_GESPERRT}
          error={zeigen.zahl ?? null}
        />
        <div className="vp-ez-feld">
          <label className="vp-ez-label" htmlFor={`${basis}-wortlaut`}>
            {`${UEMS_ERWARTETE_WIRKUNG} — Wortlaut`}
          </label>
          <textarea id={`${basis}-wortlaut`} rows={2} value={wortlaut} onChange={(x) => setWortlaut(x.target.value)} aria-invalid={!!zeigen.wortlaut} />
          {zeigen.wortlaut && <p className="vp-ez-fehler">{zeigen.wortlaut}</p>}
        </div>
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
