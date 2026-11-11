package com.voltpilot.api.geraete;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Bestand für „Endgültig löschen" einer AUSGEBAUTEN Box (vp-box-endgueltig-loeschen): über die
 * Referenz, ohne den Mandanten zu kennen - wie {@link AdminBoxLoesenRepository}, BYPASSRLS-Rolle
 * {@code voltpilot_admin}, nur aus einem {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt.
 * Read-only; die eigentliche Löschung läuft NICHT über diese Rolle (Mandantentrennung,
 * {@link BoxEndgueltigLoeschenService}).
 */
@Repository
public class AdminBoxEndgueltigRepository {

    private final JdbcTemplate jdbc;

    public AdminBoxEndgueltigRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * Die JÜNGSTE ausgebaute Box dieser Referenz, mit ihrem Datenbestand - dieselbe Box, deren Kopf
     * die Geräteakte zeigt. Mehrere ausgebaute Zeilen derselben Kennung sind möglich (der eindeutige
     * Index gilt nur für nicht ausgebaute); gelöscht wird immer über die Geräte-ID, nie „die Referenz".
     */
    public Optional<BoxDatenBestand.Zeile> ausgebauteBox(String externalRef) {
        return jdbc.query(BoxDatenBestand.abfrage()
                        + " WHERE d.external_ref = ? AND d.ausgebaut_am IS NOT NULL"
                        + " ORDER BY d.ausgebaut_am DESC LIMIT 1",
                BoxDatenBestand::zeile, externalRef).stream().findFirst();
    }

    /** Dieselbe Abfrage über die Geräte-ID - der POST adressiert GENAU die Box aus dem Befund. */
    public Optional<BoxDatenBestand.Zeile> ausgebauteBox(String externalRef, UUID deviceId) {
        return jdbc.query(BoxDatenBestand.abfrage()
                        + " WHERE d.id = ? AND d.external_ref = ? AND d.ausgebaut_am IS NOT NULL",
                BoxDatenBestand::zeile, deviceId, externalRef).stream().findFirst();
    }

    /** Gibt es die Box noch, nur nicht ausgebaut? Dann lautet die Antwort „zuerst ausbauen", nie 404. */
    public boolean nichtAusgebauteBox(String externalRef, UUID deviceId) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM device d WHERE d.id = ? AND d.external_ref = ? "
                        + "AND d.ausgebaut_am IS NULL)",
                Boolean.class, deviceId, externalRef));
    }

    /** Der Protokoll-Eintrag einer schon gelöschten Box - macht den POST idempotent. */
    public record Geloescht(String externalRef, UUID deviceId, Instant geloeschtAm, String geloeschtVonName) {
    }

    public Optional<Geloescht> protokoll(UUID deviceId) {
        return jdbc.query("SELECT external_ref, device_id, geloescht_am, geloescht_von_name "
                        + "FROM box_endgueltig_geloescht_protokoll WHERE device_id = ?",
                (rs, n) -> new Geloescht(rs.getString("external_ref"),
                        rs.getObject("device_id", UUID.class),
                        rs.getTimestamp("geloescht_am").toInstant(),
                        rs.getString("geloescht_von_name")),
                deviceId).stream().findFirst();
    }
}
