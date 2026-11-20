/**
 * Schalt-Test und Freigabe EINES Stellplatzes einer Anlagensteuerung (PFC200 Stufe 4, Vertrag
 * `docs/contracts/v2/koppelbild.md` §15) - nachgeladen aus `KoppelStellplaetze.tsx`, wie der Freigabe-Assistent
 * `SchaltFreigabeDrawer` aufgebaut: erst ein begrenzter Test, den der Kunde vor Ort beobachtet, dann die Freigabe.
 *
 * Getrennt bleiben: was die Steuerung quittiert (Urteil, wirksamer Wert) und was an der Anlage geschieht. Das Zweite
 * bestätigt nur ein Mensch mit dem Haken „Ich habe die Wirkung an der Anlage gesehen“. Ob die Freigabe geht, sagt der
 * Server (`freigabe_moeglich`, `freigabe_grund`); die Wörter stehen in `koppelStellplaetze.ts`.
 */
import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError, type Koppelbild, type KoppelbildStellplatz } from '../api';
import { anlagensteuerungApi } from '../anlagensteuerungApi';
import { KOPPEL_QUITTUNG, KOPPEL_SCHALT_TEST, KOPPEL_STELLPLATZ, KOPPEL_WIRKSAM } from '../glossar';
import {
  BOX_KANN_NICHT,
  FREIGABE_FOLGEN,
  KOPPEL_TEST_S,
  RUECKNAHME_FOLGEN,
  WIRKUNG_HINWEIS,
  artName,
  bandText,
  freigabeGrundText,
  letzterTestText,
  testEingabe,
  testErgebnis,
  testWert,
  verfallenText,
  zeitpunktText,
  zielText,
  type TestErgebnisAnzeige,
} from '../koppelStellplaetze';
import { useRollen } from '../rollen';
import { ConfirmDialog } from './ConfirmDialog';
import { Recht } from './Recht';
import { VpPicker } from './VpPicker';
import './KomponenteAssistent.css';
import './KoppelStellplaetze.css';

