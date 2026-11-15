import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { type SteuerlogikBlatt, type SteuerlogikLogik, type SteuerlogikProtokoll, type SteuerlogikVorschau } from '../../api';
import { api } from '../../apiVoll';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  ablehnungSaetze,
  abweichungSatz,
  dauer,
  istScharf,
  laufendeFassung,
  quittungSatz,
  standText,
  tagDerAnlage,
  uhrzeit,
} from '../../steuerlogikMitlauf';
import './SteuerlogikMitlaufBlatt.css';

/**
 * Das Blatt der Plattform für Steuerlogiken: VoltPilot gibt eine Logik als Datei ab, sie läuft auf der Box mit und
 * schaltet nichts (Stufe 2) - je Logik die Fassung, die Quittung der Box, die Lage und je Gerät, was sie schalten
 * würde, neben dem, was geschaltet ist; dazu das Protokoll des Tages. Stufe 3: „Scharf schalten“ ist ein eigener
 * Schritt mit den gesammelten Hinweisen und einer Bestätigung (E5 = C); ein zweiter Herr steht im Dialog und sperrt;
 * „Zurück zur vorigen Fassung“ und „Stilllegen“ wirken sofort. NUR hinter `showTechnicalLayer()` (eigener Chunk) -
 * Kundenkonten laden das nie; sie sehen die Karte der Logik in der Steuerung.
 */
export function SteuerlogikMitlaufBlatt({ siteId, jetzt }: { siteId: string; jetzt?: Date }) {
  const [blatt, setBlatt] = useState<SteuerlogikBlatt | null>(null);
  const [lesefehler, setLesefehler] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let aus = false;
    api.steuerlogikBlatt(siteId).then(
      (b) => { if (!aus) { setBlatt(b); setLesefehler(false); } },
      () => { if (!aus) { setBlatt(null); setLesefehler(true); } },
    );
    return () => { aus = true; };
  }, [siteId, tick]);
  const neuLaden = useCallback(() => setTick((t) => t + 1), []);

  return (
    <section id="technik-steuerlogik" className="vp-einst-grp vp-slm" aria-labelledby="technik-steuerlogik-h">
      <div className="vp-slm-kopf">
        <h2 id="technik-steuerlogik-h">Steuerlogik</h2>
        <p className="vp-slm-leise">
          Nur für VoltPilot. Eine Logik läuft auf der Box mit und schaltet nichts: hier steht, was sie schalten würde,
          neben dem, was geschaltet ist.
        </p>
      </div>
      {lesefehler && <p className="vp-slm-fehler" role="alert">Das Blatt ließ sich nicht laden.</p>}
      {blatt && (
        <>
          <p className={blatt.boxKann ? 'vp-slm-leise' : 'vp-slm-warn'}>
            {blatt.box == null
              ? 'Die Anlage hat keine eindeutige führende Box; eine Logik kann nirgends mitlaufen.'
              : blatt.boxKann
                ? 'Die Box kann eine Logik mitlaufen lassen.'
                : 'Die Box meldet die Fähigkeit steuerlogik_mitlauf nicht. Erst die Box aktualisieren.'}
          </p>
          {blatt.logiken.map((l) => (
            <LogikKarte key={l.logikId} siteId={siteId} logik={l} jetzt={jetzt} onGeaendert={neuLaden}
              boxKannScharf={blatt.boxKannScharf === true} />
          ))}
          {blatt.logiken.length === 0 && <p className="vp-slm-leise">An dieser Anlage läuft noch keine Logik mit.</p>}
          {blatt.box != null && blatt.boxKann && (
            <Annahme siteId={siteId} titel="Neue Logik" knopf="Prüfen und ausliefern" onAngenommen={neuLaden} />
          )}
        </>
      )}
    </section>
  );
}

