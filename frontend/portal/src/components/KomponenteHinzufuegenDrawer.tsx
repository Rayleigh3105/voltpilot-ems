import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type ComponentTemplate,
  type Device,
  type SiteComponents,
  type SiteComponentTemplate,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { SelbstbauAssistent } from './SelbstbauAssistent';
import { LadesaeuleAnbinden } from './LadesaeuleAnbinden';
import { HEBEL_HINWEIS, HEBEL_INTRO, SKALIERUNG_X10, hebel } from '../testHebel';
// Der Assistent bringt sein Stylesheet SELBST mit (die RegelKarten-Lehre): sich
// auf den Import des Wirts zu verlassen liefert einem zweiten Wirt einen
// ungestylten Assistenten - Türen als nackte Knöpfe, die Schritte als <ol>.
import './KomponenteAssistent.css';
import {
  ABSCHLUSS_HINWEIS,
  ROLLEN,
  bilanzHinweis,
  fehlendeFelder,
  felder,
  initialeVerbindung,
  marken,
  modellSuche,
  nameHilfe,
  pruefen,
  rolleVerfuegbar,
  templatesFuerTuer,
  testErgebnis,
  tueren,
  uebernahmeHinweis,
  type ComponentMatch,
  type KomponentenRolle,
  type TemplateField,
  type TestErgebnis,
  type TestOverride,
  type TestZustand,
  type TuerId,
} from '../komponentenAssistent';

/**
 * Der EINE Anlege-Assistent „＋ Komponente hinzufügen" (Einheitsmodell Stufe 1,
 * Konzept `vp-komponenten-einheit-h2` §4.1).
 *
 * Vier Schritte: **Gerät** (Tür → Marke → Modell) → **Verbindung** (Formular
 * GENERISCH aus dem `transport_schema` der Vorlage + „Verbindung testen") →
 * **Was ist es?** (Rolle + Bilanz-Hinweis) → **Prüfen & anlegen**.
 *
 * Diese Datei RENDERT nur; jede Regel - welche Felder es gibt, was fehlt, ob
 * der Test ein Ja war, was in der Zusammenfassung steht - kommt aus dem reinen
 * `komponentenAssistent.ts` und ist dort ohne DOM geprüft.
 *
 * **Der Verbindungstest ist ein Tor, kein Schmuck.** „Weiter" bleibt zu, bis das
 * Gerät wirklich geantwortet hat - und der Server verlangt denselben Beleg noch
 * einmal, bevor er speichert. Ein Blind-Soll ist seit dieser Stufe der Lesepfad
 * einer echten Anlage.
 */
