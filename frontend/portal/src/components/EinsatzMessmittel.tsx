import { useEffect, useState } from 'react';
import { api, type EnergieeinsatzEinstufungFassung, type EnergieeinsatzMessstelle, type MessmittelAngaben } from '../api';
import { UEMS_MESSMITTEL, UEMS_NICHT_ERHOBEN, UEMS_PRUEFAUFGABE } from '../glossar';
import { messmittelSatz, ohneAngabe } from '../uemsMessmittel';

/**
 * UEMS AP-16 IP-18 (§5.4 Nr. 3, G3, R8): die Messmittel der Messstellen eines Energieeinsatzes und die
 * PRÜFAUFGABEN-ZEILE — ein wesentlicher Einsatz, dessen Messmittel ohne Angabe sind, wird zur Prüfaufgabe
 * („Klasse und Prüfung nicht erhoben“). Nichts wird geschätzt. Der Weg: Messstelle → führende Quelle der Hauptgröße
 * (`…/quellen`) → Gerät → `…/geraete/{id}/messmittel`; was nicht erreichbar ist, fällt still weg.
 */
export interface MessmittelAnMessstelle {
  messstelle: string;
  geraet: string;
  angaben: MessmittelAngaben;
}

export async function messmittelDerMessstellen(messstellen: EnergieeinsatzMessstelle[]): Promise<MessmittelAnMessstelle[]> {
  const je = await Promise.all(
    messstellen
      .filter((m) => m.art === 'gemessen')
      .map(async (m) => {
        try {
          const q = await api.messstelleQuellen(m.id);
          const f = (q.groessen.find((g) => g.hauptgroesse) ?? q.groessen[0])?.fuehrend;
          if (!f?.geraet.id) return null;
          const angaben = await api.geraetMessmittel(f.geraet.id);
          return { messstelle: m.kennzeichen, geraet: f.geraet.einbau ?? f.geraet.geraet ?? angaben.kennzeichen, angaben };
        } catch {
          return null;
        }
      }),
  );
  return je.filter((x): x is MessmittelAnMessstelle => x !== null);
}

/** Die wirksame Einstufung: die jüngste freigegebene, nicht beendete Fassung. */
export const istWesentlich = (fassungen: EnergieeinsatzEinstufungFassung[] | undefined) =>
  fassungen?.find((f) => f.freigabe_status === 'freigegeben' && !f.gueltig_bis)?.einstufung === 'wesentlich';

export const pruefaufgabeSatz = (einsatz: string, offen: MessmittelAnMessstelle[]) =>
  `${UEMS_PRUEFAUFGABE} · ${einsatz} (wesentlich): ${UEMS_MESSMITTEL}-Angaben fehlen — ${offen
    .map((o) => `${o.messstelle} · ${o.geraet}: Klasse und Prüfung ${UEMS_NICHT_ERHOBEN}`)
    .join('; ')}. Nichts wird geschätzt; die Angaben stehen am Gerät.`;

/** Die Karte „Messmittel“ auf der Seite eines Energieeinsatzes, mit der Prüfaufgabe, wenn er wesentlich ist. */
export function EinsatzMessmittel({ einsatz, messstellen, wesentlich }: { einsatz: string; messstellen: EnergieeinsatzMessstelle[]; wesentlich: boolean }) {
  const [liste, setListe] = useState<MessmittelAnMessstelle[] | null>(null);
  const schluessel = messstellen.map((m) => m.id).join(',');
  useEffect(() => {
    let aktiv = true;
    setListe(null);
    void messmittelDerMessstellen(messstellen).then((l) => aktiv && setListe(l));
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel]);
  if (!liste || liste.length === 0) return null;
  const offen = liste.filter((l) => ohneAngabe(l.angaben));
  return (
    <section className="vp-bw-karte" aria-labelledby="ee-messmittel" data-testid="einsatz-messmittel">
      <h2 id="ee-messmittel">{UEMS_MESSMITTEL}</h2>
      {wesentlich && offen.length > 0 && (
        <p className="vp-bw-pruefaufgabe" role="note" data-testid="pruefaufgabe">
          {pruefaufgabeSatz(einsatz, offen)}
        </p>
      )}
      <ul className="vp-bw-zeilen">
        {liste.map((l) => (
          <li key={`${l.messstelle}-${l.geraet}`}>{messmittelSatz(`${l.messstelle} · ${l.geraet}`, l.angaben)}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Die Prüfaufgaben-Zeile der Übersicht: je wesentlichem Einsatz mit Messmitteln ohne Angabe ein Satz. Ohne
 * wesentlichen Einsatz oder ohne offene Angabe steht nichts.
 */
export function Pruefaufgaben({ einsaetze }: { einsaetze: { name: string; messstellen: EnergieeinsatzMessstelle[] }[] }) {
  const [saetze, setSaetze] = useState<string[]>([]);
  const schluessel = einsaetze.map((e) => `${e.name}:${e.messstellen.map((m) => m.id).join('+')}`).join(',');
  useEffect(() => {
    let aktiv = true;
    setSaetze([]);
    void Promise.all(
      einsaetze.map(async (e) => {
        const offen = (await messmittelDerMessstellen(e.messstellen)).filter((l) => ohneAngabe(l.angaben));
        return offen.length > 0 ? pruefaufgabeSatz(e.name, offen) : null;
      }),
    ).then((l) => aktiv && setSaetze(l.filter((x): x is string => x !== null)));
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel]);
  if (saetze.length === 0) return null;
  return (
    <ul className="vp-bw-pruefaufgaben" aria-label={`${UEMS_PRUEFAUFGABE}n`} data-testid="pruefaufgaben">
      {saetze.map((s) => (
        <li key={s} className="vp-bw-pruefaufgabe">
          {s}
        </li>
      ))}
    </ul>
  );
}
