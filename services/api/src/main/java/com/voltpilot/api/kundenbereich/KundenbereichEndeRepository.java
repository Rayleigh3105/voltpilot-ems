package com.voltpilot.api.kundenbereich;

import com.voltpilot.api.uems.ProtokollAkteur;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Zustand „beendet" am Kundenbereich (UEMS AP-20 IP-16, {@code V20260925170000}).
 *
 * <p>Über die Admin-Verbindung ({@code voltpilot_admin}, BYPASSRLS), wie {@code TenantRepository}: der Filter fragt
 * den Zustand VOR jeder Route, auch für Plattform-Routen, deren Kundenbereich erst aus Anlage oder Box folgt — ohne
 * Mandanten-Kontext. Nur die Admin-Rolle darf die Spalten ändern (Trigger {@code tenant_beendet_einmalig}).
 *
 * <p><b>Übergänge einmalig:</b> {@link #beenden} und {@link #wiederaufnehmen} sind je EINE Anweisung, die den Zustand
 * nur aus dem erwarteten Vorzustand bewegt ({@code WHERE beendet_am IS NULL} bzw. {@code IS NOT NULL}) und im selben
 * Zug die Protokollzeile schreibt. Zwei gleichzeitige Aufrufe bewegen ihn einmal; der zweite findet keine Zeile.
 */
@Repository
public class KundenbereichEndeRepository {

    private final JdbcTemplate jdbc;

    public KundenbereichEndeRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Der beendete Kundenbereich — leer, wenn er aktiv ist oder es ihn nicht gibt. */
    public Optional<KundenbereichEnde> beendet(UUID kundenbereich) {
        return jdbc.query("SELECT id, beendet_am, beendet_frist_tage, beendet_von FROM tenant"
                + " WHERE id = ? AND beendet_am IS NOT NULL", KundenbereichEndeRepository::ende, kundenbereich)
                .stream().findFirst();
    }

    /** Alle beendeten Kundenbereiche — der Stand hinter {@link BeendeteKundenbereiche}. */
    public Set<UUID> alleBeendeten() {
        return Set.copyOf(jdbc.queryForList("SELECT id FROM tenant WHERE beendet_am IS NOT NULL", UUID.class));
    }

    /** Der Kundenbereich einer Anlage (Plattform-Routen {@code /admin/sites/{siteId}/…}). */
    public Optional<UUID> kundenbereichDerAnlage(UUID siteId) {
        return jdbc.queryForList("SELECT tenant_id FROM site WHERE id = ?", UUID.class, siteId).stream().findFirst();
    }

    /** Der Kundenbereich einer Box (Plattform-Routen {@code /admin/devices/{deviceId}/…}). */
    public Optional<UUID> kundenbereichDerBox(UUID deviceId) {
        return jdbc.queryForList("SELECT tenant_id FROM device WHERE id = ?", UUID.class, deviceId).stream().findFirst();
    }

    /** aktiv → beendet mit Protokoll; leer, wenn der Kundenbereich nicht (mehr) aktiv ist. */
    public Optional<KundenbereichEnde> beenden(UUID kundenbereich, String auftrag, String begruendung, int fristTage,
            ProtokollAkteur akteur) {
        return jdbc.query("WITH t AS ("
                + " UPDATE tenant SET beendet_am = now(), beendet_frist_tage = ?, beendet_von = ?"
                + " WHERE id = ? AND beendet_am IS NULL"
                + " RETURNING id, beendet_am, beendet_frist_tage, beendet_von),"
                + " p AS ("
                + " INSERT INTO kundenbereich_uebergang (tenant_id, von, nach, auftrag, begruendung, frist_tage,"
                + " akteur_sub, akteur_name, zeitpunkt)"
                + " SELECT t.id, 'aktiv', 'beendet', ?, ?, t.beendet_frist_tage, ?, ?, t.beendet_am FROM t)"
                + " SELECT * FROM t", KundenbereichEndeRepository::ende,
                fristTage, akteur.name(), kundenbereich, auftrag, begruendung, akteur.sub(), akteur.name())
                .stream().findFirst();
    }

    /** beendet → aktiv mit Protokoll; {@code false}, wenn der Kundenbereich nicht beendet ist. */
    public boolean wiederaufnehmen(UUID kundenbereich, String auftrag, String begruendung, ProtokollAkteur akteur) {
        List<UUID> bewegt = jdbc.queryForList("WITH t AS ("
                + " UPDATE tenant SET beendet_am = NULL, beendet_frist_tage = NULL, beendet_von = NULL"
                + " WHERE id = ? AND beendet_am IS NOT NULL RETURNING id),"
                + " p AS ("
                + " INSERT INTO kundenbereich_uebergang (tenant_id, von, nach, auftrag, begruendung, akteur_sub,"
                + " akteur_name)"
                + " SELECT t.id, 'beendet', 'aktiv', ?, ?, ?, ? FROM t)"
                + " SELECT id FROM t", UUID.class,
                kundenbereich, auftrag, begruendung, akteur.sub(), akteur.name());
        return !bewegt.isEmpty();
    }

    private static KundenbereichEnde ende(ResultSet rs, int n) throws SQLException {
        return new KundenbereichEnde(rs.getObject("id", UUID.class),
                rs.getObject("beendet_am", OffsetDateTime.class).toInstant(), rs.getInt("beendet_frist_tage"),
                rs.getString("beendet_von"));
    }
}
