import React from 'react';
import ReactDOM from 'react-dom/client';
import { Modal } from '../designsystem/components/shell/Modal';
import { Button } from '../designsystem/components/core/Button';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Wegwerf-Harness für den Browser-Beweis des zentrierten `Modal`
 * (Captain-Entscheid 04.09.2026 „Every Sidebar should be a modal.").
 *
 * Sie zeigt genau die drei Lagen, die eine Seitenleiste nie hatte und die
 * eine echte Kundenfläche nicht zuverlässig nebeneinander stellt: eine kurze
 * Fläche, eine LANGE (der Körper muss innen scrollen) und ein GESTAPELTES
 * Paar (Escape darf nur das obere treffen). Fachlogik gibt es hier keine.
 */
function Harness() {
  const [kurz, setKurz] = React.useState(false);
  const [lang, setLang] = React.useState(false);
  const [unten, setUnten] = React.useState(false);
  const [oben, setOben] = React.useState(false);

  return (
    <div style={{ padding: 24, display: 'flex', gap: 12, flexWrap: 'wrap', minHeight: '200vh' }}>
      <Button id="btn-kurz" onClick={() => setKurz(true)}>Kurz</Button>
      <Button id="btn-lang" onClick={() => setLang(true)}>Lang</Button>
      <Button id="btn-stapel" onClick={() => { setUnten(true); setOben(true); }}>Stapel</Button>

      <Modal
        open={kurz}
        onClose={() => setKurz(false)}
        title="Gerät hinzufügen"
        footer={<><Button variant="ghost" onClick={() => setKurz(false)}>Abbrechen</Button><Button onClick={() => setKurz(false)}>Speichern</Button></>}
      >
        <p>Eine kurze Fläche mit zwei Aktionen im Fuß.</p>
        <input aria-label="Geräte-ID" placeholder="VP-…" />
      </Modal>

      <Modal
        open={lang}
        onClose={() => setLang(false)}
        title="Detailansicht mit langem Inhalt"
        footer={<Button onClick={() => setLang(false)}>Schließen</Button>}
      >
        {Array.from({ length: 40 }, (_, i) => (
          <p key={i} data-zeile={i}>Zeile {i + 1} — der Körper scrollt innen, die Seite dahinter nicht.</p>
        ))}
      </Modal>

      <Modal open={unten} onClose={() => setUnten(false)} title="Unteres Modal">
        <p>Das untere Modal des Stapels.</p>
      </Modal>
      <Modal open={oben} onClose={() => setOben(false)} title="Oberes Modal">
        <p>Escape trifft nur mich.</p>
      </Modal>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
