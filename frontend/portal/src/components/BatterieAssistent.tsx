import { Recht } from './Recht';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import { api, ApiError, type SiteComponents } from '../api';
import {
  AGGREGATE,
  ANMELDE_ARTEN,
  ANSCHLUSSARTEN,
  BATTERIE_HINWEIS,
  BINDUNGEN,
  BOOL_AGGREGATE,
  GEHEIMNIS_MASKE,
  HTTP_VORLAGEN,
  MAX_ZUORDNUNGEN,
  SOC_METHODEN,
  WERT_TYPEN,
  ZIEL_KANAELE,
  anmeldungFehler,
  ausConnection,
  ausVorlage,
  bindungFehler,
  bindungsKanaele,
  brokerFehler,
  endpunktFehler,
  kanalGewaehlt,
  kurveFehler,
  neuerPunkt,
  neuerBroker,
  neuerEndpunkt,
  neueAnmeldung,
  neueBindung,
  neueSoc,
  neueZuordnung,
  pruefen,
  socFehler,
  speicherRumpf,
  speicherZiele,
  vorlageAnwenden,
  vorlageWarnung,
  vorschauErgebnis,
  vorschauRumpf,
  zielKanal,
  zuordnungFehler,
  zuordnungenFehler,
  type AnmeldungForm,
  type AnschlussartId,
  type BindungForm,
  type BrokerForm,
  type EndpunktForm,
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
  const [art, setArt] = useState<AnschlussartId>(start?.art ?? 'mqtt');
  const [broker, setBroker] = useState<BrokerForm>(start?.broker ?? neuerBroker());
  const [endpunkt, setEndpunkt] = useState<EndpunktForm>(start?.endpunkt ?? neuerEndpunkt());
  const [anmeldung, setAnmeldung] = useState<AnmeldungForm>(start?.anmeldung ?? neueAnmeldung());
  /*
    ⚠ Ob ein Geheimnis GESPEICHERT ist, weiß das Formular - den WERT sieht es
    nie. Der Server gibt an seiner Stelle die Maske zurück, und ein leeres Feld
    heißt beim Bearbeiten „unverändert". Ein Zwang, den Schlüssel neu zu tippen,
    wäre nur eine Einladung, ihn falsch zu tippen.
  */
  const geheimnisBesteht = start?.geheimnisBesteht ?? false;
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
    Der Anker-Zeitpunkt reist als EIN Feld (`JJJJ-MM-TTTHH:MM`, byte-gleich mit
    dem abgelösten nativen Feld), bedient wird er - wie überall im Portal - aus
    den beiden Haus-Pickern. Leer heißt „ab jetzt": erst ein DATUM macht den
    Anker zu einem Zeitpunkt, eine Uhrzeit allein ist keiner.
  */
  const setAnkerTeil = (teil: 'datum' | 'zeit', wert: string) => {
    setSoc((s) => {
      const [datum = '', zeit = ''] = s.anchorAt.split('T');
      const d = teil === 'datum' ? wert : datum;
      const z = teil === 'zeit' ? wert : zeit;
      return { ...s, anchorAt: d === '' ? '' : `${d}T${z === '' ? '00:00' : z}` };
    });
  };

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

  const http = art === 'http';
  const brokerMangel = http
    ? [...endpunktFehler(endpunkt), ...anmeldungFehler(anmeldung, geheimnisBesteht)]
    : brokerFehler(broker);
  const listenMangel = zuordnungenFehler(zeilen);
  const zeilenMangel = zeilen.flatMap((z) => zuordnungFehler(z, art));
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
      const antwort = await api.previewBattery(
        siteId,
        vorschauRumpf(broker, zeilen, art, endpunkt, anmeldung),
        bearbeiten?.entityId ?? null,
      );
      setVorschau(vorschauErgebnis(antwort, zeilen, art));
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
      const body = speicherRumpf(name, broker, zeilen, soc, bindung, art, endpunkt, anmeldung);
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
                onClick={() => {
                  // Eine gewechselte Anschlussart entwertet die Vorschau: die
                  // Zahlen kämen sonst aus einer Quelle, die nicht mehr gilt.
                  setArt(a.id);
                  setVorschau(null);
                }}
              >
                <strong>{a.label}</strong>
                <span>{a.hint}</span>
                {!a.verfuegbar && a.bald && <em className="vp-assist-soon">{a.bald}</em>}
              </button>
            ))}
          </div>

          {!http && (
            <>
              <div className="vp-assist-field">
                <label htmlFor="bat-host">Adresse des MQTT-Servers</label>
                <Input
                  id="bat-host"
                  value={broker.host}
                  placeholder="192.168.1.50"
                  onChange={(e) => setBroker((b) => ({ ...b, host: e.target.value }))}
                />
                <p className="vp-assist-help">
                  Die IP-Adresse des Rechners, auf dem Ihr MQTT-Server läuft - meist Ihr
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
            </>
          )}

          {http && (
            <>
              {/*
                Die VORLAGE zuerst: „DIYBMS v4 - /ha" füllt Pfad, Anmelde-Art und
                die ganze Feld-Zuordnung. Sie ist ein Vorschlag, kein Vertrag -
                eine andere Firmware kann andere Feldnamen haben, deshalb steht
                die Live-Vorschau daneben. Und sie nimmt niemandem eine schon
                getippte Zuordnung weg.
              */}
              <div className="vp-sb-add">
                {HTTP_VORLAGEN.map((v) => (
                  <Button
                    key={v.id}
                    variant="ghost"
                    data-testid={`http-vorlage-${v.id}`}
                    onClick={() => {
                      const next = vorlageAnwenden(v, endpunkt, anmeldung, zeilen);
                      setEndpunkt(next.endpunkt);
                      setAnmeldung(next.anmeldung);
                      setZeilen(next.zeilen);
                      setVorschau(null);
                    }}
                  >
                    Vorlage „{v.label}" übernehmen
                  </Button>
                ))}
              </div>

              <div className="vp-assist-field">
                <label htmlFor="bat-http-host">Adresse des BMS</label>
                <Input
                  id="bat-http-host"
                  value={endpunkt.host}
                  placeholder="192.168.1.60"
                  onChange={(e) => setEndpunkt((x) => ({ ...x, host: e.target.value }))}
                />
                <p className="vp-assist-help">
                  Die IP-Adresse Ihres BMS-Controllers im Heimnetz. VoltPilot ruft dort nur ab -
                  es schreibt nie.
                </p>
              </div>
              <div className="vp-assist-field">
                <label htmlFor="bat-http-path">Pfad der JSON-Auskunft</label>
                <Input
                  id="bat-http-path"
                  value={endpunkt.path}
                  placeholder="/ha"
                  onChange={(e) => setEndpunkt((x) => ({ ...x, path: e.target.value }))}
                />
                <p className="vp-assist-help">
                  Steht in der Anleitung Ihres BMS - beim DIYBMS v4 ist es /ha.
                </p>
              </div>
              <div className="vp-sb-pair">
                <div className="vp-assist-field">
                  <label htmlFor="bat-http-port">Port</label>
                  <Input
                    id="bat-http-port"
                    type="number"
                    value={endpunkt.port}
                    onChange={(e) => setEndpunkt((x) => ({ ...x, port: e.target.value }))}
                  />
                </div>
                <div className="vp-assist-field">
                  <label htmlFor="bat-http-iv">Abruf-Abstand (s)</label>
                  <Input
                    id="bat-http-iv"
                    type="number"
                    value={endpunkt.publishIntervalS}
                    onChange={(e) => setEndpunkt((x) => ({
                      ...x, publishIntervalS: e.target.value,
                    }))}
                  />
                  <p className="vp-assist-help">
                    So oft ruft Ihre Box die Auskunft ab. Es läuft immer nur ein Abruf.
                  </p>
                </div>
              </div>

              <div className="vp-assist-field">
                <VpPicker
                  id="bat-http-auth"
                  label="Anmeldung"
                  options={ANMELDE_ARTEN.map((a) => ({ value: a.id, label: a.label }))}
                  value={anmeldung.art}
                  onChange={(v) => setAnmeldung((x) => ({
                    ...x, art: v as AnmeldungForm['art'],
                  }))}
                />
                <p className="vp-assist-help">
                  {ANMELDE_ARTEN.find((a) => a.id === anmeldung.art)?.hint}
                </p>
              </div>
              {anmeldung.art === 'header' && (
                <div className="vp-assist-field">
                  <label htmlFor="bat-http-header">Name der Kopfzeile</label>
                  <Input
                    id="bat-http-header"
                    value={anmeldung.header}
                    placeholder="ApiKey"
                    onChange={(e) => setAnmeldung((x) => ({ ...x, header: e.target.value }))}
                  />
                </div>
              )}
              {anmeldung.art === 'basic' && (
                <div className="vp-assist-field">
                  <label htmlFor="bat-http-user">Benutzername</label>
                  <Input
                    id="bat-http-user"
                    value={anmeldung.username}
                    onChange={(e) => setAnmeldung((x) => ({ ...x, username: e.target.value }))}
                  />
                </div>
              )}
              {anmeldung.art !== 'none' && (
                <div className="vp-assist-field">
                  <label htmlFor="bat-http-secret">
                    {anmeldung.art === 'basic' ? 'Kennwort' : 'Schlüssel'}
                  </label>
                  <Input
                    id="bat-http-secret"
                    type="password"
                    value={anmeldung.secret}
                    placeholder={geheimnisBesteht ? GEHEIMNIS_MASKE : ''}
                    onChange={(e) => setAnmeldung((x) => ({ ...x, secret: e.target.value }))}
                  />
                  <p className="vp-assist-help">
                    {geheimnisBesteht
                      ? 'Bleibt das Feld leer, gilt der gespeicherte Schlüssel weiter - er '
                        + 'verlässt den Server nie.'
                      : 'Er wird verschlüsselt übertragen, an Ihre Box weitergegeben und nie '
                        + 'wieder angezeigt.'}
                  </p>
                </div>
              )}

              <details className="vp-sb-profi">
                <summary>Weitere Angaben</summary>
                <div className="vp-sb-pair">
                  <div className="vp-assist-field">
                    <label htmlFor="bat-http-timeout">Zeitgrenze (ms)</label>
                    <Input
                      id="bat-http-timeout"
                      type="number"
                      value={endpunkt.timeoutMs}
                      onChange={(e) => setEndpunkt((x) => ({ ...x, timeoutMs: e.target.value }))}
                    />
                    <p className="vp-assist-help">
                      So lange wartet Ihre Box auf die Antwort, bevor sie den Abruf als
                      „keine Antwort" abbricht.
                    </p>
                  </div>
                  <div className="vp-assist-field">
                    <label htmlFor="bat-http-tls">HTTPS</label>
                    <input
                      id="bat-http-tls"
                      type="checkbox"
                      checked={endpunkt.tls}
                      onChange={(e) => setEndpunkt((x) => ({
                        ...x,
                        tls: e.target.checked,
                        port: String(e.target.checked ? 443 : 80),
                      }))}
                    />
                    <p className="vp-assist-help">
                      Nur, wenn Ihr BMS wirklich HTTPS spricht - die meisten im Heimnetz tun es
                      nicht.
                    </p>
                  </div>
                </div>
              </details>
            </>
          )}
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
            zeigt Ihre Box, was {http ? 'die Auskunft wirklich liefert' : 'auf diesen Topics wirklich hereinkommt'}.
          </p>

          {zeilen.map((z, i) => {
            const mangel = zuordnungFehler(z, art);
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

                {!http && (
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
                )}
                <div className="vp-sb-pair">
                  <div className="vp-assist-field">
                    <label htmlFor={`bat-path-${z.key}`}>Wert im JSON</label>
                    <Input
                      id={`bat-path-${z.key}`}
                      value={z.path}
                      placeholder={http ? 'soc' : 'voltage'}
                      onChange={(e) => setzeZeile(z.key, { path: e.target.value })}
                    />
                    <p className="vp-assist-help">
                      {http
                        ? 'Punkt-getrennt, zum Beispiel soc oder bms.soc. „*" steht für jede '
                          + 'Ebene: cells.*.v trifft jede Zelle der Liste.'
                        : 'Leer lassen, wenn die Nachricht selbst die Zahl ist.'}
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
                    {/*
                      Die Haltbarkeit gehört dem MQTT-Weg: dort kommen Nachrichten
                      einzeln an. Eine HTTP-Antwort ist EIN Zeitpunkt - was sie
                      nicht enthält, fehlt, und eine vorige Antwort wird nie mit
                      frischer Zeit wiederholt.
                    */}
                    {!http && (
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
                    )}
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
                    {http ? 'Nichts gefunden. Stimmt der Wertepfad?' : 'Nichts empfangen. Stimmt das Topic?'}
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
              {laeuft ? (http ? 'Rufe ab …' : 'Höre zu …') : 'Werte ansehen'}
            </Button>
            <p className="vp-assist-help">
              {http
                ? 'Ihre Box ruft die Auskunft EINMAL ab und zeigt, was darin steht. Sie ist '
                  + 'keine Voraussetzung fürs Speichern.'
                : 'Ihre Box hört einige Sekunden mit und zeigt, was ankommt. Sie ist keine '
                  + 'Voraussetzung fürs Speichern.'}
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
                  <VpDatePicker
                    id="bat-anchor-at"
                    label="Anker: Datum"
                    value={soc.anchorAt.split('T')[0] ?? ''}
                    onChange={(wert) => setAnkerTeil('datum', wert)}
                  />
                  <VpTimePicker
                    label="Anker: Uhrzeit"
                    value={soc.anchorAt.split('T')[1] ?? ''}
                    onChange={(wert) => setAnkerTeil('zeit', wert)}
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
            {pruefen(name, broker, zeilen, soc, bindung, ziele, art, endpunkt, anmeldung).map((row) => (
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
            <Recht aktion="geraet.einrichten"><Button onClick={anlegen} disabled={speichern}>
              {speichern ? 'Speichere …' : bearbeiten ? 'Änderungen speichern' : 'Batterie anlegen'}
            </Button></Recht>
          </Nav>
        </>
      )}
    </section>
  );
}
