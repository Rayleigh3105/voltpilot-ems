import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { api, type SteuerlogikBlatt, type SteuerlogikLogik, type SteuerlogikProtokoll } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  ablehnungSaetze,
  abweichungSatz,
  dauer,
  laufendeFassung,
  quittungSatz,
  standText,
  tagDerAnlage,
  uhrzeit,
} from '../../steuerlogikMitlauf';
import './SteuerlogikMitlaufBlatt.css';

/**
 * Steuerlogik Stufe 2, zweiter Teil — das Blatt der Plattform: VoltPilot gibt eine Logik als Datei ab, sie läuft auf
 * der Box mit und schaltet nichts. Je Logik die Fassung, die Quittung der Box, die Lage und je Gerät, was sie schalten
 * würde, neben dem, was geschaltet ist; dazu das Protokoll des Tages. NUR hinter `showTechnicalLayer()` (eigener
 * Chunk) — Kundenkonten laden das nie; ihre Oberfläche kommt in den Stufen 3 bis 5.
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
            <LogikKarte key={l.logikId} siteId={siteId} logik={l} jetzt={jetzt} onGeaendert={neuLaden} />
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
}: {
  siteId: string;
  logik: SteuerlogikLogik;
  jetzt?: Date;
  onGeaendert: () => void;
}) {
  const fassung = laufendeFassung(logik);
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
          {fassung != null ? `Fassung ${fassung} · läuft mit, schaltet nichts` : 'stillgelegt'}
        </span>
        <span className={`vp-slm-${quittung.ton}`}>{quittung.text}</span>
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
        {fassung != null && (
          <Button variant="ghost" size="sm" onClick={() => setStillOffen(true)}>
            Stilllegen
          </Button>
        )}
      </div>
      {neueFassung && (
        <Annahme
          siteId={siteId}
          logikId={logik.logikId}
          titel={`Neue Fassung von „${logik.name}“`}
          knopf="Prüfen und ablösen"
          onAngenommen={() => { setNeueFassung(false); onGeaendert(); }}
        />
      )}
      <ConfirmDialog
        open={stillOffen}
        title={`„${logik.name}“ stilllegen?`}
        intro="Die Box hört sofort auf, diese Logik mitlaufen zu lassen."
        consequences={[
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
  onAngenommen,
}: {
  siteId: string;
  logikId?: string;
  titel: string;
  knopf: string;
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
      await api.steuerlogikAnnehmen(siteId, text, logikId);
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