export function KoppelStellplatzDialog({
  geraetId,
  stellplatz: sp,
  bild,
  jetzt,
  onClose,
  onChanged,
}: {
  geraetId: string;
  stellplatz: KoppelbildStellplatz;
  bild: Koppelbild;
  jetzt?: Date;
  onClose: () => void;
  /** Nach dem Test neu laden; Freigabe und Rücknahme geben das frische Koppelbild mit. */
  onChanged: (neu?: Koppelbild) => void;
}) {
  const rollen = useRollen();
  const now = jetzt ?? new Date();
  const a = sp.angebot;
  const eingabe = a ? testEingabe(a) : null;
  const feldId = `kb-testwert-${sp.platz}`;
  const fehlerId = `${feldId}-fehler`;
  const feldRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [eingabeFehler, setEingabeFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<TestErgebnisAnzeige | null>(null);
  const [bestaetigt, setBestaetigt] = useState(false);
  const [freigabeFrage, setFreigabeFrage] = useState(false);
  const [ruecknahmeFrage, setRuecknahmeFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const freigegeben = sp.freigabe.status === 'freigegeben';
  const testSperre = !bild.unterstuetzt ? BOX_KANN_NICHT : !a ? freigabeGrundText('angebot_fehlt') : null;
  const kopfZeile = a ? [artName(a.art), zielText(a.ziel, a.nr).text, bandText(a)].join(' · ') : null;
  // Der gespeicherte Beleg zählt nur, solange der Stellplatz „getestet“ ist; sonst gehört er zu einer früheren Form.
  const letzterTest = ergebnis || sp.freigabe.status !== 'getestet' ? null : letzterTestText(sp.freigabe, a, now);
  const titel = `${KOPPEL_STELLPLATZ} ${sp.platz}`;

  function fokusFeld() {
    if (eingabe?.art === 'on_off') document.querySelector<HTMLInputElement>(`input[name="${feldId}"]`)?.focus();
    else if (eingabe?.art === 'mode') document.getElementById(feldId)?.focus();
    else feldRef.current?.focus();
  }

  function aendern(neu: string) {
    setText(neu);
    setEingabeFehler(null);
  }

  async function testen() {
    if (!a) return;
    const geprueft = testWert(a, text);
    if ('fehler' in geprueft) {
      setEingabeFehler(geprueft.fehler);
      fokusFeld();
      return;
    }
    setLaeuft(true);
    setFehler(null);
    setErgebnis(null);
    setBestaetigt(false);
    try {
      const antwort = await anlagensteuerungApi.koppelTest(geraetId, sp.platz, geprueft.wert);
      setErgebnis(testErgebnis(antwort, a));
    } catch (e) {
      setErgebnis({
        angenommen: false,
        titel: e instanceof ApiError ? e.message : 'Der Schalt-Test konnte nicht gestartet werden.',
        quittung: null,
        wirksam: null,
      });
    } finally {
      setLaeuft(false);
      onChanged();
    }
  }

  async function freigeben() {
    setBusy(true);
    setFehler(null);
    try {
      const neu = await anlagensteuerungApi.koppelFreigeben(geraetId, sp.platz);
      setFreigabeFrage(false);
      onChanged(neu);
      onClose();
    } catch (e) {
      setFreigabeFrage(false);
      setFehler(e instanceof ApiError ? e.message : 'Die Freigabe ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function zuruecknehmen() {
    setBusy(true);
    setFehler(null);
    try {
      const neu = await anlagensteuerungApi.koppelFreigabeZuruecknehmen(geraetId, sp.platz);
      setRuecknahmeFrage(false);
      onChanged(neu);
      onClose();
    } catch (e) {
      setRuecknahmeFrage(false);
      setFehler(e instanceof ApiError ? e.message : 'Die Rücknahme ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  // Nach einem angenommenen Test in diesem Dialog ist „zuerst testen“ überholt, bis das Koppelbild neu geladen ist.
  const grundUeberholt =
    ergebnis?.angenommen === true && (sp.freigabe_grund === 'kein_test' || sp.freigabe_grund === 'test_nicht_angenommen');
  const freigabeGrund = grundUeberholt ? null : freigabeGrundText(sp.freigabe_grund);

  return (
    <>
      <Modal
        open
        blatt
        onClose={onClose}
        title={titel}
        icon={
          <IconTile category="primary" size={40}>
            <Icon name="zap" size={20} />
          </IconTile>
        }
      >
        <section className="vp-freigabe vp-kb-dialog">
          <Recht aktion={['schalttest.durchfuehren', 'freigabe.erteilen']}>
            {kopfZeile && <p className="vp-assist-sub">{kopfZeile}</p>}

            {freigegeben ? (
              <>
                <p>
                  Die Box darf diesem Stellplatz Wünsche schicken
                  {sp.freigabe.freigegeben_at ? ` - freigegeben ${zeitpunktText(sp.freigabe.freigegeben_at, now)}` : ''}. Die
                  Steuerung entscheidet
                  weiter selbst über jeden Wunsch.
                </p>
                {fehler && (
                  <p className="vp-assist-error" role="status">
                    {fehler}
                  </p>
                )}
                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={onClose}>
                    Schließen
                  </Button>
                  <Recht aktion="freigabe.erteilen">
                    <Button variant="outline" className="vp-btn-danger" onClick={() => setRuecknahmeFrage(true)}>
                      Freigabe zurücknehmen
                    </Button>
                  </Recht>
                </div>
              </>
            ) : (
              <>
                {sp.freigabe.status === 'verfallen' && (
                  <p className="vp-kb-warnung" role="note">
                    {verfallenText(sp.freigabe.verfallen_grund)}
                  </p>
                )}

                <h3 className="vp-assist-h">1. {KOPPEL_SCHALT_TEST}</h3>
                <p className="vp-assist-sub">
                  Die Box schreibt den Testwert {KOPPEL_TEST_S} Sekunden lang auf diesen Stellplatz. Die Steuerung
                  entscheidet selbst und quittiert ihn - schauen Sie dabei an der Anlage zu.
                </p>

                {testSperre ? (
                  <p className="vp-kb-warnung" role="note">
                    {testSperre}
                  </p>
                ) : (
                  a &&
                  eingabe && (
                    <div className="vp-assist-field">
                      {eingabe.art === 'on_off' && (
                        <fieldset className="vp-kb-wahl" aria-describedby={eingabeFehler ? fehlerId : undefined}>
                          <legend className="vp-assist-lbl">Testwert</legend>
                          {eingabe.werte.map((w) => (
                            <label key={w.wert} className={`vp-freigabe-art${text === String(w.wert) ? ' is-on' : ''}`}>
                              <input
                                type="radio"
                                name={feldId}
                                value={w.wert}
                                checked={text === String(w.wert)}
                                onChange={() => aendern(String(w.wert))}
                              />
                              <strong>{w.text}</strong>
                            </label>
                          ))}
                        </fieldset>
                      )}
                      {eingabe.art === 'mode' && (
                        <VpPicker
                          id={feldId}
                          label="Testwert"
                          options={eingabe.werte.map((w) => ({ value: String(w.wert), label: w.text }))}
                          value={text || null}
                          onChange={(v) => aendern(v)}
                          error={eingabeFehler ?? undefined}
                        />
                      )}
                      {eingabe.art === 'zahl' && (
                        <>
                          <label htmlFor={feldId}>{eingabe.label}</label>
                          <Input
                            id={feldId}
                            ref={feldRef}
                            inputMode="decimal"
                            value={text}
                            aria-invalid={eingabeFehler ? true : undefined}
                            aria-describedby={eingabeFehler ? fehlerId : undefined}
                            onChange={(e) => aendern(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void testen();
                              }
                            }}
                          />
                        </>
                      )}
                      {eingabeFehler && eingabe.art !== 'mode' && (
                        <p className="vp-assist-error" id={fehlerId} role="alert">
                          {eingabeFehler}
                        </p>
                      )}
                    </div>
                  )
                )}

                <div className="vp-freigabe-testrow">
                  <Recht aktion="schalttest.durchfuehren">
                    <Button onClick={() => void testen()} disabled={laeuft || testSperre !== null}>
                      {KOPPEL_SCHALT_TEST} starten
                    </Button>
                  </Recht>
                </div>

                {laeuft && (
                  <p className="vp-assist-help" role="status">
                    Die Box schreibt den Testwunsch und wartet auf die Quittung der Steuerung - das dauert bis zu 20
                    Sekunden …
                  </p>
                )}

                {ergebnis && (
                  <div
                    className={`vp-freigabe-test ${ergebnis.angenommen ? 'is-bestanden' : 'is-fehlgeschlagen'}`}
                    role="status"
                    data-testid="koppel-test-ergebnis"
                  >
                    <p>{ergebnis.titel}</p>
                    {(ergebnis.quittung || ergebnis.wirksam) && (
                      <dl className="vp-kb-zeilen">
                        <div>
                          <dt>{KOPPEL_QUITTUNG}</dt>
                          <dd>{ergebnis.quittung ?? 'keine'}</dd>
                        </div>
                        <div>
                          <dt>{KOPPEL_WIRKSAM}</dt>
                          <dd>{ergebnis.wirksam ?? 'nicht gemeldet'}</dd>
                        </div>
                      </dl>
                    )}
                    {ergebnis.angenommen && <p className="vp-freigabe-beleg">{WIRKUNG_HINWEIS}</p>}
                  </div>
                )}

                {letzterTest && (
                  <p className="vp-assist-help" data-testid="koppel-letzter-test">
                    Letzter {KOPPEL_SCHALT_TEST}: {letzterTest}
                  </p>
                )}

                <h3 className="vp-assist-h">2. Freigabe</h3>
                <label className="vp-freigabe-confirm">
                  <input
                    type="checkbox"
                    checked={bestaetigt}
                    disabled={!sp.freigabe_moeglich}
                    onChange={(e) => setBestaetigt(e.target.checked)}
                  />
                  <span>Ich habe die Wirkung an der Anlage gesehen.</span>
                </label>
                {freigabeGrund && !sp.freigabe_moeglich && (
                  <p className="vp-assist-help" data-testid="koppel-freigabe-grund">
                    {freigabeGrund}
                  </p>
                )}

                {fehler && (
                  <p className="vp-assist-error" role="status">
                    {fehler}
                  </p>
                )}

                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={onClose}>
                    Schließen
                  </Button>
                  <Recht aktion="freigabe.erteilen">
                    <Button
                      onClick={() => setFreigabeFrage(true)}
                      disabled={!sp.freigabe_moeglich || !bestaetigt || busy || laeuft}
                    >
                      Freigeben
                    </Button>
                  </Recht>
                </div>
              </>
            )}
          </Recht>
        </section>
      </Modal>

      <ConfirmDialog
        open={freigabeFrage && rollen.darf('freigabe.erteilen')}
        title={`${titel} freigeben?`}
        intro="Die Box schickt diesem Stellplatz danach selbst Wünsche."
        consequences={FREIGABE_FOLGEN}
        confirmLabel="Freigeben"
        busy={busy}
        onConfirm={() => void freigeben()}
        onCancel={() => setFreigabeFrage(false)}
      />

      <ConfirmDialog
        open={ruecknahmeFrage && rollen.darf('freigabe.erteilen')}
        title="Freigabe zurücknehmen?"
        intro={`Die Box schickt ${titel} danach keine Wünsche mehr.`}
        consequences={RUECKNAHME_FOLGEN}
        confirmLabel="Zurücknehmen"
        tone="danger"
        busy={busy}
        onConfirm={() => void zuruecknehmen()}
        onCancel={() => setRuecknahmeFrage(false)}
      />
    </>
  );
}
