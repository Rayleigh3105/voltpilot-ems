import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { kennungSendbar, pruefeKennung } from '../edgeRef';
import { kennungWieGedruckt, merkeKoppelRef } from '../koppelLink';
import { EMPFANG, UNLESBAR } from '../koppelTexte';
import { BoxUnterseite, KennungKachel } from './KoppelKachel';
import { KennungFeld } from './KennungFeld';

/**
 * Die öffentliche Empfangsseite nach dem Scan (Konzept vp-qr-einstieg, QE-1 A, M1 und M2). Erscheint nur
 * ohne Sitzung; wer angemeldet ist, kommt direkt weiter. Sie fragt den Server nichts und zeigt nur, was
 * im Code steht: die Kennung (aus dem Speicher dieses Browsers, `koppelLink.ts`). Eigenes, nachgeladenes
 * Stück (Bündel-Wächter `test/bundle-smoke.sh`).
 */
export function KoppelEmpfang({
  kennung,
  onKontoErstellen,
  onAnmelden,
}: {
  /** Die gemerkte Referenz; null = der Code war nicht lesbar (M2). */
  kennung: string | null;
  onKontoErstellen: () => void;
  onAnmelden: () => void;
}) {
  const [ref, setRef] = useState(kennung);
  if (!ref) return <CodeUnlesbar onKennung={setRef} onAnmelden={onAnmelden} />;
  return (
    <section className="vp-koppel-seite" aria-labelledby="koppel-empfang-titel">
      <span className="vp-koppel-kicker">{EMPFANG.kicker}</span>
      <h1 id="koppel-empfang-titel">{EMPFANG.titel}</h1>
      <p className="vp-koppel-klein">{EMPFANG.einleitung}</p>
      <KennungKachel kennung={ref} titel={EMPFANG.kennungTitel} zeile={EMPFANG.kennungZeile} />
      <div>
        <h3>{EMPFANG.schritteTitel}</h3>
        <ol className="vp-koppel-schritte">
          {EMPFANG.schritte.map((s, i) => (
            <li key={s.titel}>
              <span className="vp-koppel-nummer" aria-hidden="true">{i + 1}</span>
              <div>
                <b>{s.titel}</b>
                <span>{s.zeile}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>{EMPFANG.bereitTitel}</h3>
        <ul className="vp-koppel-liste">
          {EMPFANG.bereit.map((b) => (
            <li key={b}>
              <Icon name="check" size={14} strokeWidth={3} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="vp-koppel-handlung">
        <Button variant="primary" size="lg" fullWidth onClick={onKontoErstellen}>
          {EMPFANG.kontoErstellen}
        </Button>
        <Button variant="outline" size="lg" fullWidth onClick={onAnmelden}>
          {EMPFANG.schonKonto}
        </Button>
      </div>
      <p className="vp-koppel-klein">{EMPFANG.zusage}</p>
      <p className="vp-koppel-klein">{EMPFANG.amComputer}</p>
    </section>
  );
}

/** M2: Das Prüfzeichen im Link stimmte nicht. Das Feld rechnet nur das Prüfzeichen, ohne Server. */
function CodeUnlesbar({ onKennung, onAnmelden }: { onKennung: (ref: string) => void; onAnmelden: () => void }) {
  const [wert, setWert] = useState('');
  const [abgeschickt, setAbgeschickt] = useState(false);
  const feld = useRef<HTMLInputElement>(null);
  const pruefung = pruefeKennung(wert);
  // Nur eine Box-Kennung („edge-…“) steht auf dem Gehäuse; eine Register-Kennung gehört nicht hierher.
  const gueltig = kennungSendbar(pruefung) && pruefung.zustand === 'gueltig';
  function weiter() {
    if (!gueltig) {
      setAbgeschickt(true);
      feld.current?.focus();
      return;
    }
    merkeKoppelRef(pruefung.kennung);
    onKennung(pruefung.kennung);
  }
  return (
    <section className="vp-koppel-seite" aria-labelledby="koppel-unlesbar-titel">
      <span className="vp-koppel-kicker">{EMPFANG.kicker}</span>
      <h1 id="koppel-unlesbar-titel">{UNLESBAR.titel}</h1>
      <p className="vp-koppel-klein">{UNLESBAR.erklaerung}</p>
      <BoxUnterseite gedruckt={gueltig ? kennungWieGedruckt(pruefung.kennung) : null} titel={UNLESBAR.zeichnung} />
      <form
        className="vp-koppel-handlung"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          weiter();
        }}
      >
        <KennungFeld ref={feld} id="koppel-kennung" wert={wert} onWert={setWert} abgeschickt={abgeschickt} />
        <p className="vp-koppel-klein">{UNLESBAR.feldHinweis}</p>
        <Button type="submit" variant="primary" size="lg" fullWidth>
          {UNLESBAR.weiter}
        </Button>
        <Button type="button" variant="ghost" size="lg" fullWidth onClick={onAnmelden}>
          {UNLESBAR.ohneBox}
        </Button>
      </form>
    </section>
  );
}
