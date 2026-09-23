import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Bericht, type Kennzahl, type StandortAmStichtag, type Unternehmen } from '../api';
import {
  ABBRECHEN,
  ANLEGEN,
  ANLEGEN_LADEFEHLER,
  ANLEGEN_TITEL,
  anlegenAnfrage,
  anlegenFehler,
  anlegenPruefen,
  ARCHIVIERTE_KENNZAHL,
  BERICHT_OEFFNEN,
  ERNEUT,
  GELTUNG_TITEL,
  geltungen,
  KEINE_GELTUNG,
  KENNZAHLEN_HINWEIS,
  KENNZAHLEN_KEINE,
  KENNZAHLEN_LADEFEHLER,
  KENNZAHLEN_TITEL,
  kennzahlenDerGeltung,
  BEWERTUNG_VORLAGE,
  LAEDT,
  VORAUSSETZUNGEN_TITEL,
  VORLAGE_TITEL,
  vorlageKarten,
  ZEITRAUM_TITEL,
  zeitraumVorgabe,
  zeitraumVorschau,
  zeitraumWahlen,
  ZONE_VORGABE,
  type AnlegenFeld,
  type BerichtRechte,
} from '../berichtDialoge';
import { VpPicker } from './VpPicker';
import './BerichtDialoge.css';

/**
 * „Bericht anlegen“ (UEMS AP-12 IP-14, §5.1, V3): Vorlage (Karten mit Abschnitten und Fassung), Geltung, Zeitraum und die
 * Kennzahlen der Geltung — alle gewählt, jede abwählbar —, darunter die Voraussetzungs-Vorschau („Der Oktober 2026 ist zu
 * Ende · endgültig ab 08.11.2026“). „Anlegen“ schickt `POST /api/v1/berichte`; die Route bildet den Entwurf sofort, und
 * die Seite öffnet ihn (`onAngelegt`).
 *
 * Wer eine Vorlage oder Geltung nicht anlegen darf, sieht sie nicht (§5.5, `vorlageKarten`/`geltungen`). Am Standort
 * (`standortId`, „Berichte dieses Standorts“) gibt es nur die Standort-Vorlagen für genau diesen Standort. Jede
 * Ablehnung spricht den Satz der Route; „Diesen Bericht gibt es schon“ bietet den Bericht an.
 *
 * ⚠ Die abgewählten Kennzahlen schreibt die Route in `bericht_kennzahl_abwahl`, BEVOR sie den ersten Entwurf bildet —
 *   ohne Abwahl bleibt der Körper, wie er vor IP-14 war.
 */
