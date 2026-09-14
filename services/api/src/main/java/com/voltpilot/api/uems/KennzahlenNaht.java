package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.SQLException;
import org.springframework.stereotype.Component;

/**
 * Die Anschlussstelle der Korrektur-Kaskade für die KENNZAHLEN (AP-08 IP-17, E9 → AP-11) — benannt und LEER.
 *
 * <p>E9 verlangt, dass nach einer freigegebenen Korrektur auch die Kennzahlen des betroffenen Zeitraums neu gebildet
 * werden und ihre Version tragen (AP-08 §6.3: „AP-11 hält seine Formelversion getrennt davon“). AP-11 gibt es noch
 * nicht. Darum steht hier nur die Naht: die Kaskade ruft sie nach allen Stufen und den berechneten Messstellen in
 * DERSELBEN Transaktion — wer AP-11 baut, ersetzt {@link Keine} und bildet dort seine Kennzahlen. Kein Vorgriff: diese
 * Datei rechnet nichts, speichert nichts und kennt keine Kennzahl.
 */
public interface KennzahlenNaht {

    /**
     * Nach einer Freigabe, einer Rücknahme oder einem Ersatzwert: was die Kaskade eben neu gebildet hat.
     *
     * @param con die Transaktion der Kaskade — ein Fehler hier rollt die GANZE Kaskade zurück (keine halbe Wahrheit)
     */
    void nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen) throws SQLException;

    /** Solange es AP-11 nicht gibt: keine Kennzahl, nichts zu tun. */
    @Component
    final class Keine implements KennzahlenNaht {

        @Override
        public void nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen) {
            // AP-11 (Kennzahlenbaukasten) ist nicht gebaut.
        }
    }
}
