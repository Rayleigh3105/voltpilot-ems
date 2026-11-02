import { useMemo, useState, type ChangeEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type ComponentTemplate, type ProbeAntwort, type SiteComponents } from '../api';
import type { GeraetesucheFund } from '../geraetesuche';
import { geraetesucheBezug } from '../geraetesucheHerkunft';
import {
  ANSCHLUSS_WAHL,
  anschlussFehler,
  ausgangsFehler,
  heizstabVerbindung,
  kwText,
  nachStromausfallWarnung,
  stufen,
  stufeText,
  testZeilen,
  type Anschluss,
  type TestAusgang,
} from '../heizstab';
import { testErgebnis } from '../komponentenAssistent';
import { zahl } from '../zahl';
import './Heizstab.css';

/**
 * „Alle Ausgänge zusammen – z. B. Heizstab mit drei Phasen“ (Heizstab V1, Paket 4): EIN Gerät über
 * die Ausgänge eines Shelly aus der Gerätesuche. Gefragt wird, was die Box nicht sehen kann: der
 * Anschluss (nur Stern mit N darf einzelne Phasen schalten), die Leistung je Element, die Stufen und
 * die Phase für Stufe 1. Der Test liest jeden Ausgang und die Einstellung „nach Stromausfall“; „Auf
 * ‚aus‘ stellen“ schreibt sie nur auf diesen Klick (HZ-5). Gespeichert wird mit `consumerType:
 * heating-rod` - die API prüft dieselben Regeln noch einmal.
 */