export function BerichtAnlegenDialog({
  open,
  onClose,
  rechte,
  standortId = null,
  jetzt = () => Date.now(),
  onAngelegt,
  onOeffnen,
  nurVorlage = null,
}: {
  open: boolean;
  onClose: () => void;
  rechte: BerichtRechte | null;
  /** „Berichte dieses Standorts“: nur Standort-Vorlagen, Geltung fest dieser Standort. */
  standortId?: string | null;
  jetzt?: () => number;
  onAngelegt: (bericht: Bericht) => void;
  onOeffnen: (kennung: string) => void;
  /** AP-16 IP-25: „Bewertung anlegen“ auf der Seite „Bewertung“ — nur diese Vorlage. */
  nurVorlage?: string | null;
}) {
  const basis = `vp-bd-${useId().replace(/:/g, '')}`;
  const [daten, setDaten] = useState<{ standorte: StandortAmStichtag[]; unternehmen: Unternehmen | null; kennzahlen: Kennzahl[] | null } | null>(null);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [vorlage, setVorlage] = useState<string | null>(null);
  const [geltungId, setGeltungId] = useState<string | null>(null);
  const [zeitraum, setZeitraum] = useState<string | null>(null);
  const [abgewaehlt, setAbgewaehlt] = useState<string[]>([]);
  const [versucht, setVersucht] = useState(false);
  const [fehler, setFehler] = useState<{ satz: string; kennung: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const ersteKarte = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let aktiv = true;
    setLadeFehler(false);
    Promise.allSettled([api.standorte(), api.unternehmen(), api.kennzahlen()]).then(([s, u, k]) => {
      if (!aktiv) return;
      if (s.status === 'rejected') {
        setLadeFehler(true);
        return;
      }
      setDaten({
        standorte: s.value.standorte,
        unternehmen: u.status === 'fulfilled' ? u.value : null,
        kennzahlen: k.status === 'fulfilled' ? k.value.kennzahlen : null,
      });
    });
    return () => {
      aktiv = false;
    };
  }, [open, versuch]);

  // Alles Weitere leitet sich aus der Wahl ab — eine Vorbelegung ist kein gespeicherter Zustand, sondern die Ableitung,
  // solange die Person nichts anderes gewählt hat.
  const karten = daten
    ? vorlageKarten(rechte, daten.standorte.map((s) => s.id))
        .filter((k) => standortId === null || k.geltungArt === 'standort')
        .filter((k) => nurVorlage === null || k.schluessel === nurVorlage)
    : [];
  const karte = karten.find((k) => k.schluessel === vorlage) ?? karten[0] ?? null;
  const wahlen =
    karte && daten
      ? geltungen(karte.geltungArt, daten.standorte, daten.unternehmen, rechte, karte.schluessel).filter((g) => standortId === null || g.id === standortId)
      : [];
  const geltung = wahlen.find((g) => g.id === geltungId) ?? (wahlen.length === 1 ? wahlen[0] : null);
  const zone = geltung?.zone ?? ZONE_VORGABE;
  const jetztMs = jetzt();
  const zeitraeume = karte ? zeitraumWahlen(karte.zeitraumArt, jetztMs, zone) : [];
  const zeitraumWert = karte ? (zeitraeume.some((z) => z.id === zeitraum) ? zeitraum : zeitraumVorgabe(karte.zeitraumArt, jetztMs, zone)) : null;
  const kennzahlen = karte && geltung && karte.schluessel !== BEWERTUNG_VORLAGE && daten?.kennzahlen ? kennzahlenDerGeltung(daten.kennzahlen, karte.geltungArt, geltung.id) : [];
  const vorschau = karte && zeitraumWert ? zeitraumVorschau(karte.zeitraumArt, zeitraumWert, zone, jetztMs) : null;

  const wahl = { vorlage: karte?.schluessel ?? null, geltungId: geltung?.id ?? null, zeitraum: zeitraumWert, abgewaehlt };
  const pruefung = anlegenPruefen(wahl);
  const zeigen = versucht ? pruefung : {};

  const fokus = (feld: AnlegenFeld) => {
    if (feld === 'vorlage') ersteKarte.current?.focus();
    else document.getElementById(`${basis}-${feld}`)?.focus();
  };

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !daten) return;
    setVersucht(true);
    setFehler(null);
    const erstes = (['vorlage', 'geltung', 'zeitraum'] as AnlegenFeld[]).find((f) => pruefung[f]);
    if (erstes) {
      fokus(erstes);
      return;
    }
    setBusy(true);
    try {
      onAngelegt(await api.berichtAnlegen(anlegenAnfrage(wahl, kennzahlen.map((k) => k.id))));
    } catch (err) {
      setFehler(anlegenFehler(err));
    } finally {
      setBusy(false);
    }
  }

  const fuss = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {ABBRECHEN}
      </Button>
      <Button type="submit" form={`${basis}-form`} disabled={busy || !daten || karten.length === 0}>
        {ANLEGEN}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={ANLEGEN_TITEL} footer={fuss}>
      <form id={`${basis}-form`} className="vp-bd" noValidate onSubmit={(e) => void senden(e)} data-testid="bericht-anlegen">
        {ladeFehler ? (
          <div className="vp-alert vp-alert-err vp-bd-fehler" role="alert">
            <span>{ANLEGEN_LADEFEHLER}</span>
            <Button variant="outline" size="sm" onClick={() => setVersuch((v) => v + 1)}>
              {ERNEUT}
            </Button>
          </div>
        ) : !daten ? (
          <p className="vp-bd-vorspann" aria-busy="true">
            {LAEDT}
          </p>
        ) : (
          <>
            <fieldset className="vp-bd-gruppe">
              <legend>{VORLAGE_TITEL}</legend>
              <div className="vp-bd-karten" role="radiogroup" aria-label={VORLAGE_TITEL}>
                {karten.map((k, i) => (
                  <label key={k.schluessel} className={`vp-bd-karte${karte?.schluessel === k.schluessel ? ' is-gewaehlt' : ''}`}>
                    <input
                      ref={i === 0 ? ersteKarte : undefined}
                      type="radio"
                      name={`${basis}-vorlage`}
                      value={k.schluessel}
                      checked={karte?.schluessel === k.schluessel}
                      onChange={() => setVorlage(k.schluessel)}
                    />
                    <span>
                      <b>{k.name}</b>
                      <small>{k.abschnitte}</small>
                      <em>{k.fassung}</em>
                    </span>
                  </label>
                ))}
              </div>
              {zeigen.vorlage && (
                <p className="vp-bd-feldfehler" role="alert">
                  {zeigen.vorlage}
                </p>
              )}
            </fieldset>

            {karte && wahlen.length === 0 ? (
              <p className="vp-bd-satz">{KEINE_GELTUNG}</p>
            ) : (
              karte && (
                <VpPicker
                  id={`${basis}-geltung`}
                  label={GELTUNG_TITEL}
                  options={wahlen.map((g) => ({ value: g.id, label: g.name }))}
                  value={geltung?.id ?? null}
                  onChange={setGeltungId}
                  error={zeigen.geltung}
                />
              )
            )}

            {karte && (
              <VpPicker
                id={`${basis}-zeitraum`}
                label={ZEITRAUM_TITEL}
                options={zeitraeume.map((z) => ({ value: z.id, label: z.label }))}
                value={zeitraumWert}
                onChange={setZeitraum}
                error={zeigen.zeitraum}
              />
            )}

            {/* Die energetische Bewertung (AP-16) zeigt keine Kennzahlen — es gibt nichts abzuwählen. */}
            {karte && geltung && karte.schluessel !== BEWERTUNG_VORLAGE && (
              <fieldset className="vp-bd-gruppe" data-testid="bericht-anlegen-kennzahlen">
                <legend>{KENNZAHLEN_TITEL}</legend>
                {daten.kennzahlen === null ? (
                  <p className="vp-bd-hinweis">{KENNZAHLEN_LADEFEHLER}</p>
                ) : kennzahlen.length === 0 ? (
                  <p className="vp-bd-hinweis">{KENNZAHLEN_KEINE}</p>
                ) : (
                  <>
                    <p className="vp-bd-hinweis">{KENNZAHLEN_HINWEIS}</p>
                    <ul className="vp-bd-kennzahlen">
                      {kennzahlen.map((k) => (
                        <li key={k.id}>
                          <label className="vp-bd-check">
                            <input
                              type="checkbox"
                              checked={!abgewaehlt.includes(k.id)}
                              onChange={(ev) => {
                                const an = ev.target.checked;
                                setAbgewaehlt((a) => (an ? a.filter((x) => x !== k.id) : [...a, k.id]));
                              }}
                            />
                            <span>
                              <span className="vp-bd-kz">{k.kennzeichen}</span>
                              {k.name}
                              {k.archiviert_am !== null && <small> · {ARCHIVIERTE_KENNZAHL}</small>}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </fieldset>
            )}

            {vorschau && (
              <section className={`vp-bd-vorschau${vorschau.laeuft ? ' is-laeuft' : ''}`} aria-live="polite" data-testid="bericht-anlegen-vorschau">
                <h3>{VORAUSSETZUNGEN_TITEL}</h3>
                <p>
                  <Icon name={vorschau.laeuft ? 'alert-triangle' : 'check'} size={16} />
                  <span>{vorschau.text}</span>
                </p>
              </section>
            )}

            {fehler && (
              <div className="vp-alert vp-alert-err vp-bd-fehler" role="alert">
                <span>{fehler.satz}</span>
                {fehler.kennung && (
                  <Button variant="outline" size="sm" onClick={() => onOeffnen(fehler.kennung as string)}>
                    {BERICHT_OEFFNEN}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}
