import { Fragment } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { bereichBild, type Bereich, type FristBild } from '../wiedervorlage';
import './Wiedervorlage.css';

/** Kennzeichen wie BR-2029-0002, K-2028-0001, BB-0002, MB-1: sie brechen nie am Bindestrich um. */
const KENNZEICHEN = /([A-Z]{1,3}-\d{4}-\d{4,9}|[A-Z]{1,3}-\d{1,9})/g;

/** Ein Satz, in dem jedes Kennzeichen zusammenbleibt; der Text bleibt Zeichen für Zeichen derselbe. */
export function Kennzeichentext({ text }: { text: string }) {
  const teile = text.split(KENNZEICHEN);
  return (
    <>
      {teile.map((t, i) =>
        i % 2 === 1 ? (
          <span key={i} className="vp-kz-nw">
            {t}
          </span>
        ) : (
          <Fragment key={i}>{t}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Der Datumsblock einer Frist (Konzept Wiedervorlage w1): das kleine Wort („seit“, „heute“, „bis“, „ab“, „am“) über Tag
 * und Jahr; Warnton nur bei Überfälligem, gestrichelt im Jahresplan, grün bei Erledigtem. Vorleser hören den ganzen Satz
 * („fällig seit 13.11.2027“), die Teile sind Bild.
 */
export function FristDatum({
  wort,
  tag,
  jahr,
  satz,
  ton,
}: Pick<FristBild, 'wort' | 'tag' | 'jahr' | 'satz'> & { ton: 'ueber' | 'bald' | 'erledigt' | 'plan' }) {
  return (
    <span className={`vp-fd${ton === 'bald' ? '' : ` is-${ton}`}`} role="img" aria-label={satz}>
      <small aria-hidden="true">{wort}</small>
      <b aria-hidden="true">{tag}</b>
      <span aria-hidden="true">{jahr}</span>
    </span>
  );
}

/** Der Bereich einer Frist mit dem Zeichen der Navigation: so lernt man, wo die Arbeit liegt. */
export function Bereichsmarke({ bereich }: { bereich: Bereich }) {
  const b = bereichBild(bereich);
  return (
    <span className="vp-bm">
      <Icon name={b.icon} size={13} />
      {b.wort}
    </span>
  );
}