export function KomponenteHinzufuegenDrawer({
  siteId,
  box,
  onClose,
  onSaved,
  vorlage,
}: {
  siteId: string;
  /**
   * Die Box dieser Anlage - nur die Ladesäulen-Tür braucht sie: sie kennt ihre
   * eigene Adresse (D5), und daraus entsteht der `ws://`-Endpunkt. Ohne sie
   * nennt der Assistent ehrlich den Weg statt eine Adresse zu behaupten.
   */
  box?: Device;
  onClose: () => void;
  onSaved: (result: SiteComponents) => void;
  /**
   * Einheitsmodell Stufe 6: aus einer EIGENEN Vorlage ein Gerät machen. Mit
   * ihr startet der Assistent direkt in der Selbstbau-Tür, vorbefüllt - die
   * Tür-Auswahl wäre dann eine Frage, die der Kunde schon beantwortet hat.
   */
  vorlage?: SiteComponentTemplate | null;
}) {
  const [templates, setTemplates] = useState<ComponentTemplate[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [schritt, setSchritt] = useState<1 | 2 | 3 | 4>(vorlage ? 2 : 1);
  const [tuer, setTuer] = useState<TuerId | null>(vorlage ? 'selbstbau' : null);
  const [brand, setBrand] = useState<string | null>(null);
  const [suchtext, setSuchtext] = useState('');
  const [template, setTemplate] = useState<ComponentTemplate | null>(null);
  const [verbindung, setVerbindung] = useState<Record<string, unknown>>({});
  const [testZustand, setTestZustand] = useState<TestZustand>('ungeprueft');
  const [testText, setTestText] = useState<TestErgebnis | null>(null);
  /**
   * Der abgenickte Kanal („Trotzdem fortfahren (nur Lesen)"). Er reist beim
   * Speichern mit und NENNT den Kanal - der Server prüft, dass genau dieser
   * auch der fehlende war.
   */
  const [ohneKanal, setOhneKanal] = useState<TestOverride | null>(null);
  const [fragOhneKanal, setFragOhneKanal] = useState(false);
  const [rolle, setRolle] = useState<KomponentenRolle | null>(null);
  const [name, setName] = useState('');
  const [kwp, setKwp] = useState('');
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [fertig, setFertig] = useState(false);
  const [vorhandene, setVorhandene] = useState<string[]>([]);
  /**
   * Die vorhandene Komponente, die dieses Gerät übernimmt - VOM SERVER, nie
   * hier abgeleitet (Alias-Kontinuität). `null` = es entsteht eine neue.
   */
  const [uebernahme, setUebernahme] = useState<ComponentMatch | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .componentTemplates()
      .then((t) => alive && setTemplates(t))
      .catch(() => alive && setLadeFehler('Die Geräte-Auswahl konnte nicht geladen werden.'));
    api
      .siteComponents(siteId)
      .then((c) => alive && setVorhandene(c.components.map((r) => r.role ?? '')))
      .catch(() => {
        /* Die Rollen-Vorprüfung ist Komfort; der Server prüft ohnehin. */
      });
    return () => {
      alive = false;
    };
  }, [siteId]);

  const alle = templates ?? [];
  const doors = useMemo(() => tueren(alle), [alle]);
  const tuerTemplates = useMemo(
    () => (tuer ? templatesFuerTuer(alle, tuer) : []),
    [alle, tuer],
  );
  const brands = useMemo(() => marken(tuerTemplates), [tuerTemplates]);
  // Die SUCHE läuft über ALLE Marken dieser Tür - dieselbe Liste, aus der auch
  // das Stufenmenü darunter schöpft (es entsteht keine zweite Quelle).
  const suche = useMemo(() => modellSuche(tuerTemplates, suchtext), [tuerTemplates, suchtext]);
  const models = brands.find((b) => b.brand === brand)?.models ?? [];
  const fields = felder(template);
  // ⚠ Die HEBEL entstehen aus BELEGEN (Server-Fehlerklasse + Befund) und aus
  // dem, was die Vorlage strukturell hergibt - nie aus einer eigenen Diagnose
  // der gelesenen Zahlen. Die ganze Regel liegt rein in `testHebel.ts`.
  const hebelListe = hebel({ ergebnis: testText, template, templates, verbindung });
  const fehlend = fehlendeFelder(template, verbindung);

  function waehleTemplate(t: ComponentTemplate) {
    setTemplate(t);
    setVerbindung(initialeVerbindung(t));
    // ⚠ NICHT mit dem Modellnamen vorbefüllen (Alias-Kontinuität, Live-Fall
    // Herzogau 20.08.2026): ein vorbefülltes Feld wird mitgeschickt und
    // überschreibt beim Übernehmen den Namen, den der Kunde vergeben hat. Leer
    // heißt „nichts ändern" - der Modellname steht als Platzhalter daneben.
    setName('');
    setUebernahme(null);
    setTestZustand('ungeprueft');
    setTestText(null);
    setOhneKanal(null);
    setSchritt(2);
  }

  /**
   * Ein Hebel-Klick. ⚠ Er ÄNDERT so wenig wie möglich: die Adress-Hebel
   * springen ihr Feld nur AN (der Mensch weiß, was dort stehen muss, VoltPilot
   * nicht), und nur die Skalierung setzt wirklich einen Wert - sie hat genau
   * eine sinnvolle Alternative.
   */
  function hebelKlick(h: { id: string; feld: string | null }) {
    if (h.id === 'modell') {
      // Zurück zur Modellwahl, mit der Marke schon gewählt - die Alternativen
      // stehen damit sofort da.
      setBrand(template?.brand ?? null);
      setSchritt(1);
      return;
    }
    if (!h.feld) return;
    if (h.id === 'skalierung') {
      const f = fields.find((x) => x.key === h.feld);
      if (f) setzeFeld(f, SKALIERUNG_X10);
    }
    // Anspringen: das Feld bekommt den Fokus, der Mensch sieht sofort, wo er ist.
    window.setTimeout(() => {
      const el = document.getElementById(`assist-${h.feld}`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
      }
    }, 0);
  }

  function setzeFeld(field: TemplateField, value: unknown) {
    setVerbindung((v) => ({ ...v, [field.key]: value }));
    // Jede Änderung entwertet den Beleg - genau das ist der Sinn der Pflicht.
    setTestZustand('ungeprueft');
    setTestText(null);
    // ... und damit auch die Ausnahme: sie galt GENAU dieser Verbindung.
    setOhneKanal(null);
    // ⚠ Und sie entwertet den ÜBERNAHME-Vorschlag: er gilt GENAU dieser
    // Verbindung. Eine andere Adresse ist ein anderes Gerät - ein
    // stehengebliebener Vorschlag würde eine Komponente ankündigen, die der
    // Server danach gar nicht mehr übernimmt.
    setUebernahme(null);
  }

  async function testen() {
    if (!template) return;
    setTestZustand('laeuft');
    setTestText(null);
    // Ein neuer Lauf beantwortet die Frage neu - eine Ausnahme aus dem vorigen
    // gilt nicht weiter. (Genau so verschwindet sie, sobald das BMS gekoppelt
    // ist und der Test wieder vollständig besteht.)
    setOhneKanal(null);
    try {
      const antwort = await api.testComponentConnection(siteId, {
        templateRef: template.templateRef,
        role: rolle ?? undefined,
        connection: verbindung,
      });
      const ergebnis = testErgebnis(antwort);
      setTestText(ergebnis);
      setTestZustand(ergebnis.zustand);
    } catch (e) {
      setTestZustand('fehlgeschlagen');
      setTestText({
        zustand: 'fehlgeschlagen',
        text: e instanceof ApiError ? e.message : 'Die Prüfung ist fehlgeschlagen.',
        messwerte: [],
      });
    }
  }

  async function anlegen() {
    if (!template || !rolle) return;
    setSpeichern(true);
    setFehler(null);
    try {
      const result = await api.createComponent(siteId, {
        templateRef: template.templateRef,
        label: name.trim() || undefined,
        role: rolle,
        connection: verbindung,
        capacityKwp: rolle === 'pv-generation' && kwp.trim() !== '' ? Number(kwp) : undefined,
        acceptMissingChannel: ohneKanal?.channel,
      });
      setFertig(true);
      onSaved(result);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Speichern ist fehlgeschlagen.');
    } finally {
      setSpeichern(false);
    }
  }

  /**
   * Die Rolle wählen - und den Server fragen, ob dieses Gerät schon eine
   * Komponente hat. Fehlschlag = kein Vorschlag (fail-soft): ein älteres
   * Backend kennt die Route nicht, und ohne Vorschlag verhält sich der
   * Assistent exakt wie vorher.
   */
  async function waehleRolle(r: KomponentenRolle) {
    setRolle(r);
    setUebernahme(null);
    if (!template) return;
    try {
      const hit = await api.matchComponent(siteId, {
        templateRef: template.templateRef,
        role: r,
        connection: verbindung,
      });
      setUebernahme(hit ?? null);
    } catch {
      // Fail-soft: ein älteres Backend kennt die Route nicht. Ohne Vorschlag
      // verhält sich der Assistent exakt wie vorher - eine Fehlermeldung wäre
      // hier eine Störung ohne Folge.
      setUebernahme(null);
    }
  }

  const rollenStatus = rolle ? rolleVerfuegbar(rolle, vorhandene) : { ok: true as const };

  return (
    <Drawer open title="Komponente hinzufügen" onClose={onClose}>
      <div className="vp-assist">
        {ladeFehler && <p className="vp-assist-error">{ladeFehler}</p>}

        <ol className="vp-assist-steps" aria-label="Schritte">
          {(tuer === 'selbstbau'
            ? ['Gerät', 'Messwerte', 'Was ist es?', 'Prüfen']
            : ['Gerät', 'Verbindung', 'Was ist es?', 'Prüfen']
          ).map((s, i) => (
            <li key={s} className={schritt === i + 1 ? 'is-active' : schritt > i + 1 ? 'is-done' : ''}>
              <span className="vp-assist-step-n">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>

        {fertig ? (
          <div className="vp-assist-done">
            <p className="vp-assist-ok">
              <Icon name="check" /> {ABSCHLUSS_HINWEIS}
            </p>
            <Button onClick={onClose}>Schließen</Button>
          </div>
        ) : (
          <>
            {tuer === 'selbstbau' && schritt > 1 ? (
              <SelbstbauAssistent
                siteId={siteId}
                vorlage={vorlage}
                onBack={() => (vorlage ? onClose() : setSchritt(1))}
                onSaved={onSaved}
                onDone={onClose}
              />
            ) : (
            <>
            {schritt === 1 && (
              <section>
                <h3 className="vp-assist-h">Was möchten Sie hinzufügen?</h3>
                <div className="vp-assist-doors">
                  {doors.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`vp-assist-door${d.verfuegbar ? '' : ' is-soon'}`}
                      disabled={!d.verfuegbar}
                      aria-disabled={!d.verfuegbar}
                      onClick={() => {
                        setTuer(d.id);
                        setBrand(null);
                        // Die Selbstbau-Tür hat keine Vorlagen-Auswahl - sie
                        // fragt sofort nach dem Gerät.
                        if (d.id === 'selbstbau') setSchritt(2);
                      }}
                    >
                      <strong>{d.label}</strong>
                      <span>{d.hint}</span>
                      {!d.verfuegbar && d.bald && <em className="vp-assist-soon">{d.bald}</em>}
                    </button>
                  ))}
                </div>

                {/* Die Ladesäulen-Tür legt weiterhin NICHTS an (§13.4) - die
                    Säule verbindet sich selbst. Seit Geräteseiten Stufe 3 (E1)
                    steht hier aber der ASSISTENT statt dreier Sätze: er trägt
                    die Kennung ein und nennt die konkrete Adresse. Es ist
                    derselbe Körper wie im Drawer der Ladevorgänge-Seite - eine
                    zweite Kopie wären zwei Wahrheiten über denselben Weg. */}
                {tuer === 'ladesaeule' && (
                  <div className="vp-assist-pick" data-testid="tuer-ladesaeule">
                    <LadesaeuleAnbinden siteId={siteId} device={box} />
                  </div>
                )}

                {tuer && tuer !== 'selbstbau' && tuer !== 'ladesaeule' && brands.length > 0 && (
                  <div className="vp-assist-pick">
                    {/* Die SUCHE ist der primäre Weg (Captain 21.08.2026): wer
                        sein Modell nicht schon einer Marke zuordnen kann,
                        klickt sich sonst durch sieben Marken - und wer den
                        Namen vom Typenschild abtippt, trifft die Schreibweise
                        selten exakt. Das Stufenmenü darunter BLEIBT als
                        Stöber-Weg. */}
                    <label htmlFor="assist-suche">Modell suchen</label>
                    <input
                      id="assist-suche"
                      type="search"
                      className="vp-assist-suche"
                      value={suchtext}
                      onChange={(e) => setSuchtext(e.target.value)}
                      placeholder="z. B. SUN-30K, SG02 oder Fronius"
                      autoComplete="off"
                    />
                    {suche.zaehler && (
                      <p className="vp-assist-note" data-testid="suche-zaehler">{suche.zaehler}</p>
                    )}
                    {suche.leer && (
                      <p className="vp-assist-note" data-testid="suche-leer">{suche.leer}</p>
                    )}
                    {suche.treffer.length > 0 && (
                      <ul className="vp-assist-treffer" data-testid="suche-treffer">
                        {suche.treffer.map((tr) => (
                          <li key={tr.template.templateRef}>
                            <button
                              type="button"
                              onClick={() => {
                                setBrand(tr.template.brand);
                                waehleTemplate(tr.template);
                              }}
                            >
                              <strong>
                                {tr.modell.map((teil, i) => (
                                  teil.treffer
                                    ? <mark key={i}>{teil.text}</mark>
                                    : <span key={i}>{teil.text}</span>
                                ))}
                              </strong>
                              <span className="vp-assist-treffer-marke">
                                {tr.marke.map((teil, i) => (
                                  teil.treffer
                                    ? <mark key={i}>{teil.text}</mark>
                                    : <span key={i}>{teil.text}</span>
                                ))}
                              </span>
                              {tr.zusatz && <span className="vp-assist-treffer-zusatz">{tr.zusatz}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <label htmlFor="assist-brand">Marke</label>
                    <select
                      id="assist-brand"
                      value={brand ?? ''}
                      onChange={(e) => setBrand(e.target.value || null)}
                    >
                      <option value="">Bitte wählen …</option>
                      {brands.map((b) => (
                        <option key={b.brand} value={b.brand}>
                          {b.brandLabel}
                        </option>
                      ))}
                    </select>
                    {brand && (
                      <>
                        <label htmlFor="assist-model">Modell</label>
                        <select
                          id="assist-model"
                          value={template?.templateRef ?? ''}
                          onChange={(e) => {
                            const t = models.find((m) => m.templateRef === e.target.value);
                            if (t) waehleTemplate(t);
                          }}
                        >
                          <option value="">Bitte wählen …</option>
                          {models.map((m) => (
                            <option key={m.templateRef} value={m.templateRef}>
                              {m.modelLabel}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

            {schritt === 2 && template && (
              <section>
                <h3 className="vp-assist-h">Verbindung zu {template.modelLabel}</h3>
                <p className="vp-assist-sub">{template.communicationLabel}</p>
                {fields.map((f) => (
                  <div className="vp-assist-field" key={f.key}>
                    <label htmlFor={`assist-${f.key}`}>
                      {f.label}
                      {f.required && <span aria-hidden="true"> *</span>}
                    </label>
                    {f.type === 'checkbox' ? (
                      <input
                        id={`assist-${f.key}`}
                        type="checkbox"
                        checked={Boolean(verbindung[f.key])}
                        onChange={(e) => setzeFeld(f, e.target.checked)}
                      />
                    ) : f.options ? (
                      <select
                        id={`assist-${f.key}`}
                        value={String(verbindung[f.key] ?? '')}
                        onChange={(e) => setzeFeld(f, e.target.value)}
                      >
                        {f.options.map((o) => (
                          <option key={String(o.value)} value={String(o.value)}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id={`assist-${f.key}`}
                        type={f.type === 'number' ? 'number' : 'text'}
                        value={String(verbindung[f.key] ?? '')}
                        onChange={(e) => setzeFeld(f, e.target.value)}
                      />
                    )}
                    {f.help && <p className="vp-assist-help">{f.help}</p>}
                  </div>
                ))}

                <div className="vp-assist-test">
                  <Button
                    variant="outline"
                    onClick={testen}
                    disabled={fehlend.length > 0 || testZustand === 'laeuft'}
                  >
                    {testZustand === 'laeuft' ? 'Prüfe …' : 'Verbindung testen'}
                  </Button>
                  {fehlend.length > 0 && (
                    <p className="vp-assist-help">
                      Es fehlt noch: {fehlend.map((f) => f.label).join(', ')}
                    </p>
                  )}
                  {testText && (
                    <div
                      className={
                        testText.zustand === 'bestanden'
                          ? 'vp-assist-ok'
                          : 'vp-assist-error'
                      }
                      role="status"
                    >
                      <p>{testText.text}</p>
                      {/* Die VERLETZTE REGEL im Klartext - direkt über den
                          Werten, die wirklich ankamen. Ein Fehlschlag ohne eine
                          einzige Zahl war ein Rätsel; hier steht, was gemessen
                          wurde und was daraus folgt. */}
                      {testText.regelText && (
                        <p className="vp-assist-regel">{testText.regelText}</p>
                      )}
                      {testText.messwerte.length > 0 && (
                        <ul className="vp-assist-readings">
                          {testText.messwerte.map((m) => (
                            <li key={m.label}>
                              <span>{m.label}</span>
                              <strong>{m.wert}</strong>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {/* Die HEBEL (NACHTRAG 2): konkrete Wege statt eines
                      Fließtexts. Sie erscheinen auch neben einem BESTANDENEN
                      Test - der Faktor-10-Fall verletzt keine
                      Plausibilitätsregel und käme sonst nie zur Sprache. */}
                  {hebelListe.length > 0 && (
                    <div className="vp-assist-hebel" data-testid="test-hebel">
                      <p className="vp-assist-hebel-intro">{HEBEL_INTRO}</p>
                      <ul>
                        {hebelListe.map((h) => (
                          <li key={h.id}>
                            <div>
                              <strong>{h.titel}</strong>
                              <span>{h.satz}</span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`hebel-${h.id}`}
                              onClick={() => hebelKlick(h)}
                            >
                              {h.aktion}
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <p className="vp-assist-hebel-note">{HEBEL_HINWEIS}</p>
                    </div>
                  )}
                  {/* Der Ausweg - NUR wenn der Server ihn als solchen ausweist.
                      Er wird nie hier abgeleitet: ob eine Verletzung übergehbar
                      ist, weiß allein die Box, die gelesen hat. */}
                  {testZustand === 'fehlgeschlagen' && testText?.override && !ohneKanal && (
                    <Button
                      variant="outline"
                      onClick={() => setFragOhneKanal(true)}
                      data-testid="override-anbieten"
                    >
                      {testText.override.label}
                    </Button>
                  )}
                  {ohneKanal && (
                    <p className="vp-assist-uebernahme" data-testid="override-aktiv">
                      Sie fahren fort, ohne dass diese Komponente einen Ladestand meldet. Alle
                      anderen Messwerte laufen normal; die Steuerung des Speichers bleibt aus.
                    </p>
                  )}
                </div>

                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={() => setSchritt(1)}>
                    Zurück
                  </Button>
                  <Button
                    onClick={() => setSchritt(3)}
                    disabled={testZustand !== 'bestanden' && !ohneKanal}
                  >
                    Weiter
                  </Button>
                </div>
              </section>
            )}

            {schritt === 3 && template && (
              <section>
                <h3 className="vp-assist-h">Was ist dieses Gerät?</h3>
                <div className="vp-assist-roles">
                  {ROLLEN.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`vp-assist-role${rolle === r.id ? ' is-on' : ''}`}
                      onClick={() => void waehleRolle(r.id)}
                    >
                      <strong>{r.label}</strong>
                      <span>{r.hint}</span>
                    </button>
                  ))}
                </div>
                {rolle && (
                  <>
                    <p className="vp-assist-balance">{bilanzHinweis(rolle)}</p>
                    {!rollenStatus.ok && <p className="vp-assist-error">{rollenStatus.grund}</p>}
                    {uebernahmeHinweis(uebernahme, template) && (
                      <p className="vp-assist-uebernahme">
                        {uebernahmeHinweis(uebernahme, template)}
                      </p>
                    )}
                    <div className="vp-assist-field">
                      <label htmlFor="assist-name">Name</label>
                      <Input
                        id="assist-name"
                        value={name}
                        placeholder={uebernahme?.label?.trim() || template.modelLabel}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <p className="vp-assist-help">{nameHilfe(uebernahme)}</p>
                    </div>
                    {rolle === 'pv-generation' && (
                      <div className="vp-assist-field">
                        <label htmlFor="assist-kwp">Leistung (kWp)</label>
                        <Input
                          id="assist-kwp"
                          type="number"
                          value={kwp}
                          onChange={(e) => setKwp(e.target.value)}
                        />
                        <p className="vp-assist-help">
                          Optional - sie zählt zur Gesamtleistung Ihrer Anlage.
                        </p>
                      </div>
                    )}
                  </>
                )}
                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={() => setSchritt(2)}>
                    Zurück
                  </Button>
                  <Button onClick={() => setSchritt(4)} disabled={!rolle || !rollenStatus.ok}>
                    Weiter
                  </Button>
                </div>
              </section>
            )}

            {schritt === 4 && template && rolle && (
              <section>
                <h3 className="vp-assist-h">Prüfen &amp; anlegen</h3>
                <dl className="vp-assist-check">
                  {pruefen(template, rolle, name, verbindung, uebernahme).map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.wert}</dd>
                    </div>
                  ))}
                </dl>
                <p className="vp-assist-balance">{bilanzHinweis(rolle)}</p>
                {fehler && <p className="vp-assist-error">{fehler}</p>}
                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={() => setSchritt(3)}>
                    Zurück
                  </Button>
                  <Button onClick={anlegen} disabled={speichern}>
                    {speichern ? 'Speichere …' : 'Komponente anlegen'}
                  </Button>
                </div>
              </section>
            )}
            </>
            )}
          </>
        )}
      </div>
      {/* Die Rückfrage im HAUS-MUSTER (Folgenliste statt window.confirm): sie
          nennt ausdrücklich auch, was GLEICH bleibt - sonst liest sich der
          Klick wie ein Lockern der Regeln. */}
      <ConfirmDialog
        open={fragOhneKanal && !!testText?.override}
        title="Ohne Ladestand fortfahren?"
        intro={
          'Ihr Gerät antwortet, meldet aber keinen Ladestand. Diese Komponente wird dann nur ' +
          'ausgelesen.'
        }
        consequences={testText?.override?.folgen ?? []}
        confirmLabel="Trotzdem fortfahren"
        onCancel={() => setFragOhneKanal(false)}
        onConfirm={() => {
          setOhneKanal(testText?.override ?? null);
          setFragOhneKanal(false);
        }}
      />
    </Drawer>
  );
}
