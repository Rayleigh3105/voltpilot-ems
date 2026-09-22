import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type BewertungMessabdeckungOrt,
  type Energieeinsatz,
  type Messbedarf,
  type Messstelle,
  type MessstelleRegisterZeile,
  type OrtsbaumAmStichtag,
  type StandorteAmStichtag,
} from '../api';
import { laeuft } from '../bewertung';
import { UEMS_NORMGRENZE } from '../glossar';
import { groesseOptionen, ortHinweis, ortOptionen, ortWahlen, richtungOptionen, type OrtWahl } from '../messstelleDialog';
import {
  bedarfAnfrage,
  bedarfeSortiert,
  bedarfPruefen,
  bedarfSatz,
  bedarfUnter,
  einsatzOptionen,
  groesseVorbelegung,
  kannEinloesen,
  leererBedarf,
  MESSBEDARF_ZUSTAND,
  messbedarfAblehnung,
  MESSPLANUNG,
  nachStandort,
  restVorbelegung,
  type BedarfEingabe,
} from '../uemsMessplanung';
import { MessstelleDialog } from './MessstelleDialog';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './Messplanung.css';

/**
 * Messplanung (UEMS AP-16 IP-20, §5.3 Schritte 1–3, R5): Messbedarf erfassen, einlösen, verwerfen — an der Seite eines
 * Energieeinsatzes ({@link MessbedarfKarte}) und je Standort in der Welt Bewertung ({@link MessplanungStandorte}).
 * Einlösen springt in den ECHTEN Messstellen-Dialog (AP-04) mit Ort und Größe vorbelegt; sobald er eine eingerichtete
 * Messstelle meldet, löst die Karte den Bedarf mit ihr ein — das Kennzeichen steht danach am Bedarf.
 *
 * ⚠ Schreibknöpfe nur mit `energieeinsatz.verwalten` aus `/me` (der Wirt reicht `verwalten`); lesende Rollen sehen die
 * Liste und einen Satz. ⚠ Verworfen bleibt lesbar; eine Messstelle ohne Quelle heißt „keine Datenquelle“, nie 0.
 */

