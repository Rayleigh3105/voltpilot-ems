import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type VergleichToleranzFassung } from '../api';
import { UEMS_NORMGRENZE, UEMS_TOLERANZ } from '../glossar';
import { laufenderMonat, tagText, toleranzAblehnung, toleranzWert } from '../uemsMessmittel';
import { befundZeilen, messstelleVergleich, monatWort, prozentWort, type BefundZeile, type VergleichQuelle } from '../uemsVergleichToleranz';
import { Recht } from './Recht';
import './VergleichBefund.css';

/**
 * Die Befund-Zeile der Messstellen-Seite (UEMS AP-16 IP-17, G5, E10 = A): je Vergleichsquelle der letzte
 * volle Monat — „passt“, „bitte prüfen“ oder „nicht vergleichbar“. Seit IP-18 trägt jede Zeile „Toleranz ändern“
 * (Recht `messmittel.angaben` am Standort der Messstelle): eine neue Fassung mit Pflicht-Begründung, gültig ab dem
 * laufenden Monat — ein abgeschlossener Monat wird nie anders beurteilt.
 *
 * ⚠ Ohne Vergleichsquelle mit Monatsmenge, bei einem Fehler oder solange nichts geladen ist, steht hier
 * NICHTS — Bestandskunden merken nichts (R11). ⚠ Keine Ursache, kein Ersatz: die Quelle-Karte zeigt die
 * Werte weiter nebeneinander (AP-04 E3); dieser Satz nennt nur Abweichung und Toleranz.
 */