function LogikKarte({
  siteId,
  logik,
  jetzt,
  onGeaendert,
  boxKannScharf,
}: {
  siteId: string;
  logik: SteuerlogikLogik;
  jetzt?: Date;
  onGeaendert: () => void;
  boxKannScharf: boolean;
}) {
  const fassung = laufendeFassung(logik);
  const scharf = istScharf(logik);
  const aktiv = logik.fassungen.find((f) => f.fassung === fassung) ?? null;
  const hatVorige = fassung != null && logik.fassungen.some((f) => f.fassung < fassung);
  const [vorschau, setVorschau] = useState<SteuerlogikVorschau | null>(null);
  const [zurueckOffen, setZurueckOffen] = useState(false);
  const quittung = quittungSatz(logik, fassung);
  const lauf = logik.laeufe.find((l) => l.fassung === fassung) ?? logik.laeufe[0] ?? null;
  const r = lauf?.rueckmeldung ?? null;
  const [protokoll, setProtokoll] = useState<SteuerlogikProtokoll | null>(null);
  const [protokollFehler, setProtokollFehler] = useState(false);
  const [neueFassung, setNeueFassung] = useState(false);
  const [stillOffen, setStillOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string[]>([]);

  const ladeProtokoll = () => {
    setProtokollFehler(false);
    api.steuerlogikWechsel(siteId, logik.logikId, tagDerAnlage(jetzt ?? new Date())).then(setProtokoll, () => {
      setProtokoll(null);
      setProtokollFehler(true);
    });
  };

  const schritt = async (fn: () => Promise<unknown>, zu: () => void) => {
    setBusy(true);
    setFehler([]);
    try {
      await fn();
      zu();
      onGeaendert();
    } catch (e) {
      setFehler(ablehnungSaetze(e));
      zu();
    } finally {
      setBusy(false);
    }
  };

  const oeffneScharf = () => {
    setFehler([]);
    api.steuerlogikVorschau(siteId, logik.logikId).then(setVorschau, (e) => setFehler(ablehnungSaetze(e)));
  };

  // Stufe 4: eine Fassung, die der Kunde zur Freigabe vorgelegt hat und die noch nicht scharf war.
  const vorgelegt = logik.fassungen.find((f) => f.vorgelegtAm && !f.scharfAm && f.zustand !== 'scharf') ?? null;

  const stilllegen = async () => {
    setBusy(true);
    setFehler([]);
    try {
      await api.steuerlogikStilllegen(siteId, logik.logikId);
      setStillOffen(false);
      onGeaendert();
    } catch (e) {
      setFehler(ablehnungSaetze(e));
      setStillOffen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="vp-slm-logik" aria-label={logik.name}>
      <header className="vp-slm-logik-kopf">
        <h3>{logik.name}</h3>
        <span className="vp-slm-leise">
          {fassung == null
            ? logik.fassungen[0]?.zustand === 'geprueft' ? `Fassung ${logik.fassungen[0].fassung} gespeichert, läuft nicht` : 'stillgelegt'
            : scharf
              ? `Fassung ${fassung} · scharf${aktiv?.scharfAm ? ` seit ${uhrzeit(aktiv.scharfAm)}` : ''}, die Box schaltet nach ihr`
              : `Fassung ${fassung} · läuft mit, schaltet nichts`}
        </span>
        <span className={`vp-slm-${quittung.ton}`}>{quittung.text}</span>
        {vorgelegt ? (
          <span className="vp-slm-warn">
            Fassung {vorgelegt.fassung} liegt zur Freigabe vor{vorgelegt.vorgelegtVon ? ` (${vorgelegt.vorgelegtVon})` : ''}: in der
            Logik der Anlage scharf schalten.
          </span>
        ) : null}
      </header>
      {fassung != null && !r && <p className="vp-slm-leise">Die Box hat noch keinen Mitlauf gemeldet.</p>}
      {fassung != null && r && (
        <>
          {r.lage && (
            <p>
              <strong>{r.lage.titel}</strong>
              {r.lage.satz ? ` — ${r.lage.satz}` : ''}
            </p>
          )}
          <p className="vp-slm-leise">
            Seit {uhrzeit(r.seit)} · gemeldet {uhrzeit(lauf!.gemeldetAm)}
            {r.fehler > 0 ? ` · ${r.fehler} Ausdrücke heute nicht rechenbar` : ''}
          </p>
          {(r.unbekannt?.length ?? 0) > 0 && (
            <p className="vp-slm-warn">Ohne frischen Wert: {r.unbekannt!.join(', ')}</p>
          )}
          {r.geraete && Object.keys(r.geraete).length > 0 && (
            <div className="vp-slm-tabelle">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Gerät</th>
                    <th scope="col">würde</th>
                    <th scope="col">ist</th>
                    <th scope="col">heute</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(r.geraete).map(([k, g]) => (
                    <tr key={k}>
                      <th scope="row">{g.name ?? k}</th>
                      <td>{standText(g.wunsch)}</td>
                      <td className={g.ist ? undefined : 'vp-slm-leise'}>{standText(g.ist)}</td>
                      <td>
                        {abweichungSatz(g.abweichend_s, g.verglichen_s)}
                        {g.laengste_abweichung_s > 0 && (
                          <span className="vp-slm-leise"> · längstens {dauer(g.laengste_abweichung_s)} am Stück</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {protokoll && (
        <div className="vp-slm-tabelle">
          {protokoll.wechsel.length === 0 ? (
            <p className="vp-slm-leise">Heute noch kein Wechsel.</p>
          ) : (
            <table>
              <caption className="vp-slm-caption">Wechsel heute ({protokoll.wechsel.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Zeit</th>
                  <th scope="col">Gerät</th>
                  <th scope="col">Seite</th>
                  <th scope="col">neu</th>
                  <th scope="col">andere Seite</th>
                  <th scope="col">Lage</th>
                </tr>
              </thead>
              <tbody>
                {protokoll.wechsel.map((w) => (
                  <tr key={`${w.box}-${w.laufSeit}-${w.nr}`}>
                    <td>{uhrzeit(w.t)}</td>
                    <td>{r?.geraete?.[w.geraet]?.name ?? w.geraet}</td>
                    <td>{w.was === 'wunsch' ? 'würde' : 'ist'}</td>
                    <td>{standText(w.neu)}</td>
                    <td>{standText(w.andere)}</td>
                    <td>{w.lage ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {protokollFehler && <p className="vp-slm-fehler" role="alert">Das Protokoll ließ sich nicht laden.</p>}
      {fehler.length > 0 && (
        <ul className="vp-slm-fehler" role="alert">
          {fehler.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      <div className="vp-slm-aktionen">
        <Button variant="outline" size="sm" onClick={ladeProtokoll}>
          {protokoll ? 'Protokoll neu laden' : 'Protokoll heute'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setNeueFassung((o) => !o)} aria-expanded={neueFassung}>
          Neue Fassung
        </Button>
        {fassung != null && !scharf && boxKannScharf && (
          <Button size="sm" onClick={oeffneScharf}>
            Scharf schalten …
          </Button>
        )}
        {hatVorige && (
          <Button variant="outline" size="sm" onClick={() => setZurueckOffen(true)}>
            Zurück zur vorigen Fassung
          </Button>
        )}
        {fassung != null && (
          <Button variant="ghost" size="sm" onClick={() => setStillOffen(true)}>
            Stilllegen
          </Button>
        )}
      </div>
      {fassung != null && !scharf && !boxKannScharf && (
        <p className="vp-slm-leise">Scharf schalten geht erst, wenn die Box steuerlogik_scharf meldet.</p>
      )}
      {neueFassung && (
        <Annahme
          siteId={siteId}
          logikId={logik.logikId}
          titel={`Neue Fassung von „${logik.name}“`}
          knopf={scharf ? 'Prüfen und scharf ablösen' : 'Prüfen und ablösen'}
          scharf={scharf}
          onAngenommen={() => { setNeueFassung(false); onGeaendert(); }}
        />
      )}
      <ConfirmDialog
        open={vorschau != null}
        title={`„${logik.name}“ scharf schalten?`}
        intro={vorschau?.moeglich
          ? `Ab jetzt schaltet die Box nach Fassung ${vorschau.fassung}: ${vorschau.geraete.join(', ')} `
            + `${vorschau.geraete.length === 1 ? 'gehört' : 'gehören'} der Logik.`
          : 'Die Logik kann so nicht scharf gehen.'}
        consequences={vorschau ? [
          ...vorschau.konflikte.map((k) => `Gesperrt: ${k.text}`),
          ...(vorschau.boxKann ? [] : ['Gesperrt: Die Box meldet steuerlogik_scharf nicht.']),
          ...vorschau.hinweise,
          'Fahrplan und Fristen lassen die Geräte in Ruhe; Eingriffe von Hand und die Schutzgrenzen der Box gehen weiter vor.',
          ...(vorschau.kundeStellt.length ? [`Der Kunde stellt selbst: ${vorschau.kundeStellt.join(', ')}.`] : []),
        ] : []}
        confirmLabel="Gelesen, scharf schalten"
        busy={busy}
        confirmDisabled={!vorschau?.moeglich}
        onConfirm={() => vorschau && void schritt(() => api.steuerlogikScharf(siteId, logik.logikId, vorschau.fassung), () => setVorschau(null))}
        onCancel={() => setVorschau(null)}
      />
      <ConfirmDialog
        open={zurueckOffen}
        title={`„${logik.name}“ auf die vorige Fassung zurücknehmen?`}
        intro={scharf
          ? 'Die Box schaltet ab sofort wieder nach der vorigen Fassung.'
          : 'Die vorige Fassung läuft ab sofort wieder mit.'}
        consequences={[
          'Zustände gleichen Namens übernimmt die Box; der Rest beginnt wie nach einem Neustart.',
          'Gestellte Werte, die zur vorigen Fassung nicht passen, fallen auf ihre Vorgabe.',
          'Der Schritt steht im Protokoll.',
        ]}
        confirmLabel="Zurücknehmen"
        busy={busy}
        onConfirm={() => void schritt(() => api.steuerlogikZurueck(siteId, logik.logikId), () => setZurueckOffen(false))}
        onCancel={() => setZurueckOffen(false)}
      />
      <ConfirmDialog
        open={stillOffen}
        title={`„${logik.name}“ stilllegen?`}
        intro={scharf ? 'Die Box hört sofort auf, nach dieser Logik zu schalten.' : 'Die Box hört sofort auf, diese Logik mitlaufen zu lassen.'}
        consequences={scharf ? [
          'Ihre Geräte sind frei: ohne Wunsch gilt ihr Ruhewert, Fahrplan und Steuerart dürfen sie wieder führen.',
          'Eine laufende Mindestlaufzeit hält ein Gerät noch bis zu ihrem Ende an.',
          'Das Protokoll der letzten 90 Tage bleibt lesbar.',
        ] : [
          'Geschaltet wird dadurch nichts anders: die Logik hat nie geschaltet.',
          'Das Protokoll der letzten 90 Tage bleibt lesbar.',
          'Eine neue Fassung lässt sie wieder mitlaufen.',
        ]}
        confirmLabel="Stilllegen"
        busy={busy}
        onConfirm={stilllegen}
        onCancel={() => setStillOffen(false)}
      />
    </article>
  );
}

/** Eine Logik als Text (YAML oder JSON) annehmen: einfügen oder Datei wählen, prüfen lässt der Dienst. */
function Annahme({
  siteId,
  logikId,
  titel,
  knopf,
  scharf = false,
  onAngenommen,
}: {
  siteId: string;
  logikId?: string;
  titel: string;
  knopf: string;
  /** Die neue Fassung löst eine scharfe ab und geht gleich scharf (das Senden bestätigt die Hinweise). */
  scharf?: boolean;
  onAngenommen: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string[]>([]);
  const feld = useRef<HTMLTextAreaElement>(null);
  const datei = useRef<HTMLInputElement>(null);

  const waehle = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setText(await f.text());
    setFehler([]);
  };

  const senden = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!text.trim()) {
      setFehler(['Bitte den Text der Logik einfügen oder eine Datei wählen.']);
      feld.current?.focus();
      return;
    }
    setBusy(true);
    setFehler([]);
    try {
      await api.steuerlogikAnnehmen(siteId, text, logikId, scharf);
      setText('');
      onAngenommen();
    } catch (err) {
      setFehler(ablehnungSaetze(err));
      feld.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="vp-slm-annahme" onSubmit={senden} noValidate>
      <h3>{titel}</h3>
      <label className="vp-field">
        Text der Logik (YAML-Schreibform oder JSON)
        <textarea
          ref={feld}
          className="vp-slm-text"
          rows={8}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={fehler.length > 0}
        />
      </label>
      <input ref={datei} type="file" accept=".yaml,.yml,.json,text/plain,application/json" hidden onChange={waehle} />
      {scharf && (
        <p className="vp-slm-warn">
          Die laufende Fassung ist scharf: die neue geht gleich scharf. Die bisherige Steuerung der Geräte muss aus sein;
          das Portal kann das nicht prüfen.
        </p>
      )}
      {fehler.length > 0 && (
        <ul className="vp-slm-fehler" role="alert">
          {fehler.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      <div className="vp-slm-aktionen">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Wird geprüft …' : knopf}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => datei.current?.click()}>
          Datei wählen
        </Button>
      </div>
    </form>
  );
}