/** Standorte mit ihren Ortsbäumen — die Orte des Pickers und die Zuordnung Kurzzeichen → Standort. */
export function useOrte(): { standorte: StandorteAmStichtag | null; orte: OrtWahl[] } {
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [baeume, setBaeume] = useState<Record<string, OrtsbaumAmStichtag>>({});
  useEffect(() => {
    let aktiv = true;
    api.standorte().then(
      (s) => {
        if (!aktiv) return;
        setStandorte(s);
        for (const st of s.standorte.filter((x) => x.zustand !== 'archiviert')) {
          api.standortOrte(st.id).then(
            (b) => aktiv && setBaeume((alt) => ({ ...alt, [st.id]: b })),
            () => undefined,
          );
        }
      },
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, []);
  const orte = useMemo(() => (standorte ? ortWahlen(standorte, baeume) : []), [standorte, baeume]);
  return { standorte, orte };
}

// ------------------------------------------------------------------ Karte am Einsatz

export function MessbedarfKarte({ einsatz, verwalten }: { einsatz: Energieeinsatz; verwalten: boolean }) {
  const { orte } = useOrte();
  const [bedarfe, setBedarfe] = useState<Messbedarf[] | null>(null);
  const [register, setRegister] = useState<MessstelleRegisterZeile[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ art: 'erfassen' } | { art: 'einrichten' | 'verwerfen'; bedarf: Messbedarf } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const schreiben = verwalten && laeuft(einsatz);

  useEffect(() => {
    let aktiv = true;
    api.messbedarfe(einsatz.id).then(
      (l) => {
        if (!aktiv) return;
        setBedarfe(l.messbedarfe);
        setFehler(null);
        // Nur für eingelöste Bedarfe: die Beobachtung ihrer Messstelle („keine Datenquelle seit …“).
        if (l.messbedarfe.some((b) => b.messstelle))
          api.messstellenRegister().then((r) => aktiv && setRegister(r.register), () => undefined);
      },
      (e) => aktiv && setFehler(messbedarfAblehnung(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [einsatz.id, versuch]);

  const ersetze = (b: Messbedarf) => {
    setBedarfe((alt) => [...(alt ?? []).filter((x) => x.id !== b.id), b]);
    setVersuch((v) => v + 1);
  };

  return (
    <section className="vp-bw-karte vp-mp" aria-labelledby="ee-messplanung" data-testid="messplanung-einsatz">
      <div className="vp-bw-karte-kopf">
        <h2 id="ee-messplanung">{MESSPLANUNG.titel}</h2>
        {schreiben && (
          <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={() => setDialog({ art: 'erfassen' })} data-testid="messbedarf-erfassen-knopf">
            {MESSPLANUNG.erfassen}
          </Button>
        )}
      </div>
      {hinweis && (
        <p className="vp-alert vp-alert-err" role="alert" data-testid="messbedarf-hinweis">
          {hinweis}
        </p>
      )}
      {fehler ? (
        <p className="vp-bw-leise" role="status">{fehler}</p>
      ) : bedarfe === null ? (
        <p className="vp-bw-leise">Messbedarf wird geladen …</p>
      ) : bedarfe.length === 0 ? (
        <p className="vp-bw-leise" data-testid="messplanung-leer">{MESSPLANUNG.leer}</p>
      ) : (
        <ul className="vp-mp-liste" data-testid="messbedarf-liste">
          {bedarfeSortiert(bedarfe).map((b) => (
            <BedarfZeile key={b.id} bedarf={b} orte={orte} register={register}>
              {schreiben && b.zustand === 'offen' && (
                <span className="vp-bw-aktionen">
                  <Button size="sm" onClick={() => setDialog({ art: 'einrichten', bedarf: b })} data-testid="messbedarf-einrichten-knopf">
                    {MESSPLANUNG.einrichten}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ art: 'verwerfen', bedarf: b })} data-testid="messbedarf-verwerfen-knopf">
                    {MESSPLANUNG.verwerfen}
                  </Button>
                </span>
              )}
            </BedarfZeile>
          ))}
        </ul>
      )}
      {!verwalten && <p className="vp-bw-leise">{MESSPLANUNG.nurLesen}</p>}
      {verwalten && !laeuft(einsatz) && <p className="vp-bw-leise">{MESSPLANUNG.beendet}</p>}
      <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>

      {dialog?.art === 'erfassen' && (
        <MessbedarfErfassenDialog
          einsaetze={[einsatz]}
          vorbelegung={{ einsatzId: einsatz.id }}
          onClose={() => setDialog(null)}
          onErfasst={(b) => {
            setDialog(null);
            ersetze(b);
          }}
        />
      )}
      {dialog?.art === 'verwerfen' && (
        <MessbedarfVerwerfenDialog
          bedarf={dialog.bedarf}
          onClose={() => setDialog(null)}
          onVerworfen={(b) => {
            setDialog(null);
            ersetze(b);
          }}
        />
      )}
      {dialog?.art === 'einrichten' && (
        <MessbedarfEinloesen
          bedarf={dialog.bedarf}
          onClose={() => setDialog(null)}
          onEingeloest={(b) => {
            setHinweis(null);
            ersetze(b);
          }}
          onFehler={setHinweis}
        />
      )}
    </section>
  );
}

function BedarfZeile({
  bedarf: b,
  orte,
  register,
  einsatz,
  children,
}: {
  bedarf: Messbedarf;
  orte: readonly OrtWahl[];
  register: readonly MessstelleRegisterZeile[];
  einsatz?: { text: string; onOeffnen: () => void } | null;
  children?: ReactNode;
}) {
  const satz = bedarfSatz(b, register);
  return (
    <li className={`vp-mp-zeile is-${b.zustand}`} data-testid={`messbedarf-${b.kennzeichen}`}>
      <span className="vp-mp-kopf">
        <span className="vp-bw-kz">{b.kennzeichen}</span>
        <Badge variant={b.zustand === 'offen' ? 'warn' : b.zustand === 'eingeloest' ? 'ok' : 'off'} data-testid="messbedarf-zustand">
          {MESSBEDARF_ZUSTAND[b.zustand]}
        </Badge>
        {b.zustand === 'eingeloest' && b.messstelle && <span className="vp-bw-kz" data-testid="messbedarf-messstelle">{b.messstelle.kennzeichen}</span>}
      </span>
      <span className="vp-mp-wortlaut">{b.wortlaut}</span>
      <span className="vp-bw-leise">{bedarfUnter(b, orte)}</span>
      {einsatz && (
        <button type="button" className="vp-mp-einsatz" onClick={einsatz.onOeffnen} data-testid="messbedarf-zum-einsatz">
          {einsatz.text}
          <Icon name="chevron-right" size={14} />
        </button>
      )}
      {satz && <span className="vp-mp-satz" data-testid="messbedarf-satz">{satz}</span>}
      {children}
    </li>
  );
}

// ------------------------------------------------------------------ Einlösen

/**
 * Der Sprung in den Messstellen-Dialog: angelegt mit Ort und Größe des Bedarfs. Jeder Schritt meldet die Messstelle;
 * die erste EINGERICHTETE (nichts fehlt) löst den Bedarf ein — genau einmal. Schließt jemand vorher, bleibt der Bedarf
 * offen und die angelegte Messstelle ein Entwurf im Register.
 */
function MessbedarfEinloesen({
  bedarf,
  onClose,
  onEingeloest,
  onFehler,
}: {
  bedarf: Messbedarf;
  onClose: () => void;
  onEingeloest: (b: Messbedarf) => void;
  onFehler: (satz: string) => void;
}) {
  // Eine Ref, kein State: der Dialog meldet Ort und Stellung im SELBEN Lauf nacheinander (`merke` zweimal).
  const stand = useRef<'offen' | 'laeuft' | 'eingeloest'>('offen');
  const vorbelegung = useMemo(() => ({ ort: bedarf.ort, hauptgroesse: groesseVorbelegung(bedarf.groesse) }), [bedarf.ort, bedarf.groesse]);

  function gespeichert(m: Messstelle) {
    if (stand.current !== 'offen' || !kannEinloesen(m)) return;
    stand.current = 'laeuft';
    api.messbedarfEinloesen(bedarf.energieeinsatz_id, bedarf.id, m.id).then(
      (b) => {
        stand.current = 'eingeloest';
        onEingeloest(b);
      },
      (e) => {
        stand.current = 'offen';
        onFehler(messbedarfAblehnung(e));
      },
    );
  }

  return <MessstelleDialog open vorbelegung={vorbelegung} onClose={onClose} onGespeichert={gespeichert} />;
}

// ------------------------------------------------------------------ Erfassen

export function MessbedarfErfassenDialog({
  einsaetze,
  vorbelegung,
  rest = null,
  onClose,
  onErfasst,
}: {
  /** Ein Einsatz: am Einsatz erfasst; mehrere: aus der Rest-Zeile, der Einsatz wird gewählt. */
  einsaetze: readonly Energieeinsatz[];
  vorbelegung?: Partial<BedarfEingabe>;
  /** Aus der Rest-Zeile einer Anlage: Wortlaut mit dem Rest, Ort = Standort der Anlage (sobald bekannt). */
  rest?: BewertungMessabdeckungOrt | null;
  onClose: () => void;
  onErfasst: (b: Messbedarf) => void;
}) {
  const basis = `mb-${useId().replace(/:/g, '')}`;
  const { standorte, orte } = useOrte();
  const fest = einsaetze.length === 1 ? einsaetze[0] : null;
  const [e, setE] = useState<BedarfEingabe>(() =>
    leererBedarf(fest?.id ?? '', { ...(rest ? restVorbelegung(rest, null) : {}), ...vorbelegung }),
  );
  const [ortBeruehrt, setOrtBeruehrt] = useState(false);
  useEffect(() => {
    if (!rest || !standorte || ortBeruehrt) return;
    const ort = restVorbelegung(rest, standorte).ort;
    if (ort) setE((x) => (x.ort ? x : { ...x, ort }));
  }, [rest, standorte, ortBeruehrt]);
  const [versucht, setVersucht] = useState(false);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fehler = versucht ? bedarfPruefen(e) : {};
  const ort = orte.find((o) => o.kurzzeichen === e.ort) ?? null;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    setVersucht(true);
    const f = bedarfPruefen(e);
    const erster = (['einsatz', 'wortlaut', 'frist'] as const).find((k) => f[k]);
    if (erster) {
      document.getElementById(`${basis}-${erster}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onErfasst(await api.messbedarfErfassen(e.einsatzId, bedarfAnfrage(e)));
    } catch (err) {
      setSatz(messbedarfAblehnung(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={MESSPLANUNG.erfassen}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {MESSPLANUNG.abbrechen}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy}>
            {MESSPLANUNG.erfassen}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(ev) => void senden(ev)} data-testid="messbedarf-erfassen">
        {fest ? (
          <p className="vp-bw-leise">
            {fest.kennzeichen} {fest.name}
          </p>
        ) : (
          <VpPicker
            id={`${basis}-einsatz`}
            label="Energieeinsatz"
            options={einsatzOptionen(einsaetze)}
            value={e.einsatzId}
            onChange={(v) => setE((x) => ({ ...x, einsatzId: v }))}
            placeholder="Energieeinsatz wählen"
            error={fehler.einsatz}
          />
        )}
        <Input
          id={`${basis}-wortlaut`}
          label="Was soll gemessen werden?"
          value={e.wortlaut}
          onChange={(ev) => setE((x) => ({ ...x, wortlaut: ev.target.value }))}
          error={fehler.wortlaut}
        />
        <VpPicker
          id={`${basis}-ort`}
          label="Ort (optional)"
          options={ortOptionen(orte)}
          value={e.ort}
          onChange={(v) => {
            setOrtBeruehrt(true);
            setE((x) => ({ ...x, ort: v }));
          }}
          placeholder="ohne Ort"
          hint={ort ? ortHinweis(ort, '') : undefined}
          search="auto"
        />
        <VpPicker
          id={`${basis}-groesse`}
          label="Größe (optional)"
          options={groesseOptionen()}
          value={e.groesse}
          onChange={(v) => setE((x) => ({ ...x, groesse: v, richtung: richtungOptionen(v).length === 1 ? richtungOptionen(v)[0].value : '' }))}
          placeholder="ohne Größe"
        />
        {e.groesse && richtungOptionen(e.groesse).length > 1 && (
          <VpPicker
            id={`${basis}-richtung`}
            label="Richtung"
            options={richtungOptionen(e.groesse)}
            value={e.richtung}
            onChange={(v) => setE((x) => ({ ...x, richtung: v }))}
            placeholder="Richtung wählen"
          />
        )}
        <VpDatePicker id={`${basis}-frist`} label="Frist (optional)" value={e.frist || null} onChange={(v) => setE((x) => ({ ...x, frist: v }))} error={fehler.frist} />
        <p className="vp-bw-leise">{MESSPLANUNG.erfassenSatz}</p>
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ Verwerfen

export function MessbedarfVerwerfenDialog({ bedarf, onClose, onVerworfen }: { bedarf: Messbedarf; onClose: () => void; onVerworfen: (b: Messbedarf) => void }) {
  const basis = `mv-${useId().replace(/:/g, '')}`;
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!begruendung.trim()) {
      setZeigen('Bitte begründen Sie, warum der Bedarf verworfen wird.');
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onVerworfen(await api.messbedarfVerwerfen(bedarf.energieeinsatz_id, bedarf.id, begruendung.trim()));
    } catch (err) {
      setSatz(messbedarfAblehnung(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${bedarf.kennzeichen} verwerfen`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {MESSPLANUNG.abbrechen}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy}>
            {MESSPLANUNG.verwerfen}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(ev) => void senden(ev)} data-testid="messbedarf-verwerfen">
        <p className="vp-bw-leise">{bedarf.wortlaut}</p>
        <Input
          id={`${basis}-begruendung`}
          label="Begründung"
          value={begruendung}
          onChange={(ev) => {
            setBegruendung(ev.target.value);
            setZeigen(null);
          }}
          error={zeigen}
        />
        <p className="vp-bw-leise">{MESSPLANUNG.verwerfenSatz}</p>
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ Liste je Standort

/**
 * Die Messbedarfe aller Energieeinsätze, gruppiert nach dem Standort ihres Orts (ohne Ort: eine eigene Gruppe). Lesen
 * über die Einsatz-Route je Einsatz — eine Standort-Route gibt es nicht. Handeln geschieht am Einsatz (Sprung).
 */
export function MessplanungStandorte({
  einsaetze,
  version,
  onOeffnen,
}: {
  einsaetze: readonly Energieeinsatz[];
  version: number;
  onOeffnen: (einsatzId: string) => void;
}) {
  const { orte } = useOrte();
  const [bedarfe, setBedarfe] = useState<Messbedarf[] | null>(null);
  const [register, setRegister] = useState<MessstelleRegisterZeile[]>([]);
  const ids = einsaetze.map((e) => e.id).join(',');

  useEffect(() => {
    let aktiv = true;
    Promise.all(einsaetze.map((e) => api.messbedarfe(e.id).then((l) => l.messbedarfe, () => [] as Messbedarf[]))).then((l) => {
      if (!aktiv) return;
      const alle = l.flat();
      setBedarfe(alle);
      if (alle.some((b) => b.messstelle)) api.messstellenRegister().then((r) => aktiv && setRegister(r.register), () => undefined);
    });
    return () => {
      aktiv = false;
    };
    // `ids` fasst die Einsätze; `einsaetze` selbst ist je Render ein neues Feld.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version]);

  if (!bedarfe) return null;
  const gruppen = nachStandort(bedarfe, einsaetze, orte);
  return (
    <section className="vp-bw-karte vp-mp" aria-labelledby="bw-messplanung" data-testid="messplanung-standorte">
      <h2 id="bw-messplanung">{MESSPLANUNG.titel}</h2>
      {gruppen.length === 0 ? (
        <p className="vp-bw-leise">{MESSPLANUNG.leerStandorte}</p>
      ) : (
        gruppen.map((g) => (
          <div key={g.schluessel || 'ohne'} className="vp-mp-gruppe" data-testid={`messplanung-standort-${g.name}`}>
            <h3 className="vp-mp-gruppe-titel">{g.name}</h3>
            <ul className="vp-mp-liste">
              {g.bedarfe.map(({ bedarf, einsatz }) => (
                <BedarfZeile
                  key={bedarf.id}
                  bedarf={bedarf}
                  orte={orte}
                  register={register}
                  einsatz={einsatz ? { text: `${einsatz.kennzeichen} ${einsatz.name}`, onOeffnen: () => onOeffnen(einsatz.id) } : null}
                />
              ))}
            </ul>
          </div>
        ))
      )}
      <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
