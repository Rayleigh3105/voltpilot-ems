import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpPicker } from './VpPicker';
import { api, ApiError, type SiteComponents, type SiteComponentTemplate } from '../api';
import { prefill } from '../eigeneVorlagen';
import {
  ADDRESS_HELP,
  BILANZ_HINWEIS,
  DATA_TYPES,
  MAX_CHANNELS,
  REGISTER_KINDS,
  ROLLEN,
  UNITS,
  WORD_ORDERS,
  geraetFehler,
  istBreit,
  leseErgebnis,
  leselastHinweis,
  leseRumpf,
  messwerteFehler,
  neueVerbindung,
  neueZeile,
  pruefen,
  speicherRumpf,
  zeilenFehler,
  type LeseErgebnis,
  type MesswertZeile,
  type SelbstbauRolle,
  type VerbindungForm,
} from '../selbstbau';

/**
 * Der EIGENBAU-Weg des Anlege-Flusses (Einheitsmodell Stufe 3, Konzept
 * `vp-modbus-baukasten-k6` §2.3): der Kunde beschreibt sein eigenes
 * Modbus-Gerät und SIEHT dabei echte Werte.
 *
 * Vier Fragen - **Adresse** → **Messwerte** (je Zeile Klartext-Name, Register,
 * Skalierung, und „Jetzt lesen" mit Roh- UND skaliertem Wert) → **Was ist
 * das Gerät?** → **Prüfen & anlegen** -, die seit dem Anlegen-Rework (Stufe 2)
 * die Schritte 2-5 des EINEN Flusses SIND: der Wirt {@link AnlegenFlow}
 * zeichnet Schrittleiste, Fußzeile und den gemeinsamen „Fertig"-Schritt, dieser
 * hier bleibt der EINE Ort, an dem die Selbstbau-Fragen stehen.
 *
 * Diese Datei RENDERT nur; jede Regel - was fehlt, was das Lesen ergab, wie
 * viel Leselast entsteht, ob eine Adresse im eigenen Netz liegt - kommt aus dem
 * reinen `selbstbau.ts` und ist dort ohne DOM geprüft.
 */
