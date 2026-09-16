import type { MessstelleQuelle, MessstelleQuellenListe } from '../api';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { MS06_ID, quelle, quellenMs06 } from './quelleBindenFixtures';

/**
 * GET …/messstellen/{id}/quellen für die Wirte startansicht und messstelle-seite.
 * Die Hauptgröße kommt aus deren Register-Fixture, der Zählerwechsel MS-06 aus der
 * Quellen-Fixture samt siebenminütiger Lücke. Keine erfundenen Werte oder Vertragsdatei-Imports.
 * Die Nebengrößen des Registers nennen keine eigenen Bindungen und werden hier nicht ergänzt.
 */
export function quellenDerMessstellenBuehne(id: string, stichtag: string): MessstelleQuellenListe {
  if (id === MS06_ID) return zumZeitpunkt(quellenMs06(), stichtag);
  const z = ahrenbergRegister({ stichtag: stichtag.slice(0, 10) }).register.find((m) => m.id === id);
  if (!z) throw new Error(`Messstelle der Bühne fehlt: ${id}`);
  const b = z.quelle.fuehrend;
  let fuehrend: MessstelleQuelle | null = null;
  if (b) {
    if (!z.elektrische_stellung) throw new Error(`Anlage der Quellen-Fixture fehlt: ${id}`);
    fuehrend = {
      ...quelle({
        id: b.id,
        messstelleId: id,
        groesse: z.hauptgroesse.groesse,
        richtung: z.hauptgroesse.richtung,
        rolle: 'fuehrend',
        komponente: b.komponente,
        komponenteName: b.komponente_name ?? b.komponente,
        kanal: b.kanal,
        kanalName: b.kanal_name ?? b.kanal,
        wertart: z.hauptgroesse.wertart === 'Zählerstand' ? 'counter' : 'gauge',
        herleitung: z.hauptgroesse.wertart === 'Zählerstand' ? 'zaehlerstand' : 'momentanwert',
        geraet: b.geraet.geraet,
        einbau: b.geraet.einbau,
        ab: b.gueltig_ab,
        bis: b.gueltig_bis,
      }),
      anlage: z.elektrische_stellung.anlage,
      geraet: b.geraet,
      letzter_wert: z.letzter_wert,
    };
  }
  return {
    messstelle_id: id,
    kennzeichen: z.kennzeichen,
    stichtag,
    groessen: [{
      ...z.hauptgroesse,
      hauptgroesse: true,
      lebenszyklus: z.lebenszyklus,
      fuehrend,
      vergleich: [],
      zeitstrahl: fuehrend ? [{ von: fuehrend.gueltig_ab, bis: fuehrend.gueltig_bis, quelle: fuehrend.id }] : [],
    }],
    quellen: fuehrend ? [fuehrend] : [],
  };
}

/** Die Wechsel-Fixture enthält auch spätere Quellen und Werte: am gewählten Zeitpunkt gelten sie noch nicht. */
function zumZeitpunkt(liste: MessstelleQuellenListe, stichtag: string): MessstelleQuellenListe {
  const jetzt = Date.parse(stichtag);
  const quellen = liste.quellen.map((q): MessstelleQuelle => {
    const status = Date.parse(q.gueltig_ab) > jetzt ? 'geplant'
      : q.gueltig_bis !== null && Date.parse(q.gueltig_bis) <= jetzt ? 'beendet' : 'gilt';
    return {
      ...q,
      status,
      letzter_wert: status === 'gilt' && q.letzter_wert && Date.parse(q.letzter_wert.zeitpunkt) <= jetzt ? q.letzter_wert : null,
    };
  });
  return {
    ...liste,
    stichtag,
    quellen,
    groessen: liste.groessen.map((g) => ({
      ...g,
      fuehrend: quellen.find((q) => q.groesse === g.groesse && q.richtung === g.richtung && q.rolle === 'fuehrend' && q.status === 'gilt') ?? null,
    })),
  };
}