export function HeizstabAnlegen({
  siteId,
  boxId,
  fund,
  template,
  verbindung,
  suchId,
  onClose,
  onFertig,
}: {
  siteId: string;
  boxId: string | null;
  fund: GeraetesucheFund;
  template: ComponentTemplate;
  verbindung: Record<string, unknown>;
  suchId: string | null;
  onClose: () => void;
  onFertig: (result: SiteComponents, titel: string) => void;
}) {
  const kanaele = Math.max(1, fund.kanaele ?? 1);
  const [anschluss, setAnschluss] = useState<Anschluss | null>(null);
  const [kwText_, setKwText] = useState('');
  const [mitTeilstufen, setMitTeilstufen] = useState<number[]>(() => Array.from({ length: kanaele - 1 }, (_, k) => k + 1));
  const [rotation, setRotation] = useState<'daily' | 'fixed'>('daily');
  const [name, setName] = useState('Heizstab');
  const [schritt, setSchritt] = useState<'einrichten' | 'test'>('einrichten');
  const [test, setTest] = useState<ProbeAntwort | null>(null);
  const [testLaeuft, setTestLaeuft] = useState(false);
  const [ausgaenge, setAusgaenge] = useState<TestAusgang[] | null>(null);
  const [stellt, setStellt] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [gezeigt, setGezeigt] = useState(false);

  const kw = zahl(kwText_);
  const teilstufenErlaubt = anschluss === 'stern_mit_n' || anschluss === 'unbekannt';
  const verbindungJetzt = useMemo(
    () =>
      heizstabVerbindung(verbindung, {
        kanaele,
        kwJeElement: kw ?? 0,
        stufen: teilstufenErlaubt ? mitTeilstufen : [],
        rotation,
        anschluss: anschluss ?? 'unbekannt',
      }),
    [verbindung, kanaele, kw, mitTeilstufen, rotation, anschluss, teilstufenErlaubt],
  );
  const stufenListe = stufen({
    channels: verbindungJetzt.channels as number[],
    output_kw: verbindungJetzt.output_kw as number[],
    stages: verbindungJetzt.stages as number[],
  });
  const eingabeFehler =
    anschlussFehler(anschluss, kanaele)
    ?? (kw === null ? 'Bitte geben Sie die Leistung eines Heizelements in kW an (Typenschild).' : null)
    ?? ausgangsFehler(verbindungJetzt);
  const testOk = testErgebnis(test).zustand === 'bestanden';
  const warnung = nachStromausfallWarnung(ausgaenge);

  const testen = async () => {
    setGezeigt(true);
    if (eingabeFehler) return;
    setSchritt('test');
    setTestLaeuft(true);
    setFehler(null);
    try {
      const antwort = await api.testComponentConnection(siteId, {
        templateRef: template.templateRef,
        templateVersion: template.version,
        role: 'consumer',
        connection: verbindungJetzt,
        deviceId: boxId ?? undefined,
      });
      setTest(antwort);
      setAusgaenge(antwort.results?.[0]?.ausgaenge ?? null);
    } catch (e) {
      setTest(null);
      setFehler(e instanceof ApiError ? e.message : 'Die Prüfung ist fehlgeschlagen.');
    } finally {
      setTestLaeuft(false);
    }
  };

  const ausStellen = async () => {
    setStellt(true);
    setFehler(null);
    try {
      const antwort = await api.nachStromausfallAus(siteId, {
        templateRef: template.templateRef,
        templateVersion: template.version,
        connection: verbindungJetzt,
        deviceId: boxId ?? undefined,
      });
      const zeile = antwort.results?.[0];
      if (zeile?.ok && zeile.ausgaenge) {
        // Der gelesene Schaltzustand bleibt, die Einstellung kommt aus der Antwort der Box.
        setAusgaenge((alt) =>
          zeile.ausgaenge!.map((a) => ({ ...a, ein: alt?.find((x) => x.kanal === a.kanal)?.ein ?? null })),
        );
      } else {
        setFehler(zeile?.message ?? antwort.message ?? 'Die Einstellung ließ sich nicht ändern.');
      }
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Einstellung ließ sich nicht ändern.');
    } finally {
      setStellt(false);
    }
  };

  const speichern = async () => {
    setSpeichert(true);
    setFehler(null);
    try {
      const result = await api.createComponent(siteId, {
        templateRef: template.templateRef,
        templateVersion: template.version,
        label: name.trim() || 'Heizstab',
        role: 'consumer',
        connection: verbindungJetzt,
        consumerType: 'heating-rod',
        geraetesuche: geraetesucheBezug(suchId, fund.schluessel) ?? undefined,
      });
      onFertig(result, name.trim() || 'Heizstab');
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Der Heizstab ließ sich nicht speichern.');
    } finally {
      setSpeichert(false);
    }
  };

  const titel = fund.modellName ?? template.modelLabel;
  const fuss =
    schritt === 'einrichten' ? (
      <>
        <Button variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" onClick={() => void testen()}>Verbindung testen</Button>
      </>
    ) : (
      <>
        <Button variant="outline" onClick={() => setSchritt('einrichten')} disabled={testLaeuft || speichert}>Zurück</Button>
        <Button variant="primary" onClick={() => void speichern()} disabled={!testOk || testLaeuft || speichert}>
          {speichert ? 'Speichert …' : 'Heizstab speichern'}
        </Button>
      </>
    );

  return (
    <Modal open onClose={onClose} title="Heizstab über alle Ausgänge" footer={fuss} breit>
      <div className="vp-hz" data-testid="heizstab-anlegen">
        <p className="vp-hz-unter">
          {titel} · {kanaele} Ausgänge als EIN Gerät. Ausgang 1 bis {kanaele} schalten die Phasen L1 bis L{kanaele}.
        </p>

        {schritt === 'einrichten' && (
          <>
            <section className="vp-hz-abschnitt" aria-labelledby="hz-anschluss">
              <h4 id="hz-anschluss">Wie sind die Heizelemente angeschlossen?</h4>
              <ul className="vp-hz-wahl">
                {ANSCHLUSS_WAHL.map((a) => (
                  <li key={a.wert}>
                    <button type="button" aria-pressed={anschluss === a.wert} onClick={() => setAnschluss(a.wert)}>
                      <b>{a.titel}</b>
                      <small>{a.text}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="vp-hz-abschnitt">
              <Input
                label="Leistung je Heizelement (kW)"
                hint={`Vom Typenschild. Zusammen: ${kw ? kwText(kw * kanaele) : '–'}`}
                inputMode="decimal"
                value={kwText_}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setKwText(e.target.value)}
                placeholder="z. B. 2,0"
              />
            </section>

            {kanaele > 1 && teilstufenErlaubt && (
              <section className="vp-hz-abschnitt" aria-labelledby="hz-stufen">
                <h4 id="hz-stufen">Stufen</h4>
                <p className="vp-hz-unter">Bei wenig Sonne heizt der Stab mit weniger Phasen. Alle Phasen sind immer dabei.</p>
                <ul className="vp-hz-stufen">
                  {Array.from({ length: kanaele }, (_, k) => k + 1).map((n) => {
                    const st = stufenListe.find((s) => s.ausgaenge === n);
                    const alle = n === kanaele;
                    return (
                      <li key={n}>
                        <label>
                          <input
                            type="checkbox"
                            checked={alle || mitTeilstufen.includes(n)}
                            disabled={alle}
                            onChange={(e) =>
                              setMitTeilstufen((alt) => (e.target.checked ? [...alt, n] : alt.filter((x) => x !== n)))
                            }
                          />
                          <span>{stufeText(n)}{st ? ` · ${kwText(st.kw)}` : ''}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <h4>Phase für 1 Phase</h4>
                <ul className="vp-hz-wahl">
                  <li>
                    <button type="button" aria-pressed={rotation === 'daily'} onClick={() => setRotation('daily')}>
                      <b>Täglich wechselnd</b>
                      <small>L1, am nächsten Tag L2, dann L3 - die Elemente nutzen sich gleich ab.</small>
                    </button>
                  </li>
                  <li>
                    <button type="button" aria-pressed={rotation === 'fixed'} onClick={() => setRotation('fixed')}>
                      <b>Immer L1</b>
                      <small>Zum Beispiel dieselbe Phase wie ein einphasiger Wechselrichter.</small>
                    </button>
                  </li>
                </ul>
              </section>
            )}

            <section className="vp-hz-abschnitt">
              <Input
                label="Name"
                value={name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              />
            </section>

            {gezeigt && eingabeFehler && (
              <p className="vp-hz-hinweis" role="alert">
                <Icon name="alert-triangle" size={15} />
                <span>{eingabeFehler}</span>
              </p>
            )}
          </>
        )}

        {schritt === 'test' && (
          <section className="vp-hz-abschnitt" aria-live="polite">
            <h4>Verbindung testen</h4>
            {testLaeuft && <p className="vp-hz-unter">Die Box liest den Shelly …</p>}
            {!testLaeuft && test && !testOk && <p className="vp-hz-fehler" role="alert">{testErgebnis(test).text}</p>}
            {!testLaeuft && testOk && (
              <>
                <ul className="vp-hz-zeilen">
                  {testZeilen(ausgaenge).map((z) => (
                    <li key={z.label}>
                      <b>{z.label}</b>
                      <span>{z.wert}</span>
                    </li>
                  ))}
                </ul>
                {warnung && (
                  <div className="vp-hz-abschnitt">
                    <p className="vp-hz-hinweis" role="status">
                      <Icon name="alert-triangle" size={15} />
                      <span>{warnung}</span>
                    </p>
                    <div className="vp-hz-knoepfe">
                      <Button variant="outline" size="sm" onClick={() => void ausStellen()} disabled={stellt}>
                        {stellt ? 'Stellt um …' : 'Auf „aus“ stellen'}
                      </Button>
                    </div>
                  </div>
                )}
                <p className="vp-hz-unter">
                  Jeder Ausgang schaltet sich nach 3 Minuten ohne Befehl der Box selbst ab. Automatisch heizt der Stab erst,
                  wenn Sie die Steuerart „Solar-Überschuss“ wählen.
                </p>
              </>
            )}
          </section>
        )}

        {fehler && (
          <p className="vp-hz-fehler" role="alert">{fehler}</p>
        )}
      </div>
    </Modal>
  );
}
