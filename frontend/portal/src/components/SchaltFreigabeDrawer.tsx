import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpPicker } from './VpPicker';
import { api, ApiError } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import {
  EINHEITEN,
  REGISTER_ARTEN,
  REGISTER_FCS,
  RUECKNAHME_FOLGEN,
  SCHALT_ARTEN,
  TEST_SEKUNDEN,
  TOTMANN_HINWEIS,
  effektiverFc,
  folgen,
  leistungsBeleg,
  neueSchaltForm,
  schaltFehler,
  verbraucherFehler,
  schaltRumpf,
  testErgebnis,
  testWertFehler,
  verbraucherRumpf,
  zahl,
  type SchaltArt,
  type SchaltForm,
  type TestErgebnis,
} from '../schaltFreigabe';

/**
 * Der FREIGABE-ASSISTENT (Einheitsmodell Stufe 4, Konzept
 * `vp-modbus-baukasten-k6` §2.3 Schritt 5): aus dem selbstgebauten Sensor wird
 * ein schaltbares Gerät - nach einem Test, den der Kunde selbst fährt.
 *
 * ⚠ Er ist bewusst ein EIGENER Schritt an der fertigen Komponente, nicht der
 * fünfte Schritt des Anlege-Assistenten. Vor der Freigabe ist das Gerät ein
 * Sensor, und diese Trennung IST die Aussage.
 *
 * Drei Schritte: **Schalter beschreiben** (Register, Art, Konstanten bzw.
 * Klemme + Sicherheitswert) → **Gerätedaten** (Nennleistung, Schonzeiten) →
 * **Testen & freigeben**. Der Test ist BEGRENZT: die Box armiert ihr
 * automatisches Aus, BEVOR sie schreibt, und der Knopf „Sofort ausschalten"
 * bricht jederzeit ab.
 *
 * Diese Datei RENDERT nur - jede Regel und jeder Satz kommt aus dem reinen
 * `schaltFreigabe.ts` (Server-Zwilling `SwitchDefinition.java`).
 */
