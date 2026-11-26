package com.voltpilot.api.direktvermarktung;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die plattformweite Eindeutigkeitsprüfung eines Zertifikat-Fingerabdrucks (Konzept
 * vp-direktvermarktung-konzept d2 §5.7) - bewusst KEIN Datenbank-Unique-Index auf
 * {@code direktvermarktung_zugang.fingerabdruck} (Begründung in der Migration
 * V20261125140000__direktvermarktung.sql): unter FORCE ROW LEVEL SECURITY sähe eine mandanten­
 * gebundene Abfrage nie das Zertifikat eines anderen Mandanten, während ein naiver plattformweiter
 * Unique-Index schon durch seine Konfliktmeldung verriete, dass der Fingerabdruck ANDERSWO existiert -
 * selbst wenn die Zeile selbst unsichtbar bliebe.
 *
 * <p>Diese Klasse liest deshalb über die dedizierte BYPASSRLS-Verbindung ({@code voltpilot_admin},
 * dasselbe Muster wie {@link com.voltpilot.api.repo.AdminDirektvermarktungRepository}), aber geplant
 * schmal: sie liefert nur {@code true}/{@code false}, nie eine Zeile, nie einen Mandanten- oder
 * Anlagenbezug - der ablehnende Satz an den hochladenden Kunden nennt nur "wird schon verwendet", nie
 * wo oder bei wem.
 */
@Component
public class FingerabdruckEindeutigkeit {

    private final JdbcTemplate jdbc;

    public FingerabdruckEindeutigkeit(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** {@code true}, wenn irgendeine, nicht zurückgezogene Zeile (gleich welcher Mandant) ihn schon trägt. */
    public boolean istSchonInVerwendung(String fingerabdruck) {
        Boolean r = jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM direktvermarktung_zugang "
                        + "WHERE fingerabdruck = ? AND zurueckgezogen_am IS NULL)",
                Boolean.class, fingerabdruck);
        return Boolean.TRUE.equals(r);
    }
}
