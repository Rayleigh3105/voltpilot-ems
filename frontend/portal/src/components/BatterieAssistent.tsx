import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpPicker } from './VpPicker';
import { api, ApiError, type SiteComponents } from '../api';
import {
  AGGREGATE,
  ANSCHLUSSARTEN,
  BATTERIE_HINWEIS,
  BINDUNGEN,
  BOOL_AGGREGATE,
  MAX_ZUORDNUNGEN,
  SOC_METHODEN,
  WERT_TYPEN,
  ZIEL_KANAELE,
  ausConnection,
  ausVorlage,
  bindungFehler,
  bindungsKanaele,
  brokerFehler,
  kanalGewaehlt,
  kurveFehler,
  neuerPunkt,
  neuerBroker,
  neueBindung,
  neueSoc,
  neueZuordnung,
  pruefen,
  socFehler,
  speicherRumpf,
  speicherZiele,
  vorlageWarnung,
  vorschauErgebnis,
  vorschauRumpf,
  zielKanal,
  zuordnungFehler,
  zuordnungenFehler,
  type AnschlussartId,
  type BindungForm,
  type BrokerForm,
  type SocCurveTemplate,
  type SocForm,
  type SocMethode,
  type SpeicherZiel,
  type VorschauErgebnis,
  type ZuordnungZeile,
} from '../batterieAnschluss';

/**
 * Der BATTERIE-Weg des Anlege-Flusses (P5d, Konzept
 * `vp-deye-diybms-luecke-l5` §3.2b): der Kunde bindet sein eigenes BMS an -
 * DIYBMS, Seplos, JK, ein ESP am Shunt - und SIEHT dabei echte Werte.
 *
 * Vier Fragen - **Wie ist die Batterie erreichbar?** → **Was kommt wo an?**
 * (Feld-Zuordnung mit Live-Vorschau) → **Wie entsteht der Ladestand?**
 * (Methode, Vorlage, Kurven-Editor) → **Prüfen & anlegen** -, gebaut wie der
 * Selbstbau-Assistent daneben: der Wirt {@link AnlegenFlow} zeichnet
 * Schrittleiste, Fußzeile und den gemeinsamen „Fertig"-Schritt, dieser hier
 * bleibt der EINE Ort, an dem die Batterie-Fragen stehen.
 *
 * Diese Datei RENDERT nur; jede Regel - was fehlt, was die Vorschau ergab, ob
 * eine Kennlinie steigt, was gespeichert wird - kommt aus dem reinen
 * `batterieAnschluss.ts` und ist dort ohne DOM geprüft.
 */
