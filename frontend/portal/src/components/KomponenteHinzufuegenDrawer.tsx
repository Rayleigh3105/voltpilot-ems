import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type ComponentTemplate, type SiteComponents } from '../api';
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
  pruefen,
  rolleVerfuegbar,
  templatesFuerTuer,
  testErgebnis,
  tueren,
  type KomponentenRolle,
  type TemplateField,
  type TestErgebnis,
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
  onClose,
  onSaved,
}: {
  siteId: string;
  onClose: () => void;
  onSaved: (result: SiteComponents) => void;
}) {
  const [templates, setTemplates] = useState<ComponentTemplate[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [schritt, setSchritt] = useState<1 | 2 | 3 | 4>(1);
  const [tuer, setTuer] = useState<TuerId | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [template, setTemplate] = useState<ComponentTemplate | null>(null);
  const [verbindung, setVerbindung] = useState<Record<string, unknown>>({});
  const [testZustand, setTestZustand] = useState<TestZustand>('ungeprueft');
  const [testText, setTestText] = useState<TestErgebnis | null>(null);
  const [rolle, setRolle] = useState<KomponentenRolle | null>(null);
  const [name, setName] = useState('');
  const [kwp, setKwp] = useState('');
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [fertig, setFertig] = useState(false);
  const [vorhandene, setVorhandene] = useState<string[]>([]);

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
  const models = brands.find((b) => b.brand === brand)?.models ?? [];
  const fields = felder(template);
  const fehlend = fehlendeFelder(template, verbindung);

  function waehleTemplate(t: ComponentTemplate) {
    setTemplate(t);
    setVerbindung(initialeVerbindung(t));
    setName(t.modelLabel);
    setTestZustand('ungeprueft');
    setTestText(null);
    setSchritt(2);
  }

  function setzeFeld(field: TemplateField, value: unknown) {
    setVerbindung((v) => ({ ...v, [field.key]: value }));
    // Jede Änderung entwertet den Beleg - genau das ist der Sinn der Pflicht.
    setTestZustand('ungeprueft');
    setTestText(null);
  }

  async function testen() {
    if (!template) return;
    setTestZustand('laeuft');
    setTestText(null);
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
      });
      setFertig(true);
      onSaved(result);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Speichern ist fehlgeschlagen.');
    } finally {
      setSpeichern(false);
    }
  }

  const rollenStatus = rolle ? rolleVerfuegbar(rolle, vorhandene) : { ok: true as const };

  return (
    <Drawer open title="Komponente hinzufügen" onClose={onClose}>
      <div className="vp-assist">
        {ladeFehler && <p className="vp-assist-error">{ladeFehler}</p>}

        <ol className="vp-assist-steps" aria-label="Schritte">
          {['Gerät', 'Verbindung', 'Was ist es?', 'Prüfen'].map((s, i) => (
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
                      }}
                    >
                      <strong>{d.label}</strong>
                      <span>{d.hint}</span>
                      {!d.verfuegbar && d.bald && <em className="vp-assist-soon">{d.bald}</em>}
                    </button>
                  ))}
                </div>

                {tuer && brands.length > 0 && (
                  <div className="vp-assist-pick">
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
                </div>

                <div className="vp-assist-nav">
                  <Button variant="ghost" onClick={() => setSchritt(1)}>
                    Zurück
                  </Button>
                  <Button onClick={() => setSchritt(3)} disabled={testZustand !== 'bestanden'}>
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
                      onClick={() => setRolle(r.id)}
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
                    <div className="vp-assist-field">
                      <label htmlFor="assist-name">Name</label>
                      <Input
                        id="assist-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <p className="vp-assist-help">So heißt die Komponente in Ihrer Anlage.</p>
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
                  {pruefen(template, rolle, name, verbindung).map((row) => (
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
      </div>
    </Drawer>
  );
}
