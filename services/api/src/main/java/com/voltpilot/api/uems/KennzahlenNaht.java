package com.voltpilot.api.uems;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * Die Anschlussstelle der Korrektur-Kaskade für die KENNZAHLEN (AP-08 IP-17, E9 → AP-11).
 *
 * <p>E9 verlangt, dass nach einer freigegebenen Korrektur auch die Kennzahlen des betroffenen Zeitraums neu gebildet
 * werden und ihre Version tragen (AP-08 §6.3: „AP-11 hält seine Formelversion getrennt davon“). Die Kaskade ruft die Naht
 * nach allen Stufen und den berechneten Messstellen in DERSELBEN Transaktion. Gefüllt ist sie seit AP-11 IP-8 mit
 * {@link KennzahlKaskade} (Reihen-Pfad); {@link Keine} ist keine Bean mehr und bleibt für Läufe, die ohne Kennzahlen
 * bauen (Tests der Messreihen-Stufen).
 */
public interface KennzahlenNaht {

    /**
     * Nach einer Freigabe, einer Rücknahme oder einem Ersatzwert: was die Kaskade eben neu gebildet hat.
     *
     * @param con die Transaktion der Kaskade — ein Fehler hier rollt die GANZE Kaskade zurück (keine halbe Wahrheit)
     */
    void nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen) throws SQLException;

    /** Ohne Kennzahlen: nichts zu tun — für Läufe, die nur die Messreihen-Stufen prüfen. */
    final class Keine implements KennzahlenNaht {

        @Override
        public void nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen) {
            // Keine Kennzahl in diesem Aufbau.
        }
    }
}