export function VergleichBefund({
  kennzeichen,
  messstelleId,
}: {
  kennzeichen: string;
  /** IP-18: die Messstelle der Toleranz-Route; ohne sie keine Änderung (nur die Zeile). Standort: `RechteStandort`. */
  messstelleId?: string;
}) {
  const [zeilen, setZeilen] = useState<BefundZeile[]>([]);
  const [stand, setStand] = useState(0);
  const [ziel, setZiel] = useState<VergleichQuelle | null>(null);
  const [notiz, setNotiz] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let aktiv = true;
    messstelleVergleich(kennzeichen).then(
      (v) => { if (aktiv) setZeilen(befundZeilen(v)); },
      () => { if (aktiv) setZeilen([]); },
    );
    return () => { aktiv = false; };
  }, [kennzeichen, stand]);
  useEffect(() => setZeilen([]), [kennzeichen]);
  if (zeilen.length === 0) return null;
  return (
    <div className="vp-vgl-block" data-testid="vergleich-befund-block">
      <ul className="vp-vgl" data-testid="vergleich-befund" aria-label="Vergleich mit Vergleichsquellen">
        {zeilen.map((z) => (
          <li key={z.schluessel} className={`vp-vgl-zeile is-${z.zustand}`}>
            <span className="vp-vgl-satz">{z.satz}</span>
            {messstelleId && (
              <Recht aktion="messmittel.angaben">
                <button
                  type="button"
                  className="vp-vgl-knopf"
                  data-testid="toleranz-aendern"
                  onClick={(e) => {
                    ausloeser.current = e.currentTarget;
                    setNotiz(null);
                    setZiel(z.quelle);
                  }}
                >
                  {UEMS_TOLERANZ} ändern
                </button>
              </Recht>
            )}
          </li>
        ))}
      </ul>
      {notiz && (
        <p className="vp-vgl-notiz" role="status" data-testid="toleranz-notiz">
          {notiz}
        </p>
      )}
      {ziel && messstelleId && (
        <ToleranzDialog
          messstelleId={messstelleId}
          quelle={ziel}
          onClose={() => {
            setZiel(null);
            ausloeser.current?.focus();
          }}
          onGespeichert={(f, neu) => {
            setZiel(null);
            setNotiz(neu
              ? `${UEMS_TOLERANZ} ${prozentWort(f.prozent)} gilt ab ${monatWort(f.gilt_ab_monat.slice(0, 7))} (Fassung ${f.fassung}). Abgeschlossene Monate bleiben beurteilt wie bisher; kein Wert ändert sich.`
              : `Die ${UEMS_TOLERANZ} ist unverändert ${prozentWort(f.prozent)} — nichts eingetragen.`);
            setStand((n) => n + 1);
            ausloeser.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * Der Toleranz-Dialog (§5.4 Nr. 4, E10 = A): heutige Fassung, neue Toleranz in Prozent je Monat, Begründung Pflicht.
 * Die Fassung gilt ab dem laufenden Monat — das sagt der Dialog, bevor gesendet wird. Die Toleranz ändert keinen Wert.
 */
export function ToleranzDialog({
  messstelleId,
  quelle,
  onClose,
  onGespeichert,
}: {
  messstelleId: string;
  quelle: VergleichQuelle;
  onClose: () => void;
  onGespeichert: (f: VergleichToleranzFassung, neu: boolean) => void;
}) {
  const basis = `tol-${useId().replace(/:/g, '')}`;
  const letzte = quelle.monate[quelle.monate.length - 1];
  const heute = quelle.toleranz ?? null;
  const heuteProzent = heute?.prozent ?? letzte?.toleranz_prozent ?? '2';
  const [prozent, setProzent] = useState(heuteProzent.replace('.', ','));
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<{ feld: 'prozent' | 'begruendung'; satz: string } | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = quelle.komponente ?? quelle.kanal;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const wert = toleranzWert(prozent);
    if (wert === null) {
      setFehler({ feld: 'prozent', satz: 'Bitte eine Toleranz über 0 und höchstens 100 % angeben, mit höchstens zwei Nachkommastellen.' });
      document.getElementById(`${basis}-prozent`)?.focus();
      return;
    }
    if (!begruendung.trim()) {
      setFehler({ feld: 'begruendung', satz: 'Bitte begründen Sie die neue Toleranz.' });
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setFehler(null);
    setBusy(true);
    setSatz(null);
    try {
      const f = await api.vergleichToleranzEintragen(messstelleId, quelle.quelle_id, { prozent: wert, begruendung: begruendung.trim() });
      onGespeichert(f, f.fassung !== (heute?.fassung ?? letzte?.toleranz_fassung ?? 1));
    } catch (e) {
      setSatz(toleranzAblehnung(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${UEMS_TOLERANZ} ändern`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="toleranz-speichern">
            Eintragen
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-vgl-form" noValidate onSubmit={(e) => void senden(e)} data-testid="toleranz-dialog">
        <p className="vp-vgl-leise">
          Vergleichsquelle <b>{name}</b> ({quelle.zweck}). Heute gilt {prozentWort(heuteProzent)} je Monat
          {heute ? (heute.startwert ? ' — der Startwert.' : ` — Fassung ${heute.fassung} seit ${monatWort(heute.gilt_ab_monat.slice(0, 7))}.`) : '.'}
        </p>
        {heute && !heute.startwert && heute.begruendung && (
          <p className="vp-vgl-leise">
            Begründung der Fassung {heute.fassung}
            {heute.person ? ` (${heute.person.name}${heute.eingetragen_am ? `, ${tagText(heute.eingetragen_am)}` : ''})` : ''}: ‚{heute.begruendung}‘
          </p>
        )}
        <Input
          id={`${basis}-prozent`}
          label={`${UEMS_TOLERANZ} in % je Monat`}
          inputMode="decimal"
          value={prozent}
          onChange={(e) => setProzent(e.target.value)}
          error={fehler?.feld === 'prozent' ? fehler.satz : undefined}
        />
        <label className="vp-vgl-label" htmlFor={`${basis}-begruendung`}>
          Begründung
        </label>
        <textarea
          id={`${basis}-begruendung`}
          className="vp-vgl-textarea"
          value={begruendung}
          onChange={(e) => setBegruendung(e.target.value)}
          rows={3}
          maxLength={500}
          aria-invalid={fehler?.feld === 'begruendung'}
        />
        {fehler?.feld === 'begruendung' && (
          <p className="vp-alert vp-alert-err" role="alert">
            {fehler.satz}
          </p>
        )}
        <p className="vp-vgl-gilt" data-testid="toleranz-gilt-ab">
          Gilt ab {laufenderMonat()} — abgeschlossene Monate bleiben beurteilt wie bisher. Die {UEMS_TOLERANZ} ändert keinen Wert und nennt keine Ursache.
        </p>
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
        <p className="vp-vgl-leise">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