export function BatterieAssistent({
  siteId,
  onBack,
  onSaved,
  schritt,
  onSchritt,
  navPortal,
  bearbeiten,
}: {
  siteId: string;
  onBack: () => void;
  onSaved: (result: SiteComponents) => void;
  schritt: 1 | 2 | 3 | 4;
  onSchritt: (schritt: 1 | 2 | 3 | 4) => void;
  navPortal: HTMLElement | null;
  /**
   * Eine BESTEHENDE Batterie ändern. Die gespeicherte Form füllt das Formular
   * vor - die geprüfte und normalisierte Fassung, nicht die einst getippte:
   * das Formular mit der rohen Eingabe zu füllen hieße, etwas anderes zu
   * zeigen, als die Box wirklich liest.
   */
  bearbeiten?: {
    entityId: string;
    label: string | null;
    connection: Record<string, unknown> | null;
  } | null;
}) {
  const start = bearbeiten ? ausConnection(bearbeiten.connection) : null;
  const setSchritt = onSchritt;
  const [art, setArt] = useState<AnschlussartId>('mqtt');
  const [broker, setBroker] = useState<BrokerForm>(start?.broker ?? neuerBroker());
  const [zeilen, setZeilen] = useState<ZuordnungZeile[]>(
    start && start.zeilen.length > 0 ? start.zeilen : [neueZuordnung('soc_pct')],
  );
  const [soc, setSoc] = useState<SocForm>(start?.soc ?? neueSoc());
  const [bindung, setBindung] = useState<BindungForm>(start?.bindung ?? neueBindung());
  const [name, setName] = useState(bearbeiten?.label ?? '');
  const [ziele, setZiele] = useState<SpeicherZiel[]>([]);
  const [vorlagen, setVorlagen] = useState<SocCurveTemplate[]>([]);
  const [vorschau, setVorschau] = useState<VorschauErgebnis | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  /*
    Die Vorlagen kommen vom Server - nie aus einer Konstante im Portal. Eine
    Kennlinie hier wäre ein Zwilling des ausgelieferten Katalogs und dürfte von
    ihm abdriften; eine abgedriftete Kennlinie ist ein falscher Ladestand mit
    Nachkommastellen. Ein Fehlschlag macht nur die VORLAGEN-Auswahl leer - der
    Editor selbst bleibt bedienbar, wer eigene Punkte hat, braucht keine.
  */
  useEffect(() => {
    let lebt = true;
    api
      .socCurveTemplates()
      .then((v) => lebt && setVorlagen(v ?? []))
      .catch(() => lebt && setVorlagen([]));
    return () => {
      lebt = false;
    };
  }, []);

  /*
    P6: die Wechselrichter, an die sich diese Batterie hängen lässt. Sie kommen
    aus der Komponenten-Liste der Anlage - eine Auswahl aus einer Konstante wäre
    eine Behauptung über eine fremde Anlage. Ein Fehlschlag lässt die Liste LEER,
    und dann steht die Speiser-Wahl gesperrt da mit dem ehrlichen Grund: es gibt
    hier (noch) keinen Wechselrichter, an dem eine Batterie hängen könnte.
  */
  useEffect(() => {
    let lebt = true;
    api
      .siteComponents(siteId)
      .then((c) => lebt && setZiele(speicherZiele(c?.components, bearbeiten?.entityId ?? null)))
      .catch(() => lebt && setZiele([]));
    return () => {
      lebt = false;
    };
  }, [siteId, bearbeiten?.entityId]);

  /** Die Bedienzeile - im Wirt-Fuß, wo es einen gibt, sonst hier. */
  const Nav = ({ children }: { children: ReactNode }) =>
    navPortal ? (
      createPortal(children, navPortal)
    ) : (
      <div className="vp-assist-nav">{children}</div>
    );

  const brokerMangel = brokerFehler(broker);
  const listenMangel = zuordnungenFehler(zeilen);
  const zeilenMangel = zeilen.flatMap((z) => zuordnungFehler(z));
  const socMangel = socFehler(soc, zeilen);
  const bindungMangel = bindungFehler(bindung, zeilen, soc);
  const gewaehlteVorlage = vorlagen.find((v) => v.id === soc.template) ?? null;

  function setzeZeile(key: string, patch: Partial<ZuordnungZeile>) {
    setZeilen((zs) => zs.map((z) => (z.key === key ? { ...z, ...patch } : z)));
    // Eine geänderte Zuordnung entwertet die Vorschau: stehengebliebene Zahlen
    // neben geänderten Angaben wären eine Behauptung über einen Empfang, den
    // es so nie gab.
    setVorschau(null);
  }

  function setzeKanal(key: string, channel: string) {
    setZeilen((zs) => zs.map((z) => (z.key === key ? kanalGewaehlt(z, channel) : z)));
    setVorschau(null);
  }

  function setzePunkt(feld: 'kurveLaden' | 'kurveEntladen', key: string, patch: Partial<{ v: string; soc: string }>) {
    setSoc((s) => ({
      ...s,
      // Ein von Hand geänderter Stützpunkt ist keine Vorlage mehr - die
      // Kennung stehen zu lassen behauptete eine Herkunft, die nicht mehr gilt.
      template: '',
      [feld]: s[feld].map((p) => (p.key === key ? { ...p, ...patch } : p)),
    }));
  }

  async function vorschauen() {
    setLaeuft(true);
    try {
      const antwort = await api.previewBattery(siteId, vorschauRumpf(broker, zeilen));
      setVorschau(vorschauErgebnis(antwort, zeilen));
    } catch (e) {
      setVorschau({
        zustand: 'fehlgeschlagen',
        text: e instanceof ApiError ? e.message : 'Die Vorschau ist fehlgeschlagen.',
        zeilen: [],
      });
    } finally {
      setLaeuft(false);
    }
  }

  async function anlegen() {
    setSpeichern(true);
    setFehler(null);
    try {
      const body = speicherRumpf(name, broker, zeilen, soc, bindung);
      const result = bearbeiten
        ? await api.updateBattery(siteId, bearbeiten.entityId, body)
        : await api.createBattery(siteId, body);
      onSaved(result);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Speichern ist fehlgeschlagen.');
    } finally {
      setSpeichern(false);
    }
  }

  const vorschauZeile = (channel: string) =>
    vorschau?.zeilen.find((v) => v.channel === channel) ?? null;

  return (
    <section className="vp-batterie">
      {schritt === 1 && (
        <>
          <h3 className="vp-assist-h">Wie ist die Batterie erreichbar?</h3>
          <p className="vp-assist-sub">
            VoltPilot liest Ihr Batteriemanagement direkt - unabhängig davon, welches es ist.
          </p>
          <div className="vp-assist-roles">
            {ANSCHLUSSARTEN.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`anschlussart-${a.id}`}
                className={`vp-assist-role${art === a.id ? ' is-on' : ''}${
                  a.verfuegbar ? '' : ' is-soon'
                }`}
                disabled={!a.verfuegbar}
                aria-disabled={!a.verfuegbar}
                onClick={() => setArt(a.id)}
              >
                <strong>{a.label}</strong>
                <span>{a.hint}</span>
                {!a.verfuegbar && a.bald && <em className="vp-assist-soon">{a.bald}</em>}
              </button>
            ))}
          </div>

          <div className="vp-assist-field">
            <label htmlFor="bat-host">Adresse des Brokers</label>
            <Input
              id="bat-host"
              value={broker.host}
              placeholder="192.168.1.50"
              onChange={(e) => setBroker((b) => ({ ...b, host: e.target.value }))}
            />
            <p className="vp-assist-help">
              Die IP-Adresse des Rechners, auf dem Ihr MQTT-Broker läuft - meist Ihr
              Home-Assistant- oder Node-RED-Host.
            </p>
          </div>
          <div className="vp-sb-pair">
            <div className="vp-assist-field">
              <label htmlFor="bat-port">Port</label>
              <Input
                id="bat-port"
                type="number"
                value={broker.port}
                onChange={(e) => setBroker((b) => ({ ...b, port: e.target.value }))}
              />
            </div>
            <div className="vp-assist-field">
              <label htmlFor="bat-iv">Sende-Abstand (s)</label>
              <Input
                id="bat-iv"
                type="number"
                value={broker.publishIntervalS}
                onChange={(e) => setBroker((b) => ({ ...b, publishIntervalS: e.target.value }))}
              />
              <p className="vp-assist-help">
                So oft schickt Ihre Box die gesammelten Werte an VoltPilot.
              </p>
            </div>
          </div>
          {brokerMangel.length > 0 && (
            <p className="vp-assist-error" role="status">
              {brokerMangel[0]}
            </p>
          )}
          <Nav>
            <Button variant="ghost" onClick={onBack}>
              Zurück
            </Button>
            <Button onClick={() => setSchritt(2)} disabled={brokerMangel.length > 0}>
              Weiter
            </Button>
          </Nav>
        </>
      )}

      {schritt === 2 && (
        <>
          <h3 className="vp-assist-h">Was kommt wo an?</h3>
          <p className="vp-assist-sub">
            Ordnen Sie die Felder Ihres BMS den Standard-Messwerten zu. Mit „Werte ansehen"
            zeigt Ihre Box, was auf diesen Topics wirklich hereinkommt.
          </p>

          {zeilen.map((z, i) => {
            const mangel = zuordnungFehler(z);
            const ziel = zielKanal(z.channel);
            const probe = vorschauZeile(z.channel);
            const aggregate = AGGREGATE.filter(
              (a) => z.valueType !== 'bool' || BOOL_AGGREGATE.includes(a.value),
            );
            return (
              <div className="vp-sb-row" key={z.key}>
                <div className="vp-sb-row-head">
                  <strong>Zuordnung {i + 1}</strong>
                  {zeilen.length > 1 && (
                    <button
                      type="button"
                      className="vp-sb-del"
                      aria-label={`Zuordnung ${i + 1} entfernen`}
                      onClick={() => {
                        setZeilen((zs) => zs.filter((x) => x.key !== z.key));
                        setVorschau(null);
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                </div>

                <div className="vp-assist-field">
                  <VpPicker
                    id={`bat-ch-${z.key}`}
                    label="Welcher Messwert ist das?"
                    options={ZIEL_KANAELE.map((k) => ({
                      value: k.channel,
                      label: k.unit === '' ? k.label : `${k.label} (${k.unit})`,
                    }))}
                    value={z.channel}
                    onChange={(v) => setzeKanal(z.key, v)}
                    searchPlaceholder="Messwert suchen …"
                  />
                  {ziel && <p className="vp-assist-help">{ziel.hint}</p>}
                </div>

                <div className="vp-assist-field">
                  <label htmlFor={`bat-topic-${z.key}`}>Topic</label>
                  <Input
                    id={`bat-topic-${z.key}`}
                    value={z.topic}
                    placeholder="diybms/bank/+/cell/+"
                    onChange={(e) => setzeZeile(z.key, { topic: e.target.value })}
                  />
                  <p className="vp-assist-help">
                    „+" steht für genau eine Ebene, „#" für alles darunter (nur ganz am Ende).
                    Über viele Topics fasst die Zusammenfassung unten zusammen.
                  </p>
                </div>
                <div className="vp-sb-pair">
                  <div className="vp-assist-field">
                    <label htmlFor={`bat-path-${z.key}`}>Wert im JSON</label>
                    <Input
                      id={`bat-path-${z.key}`}
                      value={z.path}
                      placeholder="voltage"
                      onChange={(e) => setzeZeile(z.key, { path: e.target.value })}
                    />
                    <p className="vp-assist-help">
                      Leer lassen, wenn die Nachricht selbst die Zahl ist.
                    </p>
                  </div>
                  <div className="vp-assist-field">
                    <VpPicker
                      id={`bat-agg-${z.key}`}
                      label="Zusammenfassung"
                      options={aggregate.map((a) => ({ value: a.value, label: a.label }))}
                      value={z.aggregate}
                      onChange={(v) => setzeZeile(z.key, { aggregate: v })}
                    />
                  </div>
                </div>

                <details className="vp-sb-profi">
                  <summary>Weitere Angaben</summary>
                  <div className="vp-sb-pair">
                    <div className="vp-assist-field">
                      <VpPicker
                        id={`bat-type-${z.key}`}
                        label="Wert-Art"
                        options={WERT_TYPEN.map((t) => ({ value: t.value, label: t.label }))}
                        value={z.valueType}
                        onChange={(v) => setzeZeile(z.key, { valueType: v })}
                      />
                    </div>
                    <div className="vp-assist-field">
                      <label htmlFor={`bat-stale-${z.key}`}>Haltbarkeit (s)</label>
                      <Input
                        id={`bat-stale-${z.key}`}
                        type="number"
                        value={z.staleS}
                        onChange={(e) => setzeZeile(z.key, { staleS: e.target.value })}
                      />
                      <p className="vp-assist-help">
                        Danach gilt der Wert als veraltet und fehlt - er wird nie zu 0.
                      </p>
                    </div>
                  </div>
                  {z.valueType === 'number' ? (
                    <>
                      <div className="vp-sb-pair">
                        <div className="vp-assist-field">
                          <label htmlFor={`bat-scale-${z.key}`}>Umrechnung (×)</label>
                          <Input
                            id={`bat-scale-${z.key}`}
                            value={z.scale}
                            onChange={(e) => setzeZeile(z.key, { scale: e.target.value })}
                          />
                          <p className="vp-assist-help">
                            Sendet Ihr BMS Volt, die Zielgröße will aber mV? Dann 1000.
                          </p>
                        </div>
                        <div className="vp-assist-field">
                          <label htmlFor={`bat-offset-${z.key}`}>Offset (+)</label>
                          <Input
                            id={`bat-offset-${z.key}`}
                            value={z.offset}
                            onChange={(e) => setzeZeile(z.key, { offset: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="vp-assist-field">
                        <label htmlFor={`bat-sent-${z.key}`}>Wert für „nicht gemessen"</label>
                        <Input
                          id={`bat-sent-${z.key}`}
                          value={z.sentinel}
                          placeholder="z. B. -999"
                          onChange={(e) => setzeZeile(z.key, { sentinel: e.target.value })}
                        />
                        <p className="vp-assist-help">
                          Manche Geräte senden eine feste Zahl statt zu schweigen. VoltPilot
                          lässt den Messwert dann weg, statt sie zu zeigen.
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="vp-sb-pair">
                      <div className="vp-assist-field">
                        <label htmlFor={`bat-true-${z.key}`}>Wörter für „ja"</label>
                        <Input
                          id={`bat-true-${z.key}`}
                          value={z.trueValues}
                          placeholder="true, on, 1"
                          onChange={(e) => setzeZeile(z.key, { trueValues: e.target.value })}
                        />
                      </div>
                      <div className="vp-assist-field">
                        <label htmlFor={`bat-false-${z.key}`}>Wörter für „nein"</label>
                        <Input
                          id={`bat-false-${z.key}`}
                          value={z.falseValues}
                          placeholder="false, off, 0"
                          onChange={(e) => setzeZeile(z.key, { falseValues: e.target.value })}
                        />
                        <p className="vp-assist-help">
                          Ein Wort außerhalb dieser Listen wird verworfen, nie geraten.
                        </p>
                      </div>
                    </div>
                  )}
                </details>

                {mangel.length > 0 && <p className="vp-assist-error">{mangel[0]}</p>}

                {probe && probe.zustand === 'empfangen' && (
                  <div className="vp-sb-result" role="status">
                    <dl>
                      <div>
                        <dt>Roh-Wert</dt>
                        <dd>{probe.roh}</dd>
                      </div>
                      <div>
                        <dt>Umgerechnet</dt>
                        <dd className="vp-sb-scaled">{probe.wert}</dd>
                      </div>
                    </dl>
                    <p className="vp-assist-help">
                      {probe.count} {probe.count === 1 ? 'Nachricht' : 'Nachrichten'}
                      {probe.topic ? ` · zuletzt ${probe.topic}` : ''}
                    </p>
                  </div>
                )}
                {probe && probe.zustand === 'leer' && (
                  <p className="vp-bat-leer" role="status">
                    Nichts empfangen. Stimmt das Topic?
                  </p>
                )}
                {probe && probe.zustand === 'unklar' && (
                  <p className="vp-bat-leer" role="status">
                    {probe.count} Nachrichten empfangen, aber unter „{z.path || 'der Nutzlast'}"
                    stand keine Zahl.
                  </p>
                )}
              </div>
            );
          })}

          <div className="vp-sb-add">
            <Button
              variant="ghost"
              onClick={() => setZeilen((zs) => [...zs, neueZuordnung()])}
              disabled={zeilen.length >= MAX_ZUORDNUNGEN}
            >
              ＋ Zuordnung hinzufügen
            </Button>
          </div>

          <div className="vp-sb-read">
            <Button
              variant="outline"
              onClick={vorschauen}
              disabled={laeuft || zeilenMangel.length > 0 || listenMangel.length > 0}
            >
              {laeuft ? 'Höre zu …' : 'Werte ansehen'}
            </Button>
            <p className="vp-assist-help">
              Ihre Box hört einige Sekunden mit und zeigt, was ankommt. Sie ist keine
              Voraussetzung fürs Speichern.
            </p>
          </div>
          {vorschau && vorschau.zustand !== 'bestanden' && (
            <p className="vp-assist-error" role="status" data-testid="vorschau-hinweis">
              {vorschau.text}
            </p>
          )}
          {vorschau && vorschau.zustand === 'bestanden' && (
            <p className="vp-assist-help" role="status" data-testid="vorschau-hinweis">
              {vorschau.text}
            </p>
          )}
          {listenMangel.length > 0 && <p className="vp-assist-error">{listenMangel[0]}</p>}

          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(1)}>
              Zurück
            </Button>
            <Button
              onClick={() => setSchritt(3)}
              disabled={listenMangel.length > 0 || zeilenMangel.length > 0}
            >
              Weiter
            </Button>
          </Nav>
        </>
      )}

      {schritt === 3 && (
        <>
          <h3 className="vp-assist-h">Wie entsteht der Ladestand?</h3>
          <p className="vp-assist-sub">
            Ein gemessener Ladestand schlägt jede Rechnung. Was VoltPilot rechnet, wird überall
            als „berechnet" gekennzeichnet.
          </p>
          <div className="vp-assist-roles">
            {SOC_METHODEN.map((m) => (
              <button
                key={m.id}
                type="button"
                data-testid={`soc-methode-${m.id}`}
                className={`vp-assist-role${soc.methode === m.id ? ' is-on' : ''}`}
                onClick={() => setSoc((s) => ({ ...s, methode: m.id as SocMethode }))}
              >
                <strong>{m.label}</strong>
                <span>{m.hint}</span>
              </button>
            ))}
          </div>

          {soc.methode === 'ocv_curve' && (
            <>
              <div className="vp-assist-field">
                <VpPicker
                  id="bat-vorlage"
                  label="Kennlinien-Vorlage"
                  options={[
                    { value: '', label: 'Eigene Stützpunkte' },
                    ...vorlagen.map((v) => ({ value: v.id, label: v.label })),
                  ]}
                  value={soc.template}
                  onChange={(v) => {
                    const t = vorlagen.find((x) => x.id === v);
                    setSoc((s) => (t ? { ...s, ...ausVorlage(t) } : { ...s, template: '' }));
                  }}
                  searchPlaceholder="Vorlage suchen …"
                />
                {gewaehlteVorlage && (
                  <p className="vp-bat-warn" role="note">
                    {vorlageWarnung(gewaehlteVorlage)}
                  </p>
                )}
                {vorlagen.length === 0 && (
                  <p className="vp-assist-help">
                    Zu Ihrer Zelle liegt noch keine gemessene Tabelle vor - tragen Sie die
                    Stützpunkte aus dem Datenblatt ein.
                  </p>
                )}
              </div>

              {(['kurveLaden', 'kurveEntladen'] as const).map((feld) => {
                const titel = feld === 'kurveLaden' ? 'Ladekurve' : 'Entladekurve';
                const punkte = soc[feld];
                const mangel = kurveFehler(punkte, titel);
                return (
                  <div className="vp-bat-kurve" key={feld}>
                    <div className="vp-sb-row-head">
                      <strong>{titel}</strong>
                      <span className="vp-assist-help">
                        {feld === 'kurveLaden'
                          ? 'wird auf die HÖCHSTE Zelle angewandt'
                          : 'wird auf die NIEDRIGSTE Zelle angewandt'}
                      </span>
                    </div>
                    <div className="vp-bat-punkte">
                      {punkte.map((p, i) => (
                        <div className="vp-bat-punkt" key={p.key}>
                          <Input
                            aria-label={`${titel} Punkt ${i + 1} Zellspannung in Volt`}
                            value={p.v}
                            placeholder="3,26"
                            onChange={(e) => setzePunkt(feld, p.key, { v: e.target.value })}
                          />
                          <span aria-hidden="true">V →</span>
                          <Input
                            aria-label={`${titel} Punkt ${i + 1} Ladestand in Prozent`}
                            value={p.soc}
                            placeholder="0"
                            onChange={(e) => setzePunkt(feld, p.key, { soc: e.target.value })}
                          />
                          <span aria-hidden="true">%</span>
                          <button
                            type="button"
                            className="vp-sb-del"
                            aria-label={`${titel} Punkt ${i + 1} entfernen`}
                            onClick={() =>
                              setSoc((s) => ({
                                ...s,
                                template: '',
                                [feld]: s[feld].filter((x) => x.key !== p.key),
                              }))
                            }
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setSoc((s) => ({ ...s, template: '', [feld]: [...s[feld], neuerPunkt()] }))
                      }
                    >
                      ＋ Stützpunkt
                    </Button>
                    {mangel.length > 0 && <p className="vp-assist-error">{mangel[0]}</p>}
                  </div>
                );
              })}

              <div className="vp-sb-pair">
                <div className="vp-assist-field">
                  <label htmlFor="bat-cells">Zellen in Reihe</label>
                  <Input
                    id="bat-cells"
                    type="number"
                    value={soc.cellsInSeries}
                    onChange={(e) => setSoc((s) => ({ ...s, cellsInSeries: e.target.value }))}
                  />
                  <p className="vp-assist-help">
                    Nur nötig, wenn VoltPilot aus der PACKspannung rechnen soll.
                  </p>
                </div>
                <div className="vp-assist-field">
                  <label htmlFor="bat-ref">Referenztemperatur (°C)</label>
                  <Input
                    id="bat-ref"
                    value={soc.refTempC}
                    placeholder="25"
                    onChange={(e) => setSoc((s) => ({ ...s, refTempC: e.target.value }))}
                  />
                  <p className="vp-assist-help">Bei welcher Temperatur die Tabelle gemessen wurde.</p>
                </div>
              </div>

              <label className="vp-bat-check">
                <input
                  type="checkbox"
                  checked={soc.conservativeMin}
                  onChange={(e) => setSoc((s) => ({ ...s, conservativeMin: e.target.checked }))}
                />
                <span>
                  Das konservative Minimum aus beiden Kurven gewinnt - der niedrigere der beiden
                  Werte. Empfohlen: er schützt die schwächste Zelle.
                </span>
              </label>
            </>
          )}

          {soc.methode === 'coulomb' && (
            <>
              <div className="vp-sb-pair">
                <div className="vp-assist-field">
                  <label htmlFor="bat-kwh">Nutzbare Kapazität (kWh)</label>
                  <Input
                    id="bat-kwh"
                    value={soc.capacityKwh}
                    placeholder="80"
                    onChange={(e) => setSoc((s) => ({ ...s, capacityKwh: e.target.value }))}
                  />
                </div>
                <div className="vp-assist-field">
                  <label htmlFor="bat-eff">Wirkungsgrad (%)</label>
                  <Input
                    id="bat-eff"
                    value={soc.efficiencyPct}
                    placeholder="95"
                    onChange={(e) => setSoc((s) => ({ ...s, efficiencyPct: e.target.value }))}
                  />
                </div>
              </div>
              <div className="vp-sb-pair">
                <div className="vp-assist-field">
                  <label htmlFor="bat-anchor">Anker: Ladestand (%)</label>
                  <Input
                    id="bat-anchor"
                    value={soc.anchorSocPct}
                    placeholder="50"
                    onChange={(e) => setSoc((s) => ({ ...s, anchorSocPct: e.target.value }))}
                  />
                  <p className="vp-assist-help">
                    Der Startpunkt der Zählung. Ohne ihn zählt niemand - es sei denn, ein
                    gemessener Ladestand ist zugeordnet.
                  </p>
                </div>
                <div className="vp-assist-field">
                  <label htmlFor="bat-anchor-at">Anker: Zeitpunkt</label>
                  <Input
                    id="bat-anchor-at"
                    type="datetime-local"
                    value={soc.anchorAt}
                    onChange={(e) => setSoc((s) => ({ ...s, anchorAt: e.target.value }))}
                  />
                  <p className="vp-assist-help">
                    Wann dieser Ladestand galt. Leer lassen heißt „ab jetzt".
                  </p>
                </div>
              </div>
              <div className="vp-assist-field">
                <label htmlFor="bat-nenn">Nennspannung (V)</label>
                <Input
                  id="bat-nenn"
                  value={soc.nominalVoltageV}
                  placeholder="614"
                  onChange={(e) => setSoc((s) => ({ ...s, nominalVoltageV: e.target.value }))}
                />
                <p className="vp-assist-help">
                  Nur nötig, wenn VoltPilot aus dem STROM rechnen soll und keine Packspannung
                  zugeordnet ist.
                </p>
              </div>
            </>
          )}

          {soc.methode !== 'direct' && (
            <label className="vp-bat-check">
              <input
                type="checkbox"
                checked={soc.preferDirect}
                onChange={(e) => setSoc((s) => ({ ...s, preferDirect: e.target.checked }))}
              />
              <span>
                Eine FRISCHE Messung schlägt die Rechnung. Empfohlen - abschalten nur, um beides
                zu vergleichen.
              </span>
            </label>
          )}

          {socMangel.length > 0 && (
            <p className="vp-assist-error" role="status">
              {socMangel[0]}
            </p>
          )}

          {/* P6 Speiser-Bindung (Captain-Entscheid E6 (a)): die AUSDRÜCKLICHE
              Antwort auf „wozu gehört diese Batterie?". Sie steht hier, direkt
              unter dem Ladestand, weil sie genau darüber entscheidet - wessen
              Ladestand das ist. Nichts davon geschieht von selbst. */}
          <div className="vp-bat-bindung" data-testid="bindung-block">
            <h4 className="vp-assist-h4">Wozu gehört diese Batterie?</h4>
            <p className="vp-assist-sub">
              VoltPilot ordnet sie NICHT von selbst zu - nur Sie wissen, ob dieser Ladestand
              der Ihres Anlagen-Speichers ist.
            </p>
            <div className="vp-assist-roles">
              {BINDUNGEN.map((b) => {
                const gesperrt = b.id === 'feeds_inverter' && ziele.length === 0;
                return (
                  <button
                    key={b.id}
                    type="button"
                    data-testid={`bindung-${b.id}`}
                    className={`vp-assist-role${bindung.modus === b.id ? ' is-on' : ''}${
                      gesperrt ? ' is-soon' : ''
                    }`}
                    disabled={gesperrt}
                    aria-disabled={gesperrt}
                    onClick={() => setBindung((v) => ({ ...v, modus: b.id }))}
                  >
                    <strong>{b.label}</strong>
                    <span>{b.hint}</span>
                    {gesperrt && (
                      <em className="vp-assist-soon">
                        Diese Anlage hat noch keinen Speicher-Wechselrichter
                      </em>
                    )}
                  </button>
                );
              })}
            </div>

            {bindung.modus === 'feeds_inverter' && ziele.length > 0 && (
              <div className="vp-assist-field">
                <VpPicker
                  id="bat-inverter"
                  label="An welchem Wechselrichter hängt sie?"
                  value={bindung.inverterEntityId}
                  onChange={(v) => setBindung((b) => ({ ...b, inverterEntityId: v }))}
                  placeholder="Wechselrichter wählen"
                  options={ziele.map((z) => ({ value: z.id, label: z.label }))}
                />
                <p className="vp-assist-help">
                  Seine Speicher-Kachel zeigt danach den Ladestand dieser Batterie - die
                  Batterieleistung bleibt beim Wechselrichter, wo sie gemessen wird.
                </p>
              </div>
            )}

            {bindung.modus !== 'unbound' && bindungMangel.length === 0 && (
              <p className="vp-assist-help" data-testid="bindung-kanaele">
                Eingespeist werden:{' '}
                {bindungsKanaele(bindung, zeilen, soc)
                  .map((c) => zielKanal(c)?.label ?? c)
                  .join(', ')}
                .
              </p>
            )}
            {bindungMangel.length > 0 && (
              <p className="vp-assist-error" role="status">
                {bindungMangel[0]}
              </p>
            )}
          </div>

          <div className="vp-assist-field">
            <label htmlFor="bat-name">Name</label>
            <Input
              id="bat-name"
              value={name}
              placeholder="Speicher Keller"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="vp-assist-help">So heißt die Batterie in Ihrer Anlage.</p>
          </div>

          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(2)}>
              Zurück
            </Button>
            <Button
              onClick={() => setSchritt(4)}
              disabled={socMangel.length > 0 || bindungMangel.length > 0}
            >
              Weiter
            </Button>
          </Nav>
        </>
      )}

      {schritt === 4 && (
        <>
          <h3 className="vp-assist-h">Prüfen &amp; anlegen</h3>
          <dl className="vp-assist-check">
            {pruefen(name, broker, zeilen, soc, bindung, ziele).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.wert}</dd>
              </div>
            ))}
          </dl>
          <p className="vp-assist-balance">{BATTERIE_HINWEIS}</p>
          {fehler && <p className="vp-assist-error">{fehler}</p>}
          <Nav>
            <Button variant="ghost" onClick={() => setSchritt(3)}>
              Zurück
            </Button>
            <Button onClick={anlegen} disabled={speichern}>
              {speichern ? 'Speichere …' : bearbeiten ? 'Änderungen speichern' : 'Batterie anlegen'}
            </Button>
          </Nav>
        </>
      )}
    </section>
  );
}
