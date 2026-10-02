package com.voltpilot.api.mispel;

import java.time.YearMonth;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-16: liest die gespeicherten Läufe der Abgrenzungsoption einer Anlage (unter RLS) und gibt sie an den reinen
 * Nachweis ({@link MispelNachweis}, {@link MispelNachweisPdf}). Gerechnet wird hier nichts — die Werte sind die des
 * Rechenwerks (MP-8), geprüft über ihre Prüfsumme.
 */
@Service
public class MispelNachweisService {

    /** Der früheste Kalendermonat, in dem die Festlegung gilt (Beschluss 01.10.2026). */
    public static final YearMonth AB = YearMonth.of(2026, 10);

    private final MispelAbgrenzungRepository laeufe;

    public MispelNachweisService(MispelAbgrenzungRepository laeufe) {
        this.laeufe = laeufe;
    }

    public MispelNachweis.Monat monat(UUID siteId, YearMonth monat) {
        if (monat.isBefore(AB)) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab " + AB + ".");
        }
        return MispelNachweis.monat(siteId, monat, laeufe.desMonats(siteId, monat.atDay(1)));
    }

    public MispelNachweis.Jahr jahr(UUID siteId, int jahr) {
        if (jahr < AB.getYear() || jahr > 9999) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab " + AB + ".");
        }
        return MispelNachweis.jahr(siteId, jahr, laeufe.desJahres(siteId, jahr));
    }
}
