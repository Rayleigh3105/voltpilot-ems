import { useEffect, useMemo, useState } from 'react';
import { api, type Bericht } from './api';
import { bewertungZeitraum } from './bewertung';
import { bewertungWaehlen, darfBewertung } from './bewertungStand';
import { useRollen } from './rollen';

/**
 * Die Datengrundlage der energetischen Bewertung für Rangliste und Messabdeckung (Konzept Auswerten a1, Befund 2): mit
 * `bewertung.abrufen` liest der Hook die Berichte und nimmt den Zeitraum der gültigen Bewertung; ohne das Recht oder ohne
 * Bewertung gelten die zwölf vollen Monate bis zum Vormonat (`bewertungZeitraum`). `bereit` erst, wenn feststeht,
 * welcher Zeitraum gilt (Selbstauskunft da, Berichte gelesen) - sonst lüde die Rangliste zweimal. `version` lädt die
 * Berichte neu (nach einer Freigabe).
 */
export function useBewertungZeitraum(version = 0) {
  const { selbst } = useRollen();
  const abrufen = darfBewertung(selbst);
  const [lage, setLage] = useState<{ berichte: Bericht[] | null; geladen: boolean }>({ berichte: null, geladen: false });
  useEffect(() => {
    if (!abrufen) return;
    let aktiv = true;
    // Scheitert die Liste, fehlt nur der Bewertungsstand - der Zeitraum fällt auf die zwölf vollen Monate zurück.
    api.berichte().then(
      (r) => aktiv && setLage({ berichte: r.berichte, geladen: true }),
      () => aktiv && setLage({ berichte: null, geladen: true }),
    );
    return () => {
      aktiv = false;
    };
  }, [abrufen, version]);
  const berichte = abrufen ? lage.berichte : null;
  const bericht = bewertungWaehlen(berichte);
  const zeitraum = useMemo(() => bewertungZeitraum(bericht), [bericht]);
  return { abrufen, berichte, bereit: selbst != null && (!abrufen || lage.geladen), zeitraum };
}
