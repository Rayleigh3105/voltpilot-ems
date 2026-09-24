import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import type { VorgangAnstoss, VorgangAnstossAntwortArt } from '../api';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE } from '../glossar';
import * as W from '../massnahmeWirkung';
import { Ablehnung, Begruendung } from './EnergiezielDialoge';
import { Recht } from './Recht';
import '../pages/Verbesserung.css';

/** Wer antwortet (§5.7): `bleibt` und `neu_kopiert` mit `verbesserung.verwalten`, `neu_bewertet` mit `…abschliessen`. */
const RECHT: Record<VorgangAnstossAntwortArt, string> = {
  bleibt: 'verbesserung.verwalten',
  neu_kopiert: 'verbesserung.verwalten',
  neu_bewertet: 'verbesserung.abschliessen',
};

/** „beibehalten“ verlangt eine Begründung (10–500) — die Kopie bleibt byte-gleich (M5). */
function Beibehalten({ onSenden, onAbbrechen }: { onSenden: (begruendung: string) => Promise<void>; onAbbrechen: () => void }) {
  const id = `vab-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!Z.begruendungOk(text)) {
      setFehler(Z.BEGRUENDUNG_HINWEIS);
      document.getElementById(id)?.focus();
      return;
    }
    setFehler(null);
    setBusy(true);
    setSatz(null);
    try {
      await onSenden(text.trim());
    } catch (e) {
      setSatz(W.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vp-ez-form" noValidate onSubmit={(e) => void senden(e)} data-testid="anstoss-beibehalten-form">
      <Begruendung id={id} wert={text} setze={setText} fehler={fehler} />
      <Ablehnung satz={satz} />
      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      <div className="vp-ez-aktionen">
        <Button type="submit" size="sm" disabled={busy} data-testid="anstoss-beibehalten-senden">
          {W.ANTWORT_KNOPF.bleibt}
        </Button>
        <Button size="sm" variant="ghost" onClick={onAbbrechen}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

/**
 * Die Anstöße am Vorgang (AP-18 IP-20, §5.6, M5, Z5): je Anstoß ein Vermerk mit Art, Anlass und Tag; an einem offenen
 * die Antwort-Knöpfe, die zur Art passen — „beibehalten“ mit Begründung, „neu kopieren“ (nur Ausgangslage), „neu
 * bewerten“ (öffnet den Bewerten-Dialog der Seite). Die Route (IP-17) entscheidet; die Kopie bleibt, bis eine Person
 * antwortet. Ohne Anstoß erscheint die Karte nicht.
 */
export function VerbesserungAnstoesse({
  vorgang,
  anstoesse,
  standort,
  onAntwort,
  onNeuBewerten,
}: {
  vorgang: 'massnahme' | 'energieziel';
  anstoesse: VorgangAnstoss[] | null | undefined;
  standort: string | null;
  /** IP-17-NAHT: `POST …/anstoesse/{aid}/antwort` für `bleibt` und `neu_kopiert`. */
  onAntwort: (a: VorgangAnstoss, antwort: 'bleibt' | 'neu_kopiert', begruendung?: string) => Promise<void>;
  onNeuBewerten: (a: VorgangAnstoss) => void;
}) {
  const [bleibt, setBleibt] = useState<string | null>(null);
  const [satz, setSatz] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!anstoesse || anstoesse.length === 0) return null;

  async function neuKopieren(a: VorgangAnstoss) {
    setBusy(true);
    setSatz(null);
    try {
      await onAntwort(a, 'neu_kopiert');
    } catch (e) {
      setSatz({ id: a.id, text: W.ablehnungSatz(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vp-ez-karte" aria-labelledby={`${vorgang}-anstoesse`} data-testid={`${vorgang}-anstoesse`}>
      <h2 id={`${vorgang}-anstoesse`}>{W.ANSTOESSE}</h2>
      <ul className="vp-ez-verlauf">
        {anstoesse.map((a) => (
          <li key={a.id} data-testid={`anstoss-${a.art}`} data-zustand={a.zustand}>
            <p>
              <strong>{W.ANSTOSS_WORT[a.art]}</strong>
              {W.anstossZeile(a).slice(W.ANSTOSS_WORT[a.art].length)}
            </p>
            {a.antwort_begruendung && <p className="vp-ez-leise">‚{a.antwort_begruendung}‘</p>}
            {a.zustand === 'offen' && (
              <>
                <p className="vp-ez-leise">{W.KOPIE_BLEIBT}</p>
                {bleibt === a.id ? (
                  <Beibehalten
                    onSenden={async (t) => {
                      await onAntwort(a, 'bleibt', t);
                      setBleibt(null);
                    }}
                    onAbbrechen={() => setBleibt(null)}
                  />
                ) : (
                  <div className="vp-ez-aktionen">
                    {W.antworten(vorgang, a.art).map((antwort) => (
                      <Recht key={antwort} aktion={RECHT[antwort]} standort={standort}>
                        <Button
                          size="sm"
                          variant={antwort === 'bleibt' ? 'outline' : 'primary'}
                          disabled={busy}
                          onClick={() =>
                            antwort === 'bleibt' ? setBleibt(a.id) : antwort === 'neu_kopiert' ? void neuKopieren(a) : onNeuBewerten(a)
                          }
                          data-testid={`anstoss-${antwort}`}
                        >
                          {W.ANTWORT_KNOPF[antwort]}
                        </Button>
                      </Recht>
                    ))}
                  </div>
                )}
                {satz?.id === a.id && <Ablehnung satz={satz.text} />}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
