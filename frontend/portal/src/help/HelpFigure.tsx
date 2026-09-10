import { useState } from 'react';
import { Modal } from '../../designsystem/components/shell/Modal';
import { Icon } from '../../designsystem/components/core/Icon';
import { figureUrl, HELP_FIGURES, type HelpFigure as FigureData } from './figures';

function AnnotatedImage({ figure, eager = false }: { figure: FigureData; eager?: boolean }) {
  const style = eager
    ? figure.width < 600 ? { width: figure.width, maxWidth: '100%', margin: '0 auto' } : undefined
    : { maxWidth: Math.min(figure.width, 600 * figure.width / figure.height), margin: '0 auto' };
  return <div className="vp-help-image" style={style}>
    <img src={figureUrl(figure)} alt={figure.alt} width={figure.width} height={figure.height} loading={eager ? 'eager' : 'lazy'} decoding="async" />
    {figure.callouts.map((point, i) => <span key={i} className="vp-help-marker" aria-hidden="true" style={{ left: `${point.x}%`, top: `${point.y}%` }}>{i + 1}</span>)}
  </div>;
}

function EnlargedFigure({ figure, open, onClose }: { figure: FigureData; open: boolean; onClose: () => void }) {
  return <Modal open={open} title={`Screenshot: ${figure.title}`} onClose={onClose}>
    <div className="vp-help-zoom-content">
      <p className="vp-help-muted">Beispieldaten · Die Nummern gehören zu den Erklärungen unter dem Bild.</p>
      <div className="vp-help-zoom-scroll"><AnnotatedImage figure={figure} eager /></div>
      <ol className="vp-help-callouts">{figure.callouts.map((p, i) => <li key={i}>{p.text}</li>)}</ol>
    </div>
  </Modal>;
}

export function HelpScreenshot({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const figure = HELP_FIGURES[id];
  if (!figure || !figureUrl(figure)) return <p className="vp-help-note">Die Abbildung ist gerade nicht verfügbar. Die Schritte und Erklärungen können Sie weiterhin lesen.</p>;
  return <figure className="vp-help-figure">
    <div className="vp-help-figure-head"><span>{figure.title}</span><span>Beispieldaten</span></div>
    <button type="button" className="vp-help-image-button" aria-label={`Screenshot vergrößern: ${figure.title}`} onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}>
      <AnnotatedImage figure={figure} />
      <span className="vp-help-enlarge"><Icon name="search" size={14} />Vergrößern</span>
    </button>
    <figcaption><ol className="vp-help-callouts">{figure.callouts.map((p, i) => <li key={i}>{p.text}</li>)}</ol></figcaption>
    <EnlargedFigure figure={figure} open={open} onClose={() => setOpen(false)} />
  </figure>;
}