export function SchaltFreigabeDrawer({
  open,
  siteId,
  entityId,
  komponentenName,
  bereitsFreigegeben,
  leistungJetztKw,
  onClose,
  onChanged,
}: {
  open: boolean;
  siteId: string;
  entityId: string;
  komponentenName: string;
  /** Ist an dieser Komponente schon eine Freigabe erteilt? */
  bereitsFreigegeben?: boolean;
  /** Die gemessene Leistung, falls ein Leistungs-Kanal gemappt ist. */
  leistungJetztKw?: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [schritt, setSchritt] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<SchaltForm>(neueSchaltForm());
  const [testWert, setTestWert] = useState('');
  const [test, setTest] = useState<TestErgebnis | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [vorher, setVorher] = useState<number | null>(null);
  const [bestaetigt, setBestaetigt] = useState(false);
  const [freigabeFrage, setFreigabeFrage] = useState(false);
  const [ruecknahmeFrage, setRuecknahmeFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  if (!open) return null;

  const mangel = schaltFehler(form);
  const geraetMangel = verbraucherFehler(form);
  const testMangel = testWertFehler(form, testWert);
  const folgenListe = folgen(form);
  const beleg = leistungsBeleg(vorher, leistungJetztKw ?? null);

  function setzeForm(patch: Partial<SchaltForm>) {
    setForm((f) => ({ ...f, ...patch }));
    // Eine geänderte Angabe entwertet ihren Test - er hat ein ANDERES Register
    // bzw. einen anderen Wert geschrieben als der, den man gleich bestätigt.
    setTest(null);
    setBestaetigt(false);
  }

  async function testen() {
    setLaeuft(true);
    setFehler(null);
    setTest(null);
    setVorher(leistungJetztKw ?? null);
    try {
      const antwort = await api.switchTest(siteId, entityId, {
        switchDef: schaltRumpf(form),
        testValue: form.art === 'setpoint' ? zahl(testWert) : null,
      });
      setTest(testErgebnis(antwort));
    } catch (e) {
      setTest({
        zustand: 'fehlgeschlagen',
        satz: e instanceof ApiError ? e.message : 'Der Test konnte nicht gestartet werden.',
      });
    } finally {
      setLaeuft(false);
    }
  }

  async function abbrechen() {
    setBusy(true);
    try {
      await api.switchTestCancel(siteId, entityId, { switchDef: schaltRumpf(form) });
      setTest({ zustand: 'unklar', satz: 'Abgebrochen - das Gerät wurde ausgeschaltet.' });
      setBestaetigt(false);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das Abschalten ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function freigeben() {
    setBusy(true);
    setFehler(null);
    try {
      await api.releaseSwitch(siteId, entityId, {
        switchDef: schaltRumpf(form),
        consumer: verbraucherRumpf(form),
        physicallyConfirmed: true,
      });
      setFreigabeFrage(false);
      onChanged();
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
      await api.revokeSwitch(siteId, entityId);
      setRuecknahmeFrage(false);
      onChanged();
      onClose();
    } catch (e) {
      setRuecknahmeFrage(false);
      setFehler(e instanceof ApiError ? e.message : 'Die Rücknahme ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const testLaeuft = test?.zustand === 'bestanden';

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={bereitsFreigegeben ? 'Steuerung dieses Geräts' : 'Steuern freigeben'}
        icon={
          <IconTile category="primary" size={40}>
            <Icon name="zap" size={20} />
          </IconTile>
        }
      >
        <section className="vp-freigabe">
          <p className="vp-assist-sub">{komponentenName}</p>

          {bereitsFreigegeben ? (
            <>
              <p>
                VoltPilot darf dieses Gerät schalten. Sie können die Freigabe jederzeit
                zurücknehmen - danach ist es wieder ein Gerät, das nur misst.
              </p>
              <p className="vp-freigabe-totmann">
                <Icon name="alert-triangle" /> {TOTMANN_HINWEIS}
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
                <Button
                  variant="outline"
                  className="vp-btn-danger"
                  onClick={() => setRuecknahmeFrage(true)}
                >
                  Freigabe zurücknehmen
                </Button>
              </div>
            </>
          ) : (
            <>
              <ol className="vp-freigabe-steps" aria-label="Schritte">
                {['Schalter', 'Gerätedaten', 'Testen & freigeben'].map((s, i) => (
                  <li key={s} className={schritt === i + 1 ? 'is-now' : undefined}>
                    {s}
                  </li>
                ))}
              </ol>

              {schritt === 1 && (
                <>
                  <h3 className="vp-assist-h">Wie wird geschaltet?</h3>
                  <p className="vp-assist-sub">
                    VoltPilot schreibt genau EIN Register - das legen Sie hier fest.
                  </p>

                  <div className="vp-assist-field">
                    <span className="vp-assist-lbl">Schalt-Art</span>
                    <div className="vp-freigabe-arten">
                      {SCHALT_ARTEN.map((a) => (
                        <label
                          key={a.id}
                          className={`vp-freigabe-art${form.art === a.id ? ' is-on' : ''}`}
                        >
                          <input
                            type="radio"
                            name="schaltart"
                            value={a.id}
                            checked={form.art === a.id}
                            onChange={() =>
                              setzeForm({
                                art: a.id as SchaltArt,
                                registerArt: a.id === 'setpoint' ? 'holding' : form.registerArt,
                              })
                            }
                          />
                          <strong>{a.label}</strong>
                          <span>{a.hint}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="vp-sb-pair">
                    <VpPicker
                      id="fg-kind"
                      className="vp-assist-field"
                      label="Registerart"
                      options={REGISTER_ARTEN.map((r) => ({ value: r.id, label: r.label }))}
                      value={form.registerArt}
                      onChange={(v) => setzeForm({ registerArt: v })}
                    />
                    <div className="vp-assist-field">
                      <label htmlFor="fg-addr">Adresse</label>
                      <Input
                        id="fg-addr"
                        type="number"
                        value={form.adresse}
                        onChange={(e) => setzeForm({ adresse: e.target.value })}
                      />
                    </div>
                  </div>

                  {form.registerArt !== 'coil' && (
                    <div className="vp-assist-field">
                      <VpPicker
                        id="fg-fc"
                        label="Schreibbefehl"
                        options={REGISTER_FCS.map((f) => ({
                          value: String(f.id),
                          label: f.label,
                        }))}
                        value={form.fc}
                        onChange={(v) => setzeForm({ fc: v })}
                      />
                      <p className="vp-assist-help">
                        {REGISTER_FCS.find((f) => f.id === effektiverFc(form))?.hint}
                      </p>
                    </div>
                  )}

                  {form.art === 'on_off' ? (
                    <div className="vp-sb-pair">
                      <div className="vp-assist-field">
                        <label htmlFor="fg-on">Wert für „ein"</label>
                        <Input
                          id="fg-on"
                          type="number"
                          value={form.einWert}
                          onChange={(e) => setzeForm({ einWert: e.target.value })}
                        />
                      </div>
                      <div className="vp-assist-field">
                        <label htmlFor="fg-off">Wert für „aus"</label>
                        <Input
                          id="fg-off"
                          type="number"
                          value={form.ausWert}
                          onChange={(e) => setzeForm({ ausWert: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="vp-sb-pair">
                        <div className="vp-assist-field">
                          <label htmlFor="fg-min">Kleinster Sollwert</label>
                          <Input
                            id="fg-min"
                            value={form.minWert}
                            onChange={(e) => setzeForm({ minWert: e.target.value })}
                          />
                        </div>
                        <div className="vp-assist-field">
                          <label htmlFor="fg-max">Größter Sollwert</label>
                          <Input
                            id="fg-max"
                            value={form.maxWert}
                            onChange={(e) => setzeForm({ maxWert: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="vp-sb-pair">
                        <div className="vp-assist-field">
                          <label htmlFor="fg-safe">Sicherheitswert</label>
                          <Input
                            id="fg-safe"
                            value={form.sicherWert}
                            onChange={(e) => setzeForm({ sicherWert: e.target.value })}
                          />
                          <p className="vp-assist-help">
                            Wird geschrieben, wenn die Steuerung endet oder die Verbindung
                            abbricht.
                          </p>
                        </div>
                        <VpPicker
                          id="fg-unit"
                          className="vp-assist-field"
                          label="Einheit"
                          options={EINHEITEN.map((u) => ({ value: u, label: u }))}
                          value={form.einheit}
                          onChange={(v) => setzeForm({ einheit: v })}
                        />
                      </div>
                      <div className="vp-assist-field">
                        <label htmlFor="fg-scale">Skalierung</label>
                        <Input
                          id="fg-scale"
                          value={form.skalierung}
                          onChange={(e) => setzeForm({ skalierung: e.target.value })}
                        />
                        <p className="vp-assist-help">
                          Faktor zwischen dem Wert im Register und der Einheit oben.
                        </p>
                      </div>
                    </>
                  )}

                  <details className="vp-sb-profi">
                    <summary>Optionale Register</summary>
                    <div className="vp-sb-pair">
                      <div className="vp-assist-field">
                        <label htmlFor="fg-rb">Rücklese-Register</label>
                        <Input
                          id="fg-rb"
                          type="number"
                          value={form.rueckleseAdresse}
                          onChange={(e) => setzeForm({ rueckleseAdresse: e.target.value })}
                        />
                        <p className="vp-assist-help">
                          Wenn das Gerät den geschriebenen Wert zurückmeldet, prüft VoltPilot ihn.
                        </p>
                      </div>
                      <div className="vp-assist-field">
                        <label htmlFor="fg-wd">Watchdog-Register des Geräts</label>
                        <Input
                          id="fg-wd"
                          type="number"
                          value={form.watchdogAdresse}
                          onChange={(e) => setzeForm({ watchdogAdresse: e.target.value })}
                        />
                        <p className="vp-assist-help">
                          Nur ausfüllen, wenn Ihr Gerät eines anbietet - VoltPilot bedient es dann
                          im Takt.
                        </p>
                      </div>
                      {/* Der Wert gehört zur Adresse: ein Watchdog-Register, in
                          das immer 0 geschrieben wird, ist bei den meisten
                          Geräten kein Lebenszeichen. Leer = 0, wie bisher. */}
                      {form.watchdogAdresse.trim() !== '' && (
                        <div className="vp-assist-field">
                          <label htmlFor="fg-wdv">Watchdog-Wert</label>
                          <Input
                            id="fg-wdv"
                            type="number"
                            value={form.watchdogWert}
                            onChange={(e) => setzeForm({ watchdogWert: e.target.value })}
                          />
                          <p className="vp-assist-help">
                            Der Wert, den VoltPilot in dieses Register schreibt. Leer = 0.
                          </p>
                        </div>
                      )}
                    </div>
                  </details>

                  {mangel.length > 0 && (
                    <p className="vp-assist-error" role="status">
                      {mangel[0]}
                    </p>
                  )}
                  <div className="vp-assist-nav">
                    <Button variant="ghost" onClick={onClose}>
                      Abbrechen
                    </Button>
                    <Button onClick={() => setSchritt(2)} disabled={mangel.length > 0}>
                      Weiter
                    </Button>
                  </div>
                </>
              )}

              {schritt === 2 && (
                <>
                  <h3 className="vp-assist-h">Was ist das für ein Verbraucher?</h3>
                  <p className="vp-assist-sub">
                    Aus diesen Angaben entstehen die Grenzen, die VoltPilot vor jedem Schalten
                    einhält.
                  </p>
                  <div className="vp-assist-field">
                    <label htmlFor="fg-rated">Nennleistung (kW)</label>
                    <Input
                      id="fg-rated"
                      value={form.nennleistung}
                      onChange={(e) => setzeForm({ nennleistung: e.target.value })}
                    />
                    <p className="vp-assist-help">
                      Die Leistung, die das Gerät höchstens zieht - VoltPilot geht nie darüber.
                    </p>
                  </div>
                  <div className="vp-sb-pair">
                    <div className="vp-assist-field">
                      <label htmlFor="fg-minon">Mindestlaufzeit (s)</label>
                      <Input
                        id="fg-minon"
                        type="number"
                        value={form.mindestlaufzeit}
                        onChange={(e) => setzeForm({ mindestlaufzeit: e.target.value })}
                      />
                    </div>
                    <div className="vp-assist-field">
                      <label htmlFor="fg-minoff">Mindestpause (s)</label>
                      <Input
                        id="fg-minoff"
                        type="number"
                        value={form.mindestpause}
                        onChange={(e) => setzeForm({ mindestpause: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="vp-assist-field">
                    <label htmlFor="fg-starts">Starts pro Tag (höchstens)</label>
                    <Input
                      id="fg-starts"
                      type="number"
                      value={form.maxStarts}
                      onChange={(e) => setzeForm({ maxStarts: e.target.value })}
                    />
                    <p className="vp-assist-help">
                      Leer lassen, wenn es keine Grenze gibt - dann wird auch keine behauptet.
                    </p>
                  </div>
                  {geraetMangel.length > 0 && (
                    <p className="vp-assist-error" role="status">
                      {geraetMangel[0]}
                    </p>
                  )}
                  <div className="vp-assist-nav">
                    <Button variant="ghost" onClick={() => setSchritt(1)}>
                      Zurück
                    </Button>
                    <Button onClick={() => setSchritt(3)} disabled={geraetMangel.length > 0}>
                      Weiter
                    </Button>
                  </div>
                </>
              )}

              {schritt === 3 && (
                <>
                  <h3 className="vp-assist-h">Testen &amp; freigeben</h3>
                  <p className="vp-assist-sub">
                    Zuerst schaltet VoltPilot das Gerät einmal begrenzt - Sie schauen dabei zu.
                  </p>

                  <ul className="vp-freigabe-folgen" data-testid="freigabe-folgen">
                    {folgenListe.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>

                  {form.art === 'setpoint' && (
                    <div className="vp-assist-field">
                      <label htmlFor="fg-testwert">
                        Testwert ({form.minWert}–{form.maxWert} {form.einheit})
                      </label>
                      <Input
                        id="fg-testwert"
                        value={testWert}
                        onChange={(e) => {
                          setTestWert(e.target.value);
                          setTest(null);
                          setBestaetigt(false);
                        }}
                      />
                      {testMangel && (
                        <p className="vp-assist-error" role="status">
                          {testMangel}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="vp-freigabe-testrow">
                    <Button onClick={testen} disabled={laeuft || busy || testMangel !== null}>
                      {form.art === 'on_off'
                        ? `Jetzt für ${TEST_SEKUNDEN} Sekunden einschalten`
                        : `Testwert für ${TEST_SEKUNDEN} Sekunden schreiben`}
                    </Button>
                    {testLaeuft && (
                      <Button variant="outline" onClick={abbrechen} disabled={busy}>
                        Sofort ausschalten
                      </Button>
                    )}
                  </div>

                  {laeuft && <p className="vp-assist-help">Der Test läuft …</p>}

                  {test && (
                    <div className={`vp-freigabe-test is-${test.zustand}`} role="status">
                      <p>{test.satz}</p>
                      {test.zustand === 'bestanden' && test.belege.length > 0 && (
                        <ul>
                          {test.belege.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      )}
                      {test.zustand === 'bestanden' && beleg && (
                        <p className="vp-freigabe-beleg">{beleg}</p>
                      )}
                    </div>
                  )}

                  {testLaeuft && (
                    <label className="vp-freigabe-confirm">
                      <input
                        type="checkbox"
                        checked={bestaetigt}
                        onChange={(e) => setBestaetigt(e.target.checked)}
                      />
                      <span>Ich habe gesehen, dass das richtige Gerät geschaltet hat.</span>
                    </label>
                  )}

                  {fehler && (
                    <p className="vp-assist-error" role="status">
                      {fehler}
                    </p>
                  )}

                  <div className="vp-assist-nav">
                    <Button variant="ghost" onClick={() => setSchritt(2)}>
                      Zurück
                    </Button>
                    <Button
                      onClick={() => setFreigabeFrage(true)}
                      disabled={
                        !testLaeuft || !bestaetigt || busy
                        || mangel.length > 0 || geraetMangel.length > 0
                      }
                    >
                      Steuern freigeben
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </Modal>

      <ConfirmDialog
        open={freigabeFrage}
        title="Steuern freigeben?"
        intro={`VoltPilot darf „${komponentenName}" danach selbst schalten.`}
        consequences={folgenListe}
        confirmLabel="Freigeben"
        busy={busy}
        onConfirm={freigeben}
        onCancel={() => setFreigabeFrage(false)}
      />

      <ConfirmDialog
        open={ruecknahmeFrage}
        title="Freigabe zurücknehmen?"
        intro={`VoltPilot schaltet „${komponentenName}" danach nicht mehr.`}
        consequences={RUECKNAHME_FOLGEN}
        confirmLabel="Zurücknehmen"
        tone="danger"
        busy={busy}
        onConfirm={zuruecknehmen}
        onCancel={() => setRuecknahmeFrage(false)}
      />
    </>
  );
}