export function SelbstbauAssistent({
  siteId,
  onBack,
  onSaved,
  vorlage,
  schritt,
  onSchritt,
  navPortal,
}: {
  siteId: string;
  onBack: () => void;
  onSaved: (result: SiteComponents) => void;
  /**
   * Der Schritt von AUSSEN (1..4). Er macht den Assistenten zum KOERPER des
   * Anlege-Flusses: der Wirt zeichnet die Schrittleiste und den gemeinsamen
   * „Fertig"-Schritt, dieser hier bleibt der EINE Ort, an dem die
   * Selbstbau-Fragen stehen.
   */
  schritt: 1 | 2 | 3 | 4;
  onSchritt: (schritt: 1 | 2 | 3 | 4) => void;
  /**
   * Wohin die Bedienzeile („Zurueck"/„Weiter") gerendert wird.
   *
   * ⚠ Der Assistent BEHAELT sie - er reicht sie nur woanders hin. Sie gehoert
   * ihm, weil nur er weiss, wann „Weiter" freigibt; sie im Wirt nachzubauen
   * waere ein Zwilling derselben Regel. `null` (noch nicht gemessen) laesst sie
   * wie bisher am Ende des Rumpfs stehen.
   */
  navPortal: HTMLElement | null;
  /**
   * Einheitsmodell Stufe 6: eine EIGENE Vorlage befüllt Anschluss und
   * Messwerte vor.
   *
   * ⚠ Die ADRESSE bleibt leer - eine Vorlage beschreibt einen Gerätetyp, kein
   * Exemplar; sie zu raten ließe das zweite Gerät auf das erste zeigen. Und
   * weil die Adresse fehlt, ist der Verbindungstest-Beleg per Konstruktion
   * noch nicht erbracht: der Kunde liest ohnehin zuerst.
   */
  vorlage?: SiteComponentTemplate | null;
}) {
  const start = vorlage ? prefill(vorlage) : null;
  const setSchritt = onSchritt;
  const [verbindung, setVerbindung] = useState<VerbindungForm>(
    start ? { host: '', port: start.port, unitId: start.unitId } : neueVerbindung(),
  );
  const [zeilen, setZeilen] = useState<MesswertZeile[]>(
    start && start.zeilen.length
      ? start.zeilen.map((z) => ({ ...neueZeile(), ...z }))
      : [neueZeile()],
  );
  const [ergebnisse, setErgebnisse] = useState<Record<string, LeseErgebnis>>({});
  const [laufend, setLaufend] = useState<string | null>(null);
  const [beleg, setBeleg] = useState(false);
  const [rolle, setRolle] = useState<SelbstbauRolle>('sensor');
  const [name, setName] = useState(start?.label ?? '');
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  /** Die Bedienzeile - im Wirt-Fuss, wo es einen gibt, sonst hier. */
  const Nav = ({ children }: { children: ReactNode }) =>
    navPortal ? (
      createPortal(children, navPortal)
    ) : (
      <div className="vp-assist-nav">{children}</div>
    );

  const geraetMangel = geraetFehler(verbindung);
  const listenMangel = messwerteFehler(zeilen);
  const zeilenMangel = zeilen.flatMap((z) => zeilenFehler(z));
  const last = leselastHinweis(zeilen);

  function setzeZeile(key: string, patch: Partial<MesswertZeile>) {
    setZeilen((zs) => zs.map((z) => (z.key === key ? { ...z, ...patch } : z)));
    // Eine geänderte Zeile entwertet ihr Leseergebnis - eine stehengebliebene
    // Zahl neben geänderten Angaben wäre eine Behauptung über eine Lesung, die
    // es so nie gab.
    setErgebnisse((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  async function lesen(z: MesswertZeile) {
    setLaufend(z.key);
    try {
      const antwort = await api.readCustomComponent(siteId, leseRumpf(verbindung, z));
      const ergebnis = leseErgebnis(antwort);
      setErgebnisse((e) => ({ ...e, [z.key]: ergebnis }));
      if (antwort?.receipt) setBeleg(true);
    } catch (e) {
      setErgebnisse((prev) => ({
        ...prev,
        [z.key]: {
          zustand: 'fehlgeschlagen',
          text: e instanceof ApiError ? e.message : 'Die Lesung ist fehlgeschlagen.',
        },
      }));
    } finally {
      setLaufend(null);
    }
  }

  async function anlegen() {
    setSpeichern(true);
    setFehler(null);
    try {
      const result = await api.createCustomComponent(
        siteId,
        speicherRumpf(name, verbindung, zeilen),
      );
      // Den Abschluss zeigt der WIRT - dieser Assistent ist der Koerper seiner
      // Schritte 2-5, nicht ein eigener Ablauf mit eigenem Ende.
      onSaved(result);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Speichern ist fehlgeschlagen.');
    } finally {
      setSpeichern(false);
    }
  }

  return (
    <section className="vp-selbstbau">
      {schritt === 1 && (
        <>
          <h3 className="vp-assist-h">Wo steht das Gerät?</h3>
          <p className="vp-assist-sub">
            VoltPilot liest es über Modbus TCP in Ihrem eigenen Netzwerk.
          </p>
          <div className="vp-assist-field">
            <label htmlFor="sb-host">Adresse im Netzwerk</label>
            <Input
              id="sb-host"
              value={verbindung.host}
              placeholder="192.168.1.50"
              onChange={(e) => setVerbindung((v) => ({ ...v, host: e.target.value }))}
            />
            <p className="vp-assist-help">
              Die IP-Adresse des Geräts - Sie finden sie meist im Router oder am Gerät selbst.
            </p>
          </div>
          <div className="vp-sb-pair">
            <div className="vp-assist-field">
              <label htmlFor="sb-port">Port</label>
              <Input
                id="sb-port"
                type="number"
                value={verbindung.port}
                onChange={(e) => setVerbindung((v) => ({ ...v, port: e.target.value }))}
              />
            </div>
            <div className="vp-assist-field">
              <label htmlFor="sb-unit">Unit-ID</label>
              <Input
                id="sb-unit"
                type="number"
                value={verbindung.unitId}
                onChange={(e) => setVerbindung((v) => ({ ...v, unitId: e.target.value }))}
              />
            </div>
          </div>
          {geraetMangel.length > 0 && (
            <p className="vp-assist-error" role="status">
              {geraetMangel[0]}
            </p>
          )}
          <p className="vp-assist-help">
            Im nächsten Schritt lesen Sie den ersten Messwert - damit ist die Verbindung geprüft.
          </p>
          <Nav>
            <Button variant="ghost" onClick={onBack}>
              Zurück
            </Button>
            <Button onClick={() => setSchritt(2)} disabled={geraetMangel.length > 0}>
              Weiter
            </Button>
          </Nav>
        </>
      )}

      {schritt === 2 && (
        <>
          <h3 className="vp-assist-h">Welche Messwerte liefert das Gerät?</h3>
          <p className="vp-assist-sub">
            Die Angaben stehen im Handbuch Ihres Geräts. Mit „Jetzt lesen" sehen Sie sofort, ob
            sie stimmen.
          </p>
          {zeilen.map((z, i) => {
            const mangel = zeilenFehler(z);
            const ergebnis = ergebnisse[z.key];
            return (
              <div className="vp-sb-row" key={z.key}>
                <div className="vp-sb-row-head">
                  <strong>Messwert {i + 1}</strong>
                  {zeilen.length > 1 && (
                    <button
                      type="button"
                      className="vp-sb-del"
                      aria-label={`Messwert ${i + 1} entfernen`}
                      onClick={() => setZeilen((zs) => zs.filter((x) => x.key !== z.key))}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                </div>

                <div className="vp-assist-field">
                  <label htmlFor={`sb-label-${z.key}`}>Name</label>
                  <Input
                    id={`sb-label-${z.key}`}
                    value={z.label}
                    placeholder="Wassertemperatur Speicher oben"
                    onChange={(e) => setzeZeile(z.key, { label: e.target.value })}
                  />
                </div>
                <div className="vp-sb-pair">
                  <div className="vp-assist-field">
                    <VpPicker
                      id={`sb-unit-${z.key}`}
                      label="Einheit"
                      options={UNITS.map((u) => ({
                        value: u,
                        label: u === '' ? 'ohne Einheit' : u,
                      }))}
                      value={z.unit}
                      onChange={(v) => setzeZeile(z.key, { unit: v })}
                      searchPlaceholder="Einheit suchen …"
                    />
                  </div>
                  <div className="vp-assist-field">
                    <label htmlFor={`sb-iv-${z.key}`}>Mindestabstand (s)</label>
                    <Input
                      id={`sb-iv-${z.key}`}
                      type="number"
                      value={z.minReadIntervalS}
                      onChange={(e) => setzeZeile(z.key, { minReadIntervalS: e.target.value })}
                    />
                  </div>
                </div>

                <details className="vp-sb-profi">
                  <summary>Profi-Angaben aus dem Handbuch</summary>
                  <div className="vp-sb-pair">
                    <div className="vp-assist-field">
                      <VpPicker
                        id={`sb-kind-${z.key}`}
                        label="Registerart"
                        options={REGISTER_KINDS.map((r) => ({ value: r.value, label: r.label }))}
                        value={z.registerKind}
                        onChange={(v) => setzeZeile(z.key, { registerKind: v })}
                      />
                    </div>
                    <div className="vp-assist-field">
                      <label htmlFor={`sb-addr-${z.key}`}>Adresse</label>
                      <Input
                        id={`sb-addr-${z.key}`}
                        type="number"
                        value={z.address}
                        onChange={(e) => setzeZeile(z.key, { address: e.target.value })}
                      />
                      <p className="vp-assist-help">{ADDRESS_HELP}</p>
                    </div>
                  </div>
                  <div className="vp-sb-pair">
                    <div className="vp-assist-field">
                      <VpPicker
                        id={`sb-type-${z.key}`}
                        label="Datentyp"
                        options={DATA_TYPES.map((d) => ({ value: d.value, label: d.label }))}
                        value={z.dataType}
                        onChange={(v) => setzeZeile(z.key, { dataType: v })}
                      />
                    </div>
                    {/* Die Wortreihenfolge gibt es nur bei 32 Bit - ein Feld,
                        das nichts bedeutet, ist eine Frage zu viel. */}
                    {istBreit(z.dataType) && (
                      <div className="vp-assist-field">
                        <VpPicker
                          id={`sb-order-${z.key}`}
                          label="Wortreihenfolge"
                          options={WORD_ORDERS.map((w) => ({ value: w.value, label: w.label }))}
                          value={z.wordOrder}
                          onChange={(v) => setzeZeile(z.key, { wordOrder: v })}
                        />
                      </div>
                    )}
                  </div>
                  <div className="vp-sb-pair">
                    <div className="vp-assist-field">
                      <label htmlFor={`sb-scale-${z.key}`}>Skalierung (×)</label>
                      <Input
                        id={`sb-scale-${z.key}`}
                        value={z.scale}
                        onChange={(e) => setzeZeile(z.key, { scale: e.target.value })}
                      />
                    </div>
                    <div className="vp-assist-field">
                      <label htmlFor={`sb-offset-${z.key}`}>Offset (+)</label>
                      <Input
                        id={`sb-offset-${z.key}`}
                        value={z.offset}
                        onChange={(e) => setzeZeile(z.key, { offset: e.target.value })}
                      />
                    </div>
                  </div>
                </details>

                <div className="vp-sb-read">
                  <Button
                    variant="outline"
                    onClick={() => lesen(z)}
                    disabled={mangel.length > 0 || laufend !== null}
                  >
                    {laufend === z.key ? 'Lese …' : 'Jetzt lesen'}
                  </Button>
                  {mangel.length > 0 && <p className="vp-assist-help">{mangel[0]}</p>}
                </div>

                {ergebnis && ergebnis.zustand === 'bestanden' && (
                  <div className="vp-sb-result" role="status">
                    <dl>
                      <div>
                        <dt>Roh-Wert</dt>
                        <dd>{ergebnis.roh}</dd>
                      </div>
                      <div>
                        <dt>Umgerechnet</dt>
                        <dd className="vp-sb-scaled">{ergebnis.skaliert}</dd>
                      </div>
                    </dl>
                    {ergebnis.register && (
                      <p className="vp-assist-help">Registerwörter: {ergebnis.register}</p>
                    )}
                    {/* Ein Hinweis, KEINE Sperre: ein Register, das wir für
                        unplausibel halten, kann am echten Gerät richtig sein. */}
                    {ergebnis.hinweis && <p className="vp-sb-hint">{ergebnis.hinweis}</p>}
                  </div>
                )}
                {ergebnis && ergebnis.zustand === 'fehlgeschlagen' && (
                  <p className="vp-assist-error" role="status">
                    {ergebnis.text}
                  </p>
                )}
              </div>
            );
          })}

          <div className="vp-sb-add">
            <Button
              variant="ghost"
              onClick={() => setZeilen((zs) => [...zs, neueZeile()])}
              disabled={zeilen.length >= MAX_CHANNELS}
            >
              ＋ Messwert hinzufügen
            </Button>
            {last && <p className="vp-assist-help">{last}</p>}
          </div>

          {listenMangel.length > 0 && <p className="vp-assist-error">{listenMangel[0]}</p>}
          {!beleg && (
            <p className="vp-assist-help">
              Bitte lesen Sie einen Messwert - erst danach lässt sich das Gerät speichern.
            </p>
          )}

          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(1)}>
              Zurück
            </Button>
            <Button
              onClick={() => setSchritt(3)}
              disabled={!beleg || listenMangel.length > 0 || zeilenMangel.length > 0}
            >
              Weiter
            </Button>
          </Nav>
        </>
      )}

      {schritt === 3 && (
        <>
          <h3 className="vp-assist-h">Was ist dieses Gerät?</h3>
          <div className="vp-assist-roles">
            {ROLLEN.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`vp-assist-role${rolle === r.id ? ' is-on' : ''}${
                  r.verfuegbar ? '' : ' is-soon'
                }`}
                disabled={!r.verfuegbar}
                aria-disabled={!r.verfuegbar}
                onClick={() => setRolle(r.id)}
              >
                <strong>{r.label}</strong>
                <span>{r.hint}</span>
                {!r.verfuegbar && r.bald && <em className="vp-assist-soon">{r.bald}</em>}
              </button>
            ))}
          </div>
          <p className="vp-assist-balance">{BILANZ_HINWEIS}</p>
          <div className="vp-assist-field">
            <label htmlFor="sb-name">Name</label>
            <Input
              id="sb-name"
              value={name}
              placeholder="Wärmepumpe Keller"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="vp-assist-help">So heißt die Komponente in Ihrer Anlage.</p>
          </div>
          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(2)}>
              Zurück
            </Button>
            <Button onClick={() => setSchritt(4)}>Weiter</Button>
          </Nav>
        </>
      )}

      {schritt === 4 && (
        <>
          <h3 className="vp-assist-h">Prüfen &amp; anlegen</h3>
          <dl className="vp-assist-check">
            {pruefen(name, verbindung, zeilen).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.wert}</dd>
              </div>
            ))}
          </dl>
          <p className="vp-assist-balance">{BILANZ_HINWEIS}</p>
          {last && <p className="vp-assist-help">{last}</p>}
          {fehler && <p className="vp-assist-error">{fehler}</p>}
          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(3)}>
              Zurück
            </Button>
            <Button onClick={anlegen} disabled={speichern}>
              {speichern ? 'Speichere …' : 'Komponente anlegen'}
            </Button>
          </Nav>
        </>
      )}
    </section>
  );
}
