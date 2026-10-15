package com.voltpilot.api.versand;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * {@code zustellweg} (Alerting Scheibe 0, §6.6, {@code V20261015120000}): wie eine Person per E-Mail
 * erreicht wird, erst wirksam nach Bestätigung über einen einmaligen, ablaufenden Link.
 *
 * <p>Anlegen/Lesen des EIGENEN Zustellwegs geht über die RLS-Verbindung des Kundenbereichs (Hausregel:
 * Mandant aus dem Token, nie aus einem Anfragekörper). Die Bestätigung selbst hat KEINE Anmeldung und
 * damit keinen {@code TenantContext} - sie findet die Zeile ausschließlich über den global eindeutigen
 * Token und schreibt über die BYPASSRLS-Admin-Rolle, genau wie die self-service Registrierung vor dem
 * ersten Token auskommt.
 */
@Repository
public class ZustellwegRepository {

    /** Der eigene Zustellweg E-Mail, wie ihn „So erreichen wir Sie“ anzeigt. */
    public record Zustellweg(UUID id, String ziel, Instant bestaetigtAm, boolean aktiv, String abSchwere,
            boolean zusammenfassungAktiv, LocalTime zusammenfassungUhrzeit) {
        public boolean bestaetigt() {
            return bestaetigtAm != null;
        }
    }

    /** Ein Geräte-Abo für Web-Push (Alerting Scheibe 3, §6.7) - "Abo je Gerät". */
    public record PushAbo(UUID id, String geraet, boolean aktiv, String abSchwere, Instant erstelltAm) {
    }

    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;

    public ZustellwegRepository(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.jdbc = jdbc;
        this.admin = admin;
    }

    /** Eigener Zustand (für die Anzeige „So erreichen wir Sie“), leer ohne jeden Eintrag. */
    public Optional<Zustellweg> eigener(String benutzerSub) {
        return jdbc.query("SELECT id, ziel, bestaetigt_am, aktiv, ab_schwere, zusammenfassung_aktiv, "
                        + "zusammenfassung_uhrzeit FROM zustellweg WHERE tenant_id = ? AND benutzer_sub = ? "
                        + "AND weg = 'email'",
                ZustellwegRepository::zustellweg, TenantContext.get(), benutzerSub).stream().findFirst();
    }

    /**
     * Zustell-Vorgabe und Tages-Zusammenfassung ändern (§6.4, §6.4 Nr. 6) - nur möglich, wenn schon
     * ein (ggf. unbestätigter) E-Mail-Zustellweg existiert; sonst keine Wirkung (0 betroffene Zeilen).
     */
    public boolean emailEinstellungenSetzen(String benutzerSub, String abSchwere, boolean zusammenfassungAktiv,
            LocalTime zusammenfassungUhrzeit) {
        return jdbc.update("""
                UPDATE zustellweg SET ab_schwere = ?, zusammenfassung_aktiv = ?, zusammenfassung_uhrzeit = ?,
                       geaendert_am = now()
                 WHERE tenant_id = ? AND benutzer_sub = ? AND weg = 'email'
                """, abSchwere, zusammenfassungAktiv, zusammenfassungUhrzeit, TenantContext.get(),
                benutzerSub) > 0;
    }

    // --------------------------------------------------------------------- Web-Push (Alerting Scheibe 3, §6.7)

    /** Alle eigenen Geräte-Abos (für die Einstellungsfläche "So erreichen wir Sie"). */
    public List<PushAbo> pushAboEigene(String benutzerSub) {
        return jdbc.query("""
                SELECT id, geraet, aktiv, ab_schwere, erstellt_am FROM push_abo
                 WHERE tenant_id = ? AND benutzer_sub = ? ORDER BY erstellt_am
                """, ZustellwegRepository::pushAbo, TenantContext.get(), benutzerSub);
    }

    /** Neues Abo oder (gleicher Endpunkt - derselbe Browser hat sich erneut registriert) Erneuerung. */
    public UUID pushAboAnlegen(String benutzerSub, String endpoint, String p256dh, String auth, String geraet,
            String userAgent) {
        return jdbc.queryForObject("""
                INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (tenant_id, endpoint) DO UPDATE SET
                    p256dh = excluded.p256dh, auth = excluded.auth, geraet = excluded.geraet,
                    user_agent = excluded.user_agent, aktiv = true, abgelaufen_am = NULL
                RETURNING id
                """, UUID.class, TenantContext.get(), benutzerSub, endpoint, p256dh, auth, geraet, userAgent);
    }

    /** "Push je Gerät an/aus" und die Zustell-Vorgabe dieses Geräts (§6.4, §7 Scheibe 3 Punkt 7). */
    public boolean pushAboEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return jdbc.update("""
                UPDATE push_abo SET aktiv = ?, ab_schwere = ? WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?
                """, aktiv, abSchwere, id, TenantContext.get(), benutzerSub) > 0;
    }

    /** Ein Gerät ausdrücklich entfernen (anders als E-Mail gibt es hier kein "ersetzen durch neu"). */
    public boolean pushAboEntfernen(UUID id, String benutzerSub) {
        return jdbc.update("DELETE FROM push_abo WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?",
                id, TenantContext.get(), benutzerSub) > 0;
    }

    /** Alle aktiven Geräte-Abos einer Person für den Versand (§6.7: "Abo je Gerät" - der Zusteller fächert auf). */
    public List<WebPushAdapter.Abo> pushAbosFuerVersand(UUID tenantId, String benutzerSub, String schwere) {
        return admin.query("""
                SELECT endpoint, p256dh, auth FROM push_abo
                 WHERE tenant_id = ? AND benutzer_sub = ? AND aktiv
                   AND schwere_rang(?) >= schwere_rang(ab_schwere)
                """, (rs, n) -> new WebPushAdapter.Abo(rs.getString("endpoint"), rs.getString("p256dh"),
                        rs.getString("auth")), tenantId, benutzerSub, schwere);
    }

    /** {@code true}, wenn die Person MINDESTENS EIN aktives Abo hat, das für diese Stufe gilt. */
    public boolean hatAktivesPushAbo(UUID tenantId, String benutzerSub, String schwere) {
        Boolean b = admin.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM push_abo WHERE tenant_id = ? AND benutzer_sub = ? AND aktiv
                                 AND schwere_rang(?) >= schwere_rang(ab_schwere))
                """, Boolean.class, tenantId, benutzerSub, schwere);
        return Boolean.TRUE.equals(b);
    }

    /** HTTP 404/410 des Push-Diensts (§7 Scheibe 3 Punkt 1: "abgelaufene/ungültige Abos aufräumen"). */
    public void pushAboAlsAbgelaufenMarkieren(String endpoint, Instant jetzt) {
        admin.update("UPDATE push_abo SET aktiv = false, abgelaufen_am = ? WHERE endpoint = ?",
                Timestamp.from(jetzt), endpoint);
    }

    public void pushAboErfolgVermerken(String endpoint, Instant jetzt) {
        admin.update("UPDATE push_abo SET letzter_erfolg_am = ? WHERE endpoint = ?", Timestamp.from(jetzt), endpoint);
    }

    private static PushAbo pushAbo(ResultSet rs, int n) throws SQLException {
        Timestamp erstelltAm = rs.getTimestamp("erstellt_am");
        return new PushAbo(rs.getObject("id", UUID.class), rs.getString("geraet"), rs.getBoolean("aktiv"),
                rs.getString("ab_schwere"), erstelltAm == null ? null : erstelltAm.toInstant());
    }

    /**
     * Legt den eigenen E-Mail-Zustellweg an oder ändert ihn (eine Person, ein Weg - {@code uq_zustellweg_person_weg}):
     * eine geänderte Adresse ist wieder UNBESTÄTIGT, bis der neue Link geklickt wird - ein alter Link
     * verliert dadurch seinen Token (der Teil-Index ist je Token eindeutig, nicht je Zeile).
     */
    public UUID anlegenOderErneuern(String benutzerSub, String ziel, String token, Instant ablauf) {
        return jdbc.queryForObject("""
                INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigung_token,
                                        bestaetigung_ablauf, bestaetigung_versandt_am)
                VALUES (?, ?, 'email', ?, ?, ?, now())
                ON CONFLICT (tenant_id, benutzer_sub, weg) DO UPDATE SET
                    ziel = excluded.ziel,
                    bestaetigung_token = excluded.bestaetigung_token,
                    bestaetigung_ablauf = excluded.bestaetigung_ablauf,
                    bestaetigung_versandt_am = excluded.bestaetigung_versandt_am,
                    bestaetigt_am = CASE WHEN zustellweg.ziel = excluded.ziel THEN zustellweg.bestaetigt_am
                                         ELSE NULL END,
                    geaendert_am = now()
                RETURNING id
                """, UUID.class, TenantContext.get(), benutzerSub, ziel, token, Timestamp.from(ablauf));
    }

    /**
     * Bestätigt per Token: {@code true}, wenn er gültig (nicht abgelaufen) und noch unverbraucht war.
     * Der Token wird in jedem Fall verbraucht (auf NULL gesetzt), damit ein zweiter Aufruf desselben
     * Links nichts mehr findet - "einmalig" (§6.7-Festlegung).
     */
    public boolean bestaetigen(String token, Instant jetzt) {
        return admin.update("""
                UPDATE zustellweg SET bestaetigt_am = ?, bestaetigung_token = NULL, geaendert_am = ?
                WHERE bestaetigung_token = ? AND bestaetigung_ablauf >= ?
                """, Timestamp.from(jetzt), Timestamp.from(jetzt), token, Timestamp.from(jetzt)) == 1;
    }

    /** Die zur Sendezeit gültige Adresse - bestätigt und aktiv - für den Zusteller. */
    public Optional<String> bestaetigtesZiel(UUID tenantId, String benutzerSub) {
        return admin.query("SELECT ziel FROM zustellweg WHERE tenant_id = ? AND benutzer_sub = ? "
                        + "AND weg = 'email' AND bestaetigt_am IS NOT NULL AND aktiv",
                (rs, n) -> rs.getString("ziel"), tenantId, benutzerSub).stream().findFirst();
    }

    /**
     * {@code true}, wenn die Person einen bestätigten, aktiven E-Mail-Weg hat, der für diese Stufe
     * gilt (§6.4 "Zustell-Vorgabe je Stufe") - die Routing-Entscheidung, BEVOR
     * {@code UeberwachungsService.versenden} überhaupt einreiht.
     */
    public boolean hatAktivenEmailWeg(UUID tenantId, String benutzerSub, String schwere) {
        Boolean b = admin.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM zustellweg WHERE tenant_id = ? AND benutzer_sub = ? AND weg = 'email'
                                 AND bestaetigt_am IS NOT NULL AND aktiv AND schwere_rang(?) >= schwere_rang(ab_schwere))
                """, Boolean.class, tenantId, benutzerSub, schwere);
        return Boolean.TRUE.equals(b);
    }

    /** Eine Person mit eingeschalteter Tages-Zusammenfassung und ihrer gewünschten Uhrzeit (§6.4 Nr. 6). */
    public record ZusammenfassungsZeile(String benutzerSub, LocalTime uhrzeit) {
    }

    /** Alle Personen mit eingeschalteter Tages-Zusammenfassung - der Läufer prüft je Person die Ortszeit. */
    public List<ZusammenfassungsZeile> personenMitZusammenfassungAktiv() {
        return jdbc.query("""
                SELECT benutzer_sub, zusammenfassung_uhrzeit FROM zustellweg
                 WHERE tenant_id = ? AND weg = 'email' AND bestaetigt_am IS NOT NULL AND aktiv
                   AND zusammenfassung_aktiv
                """, (rs, n) -> new ZusammenfassungsZeile(rs.getString("benutzer_sub"),
                        rs.getObject("zusammenfassung_uhrzeit", LocalTime.class)), TenantContext.get());
    }

    public Optional<String> emailZielFuerZusammenfassung(String benutzerSub) {
        return bestaetigtesZiel(TenantContext.get(), benutzerSub);
    }

    private static Zustellweg zustellweg(ResultSet rs, int n) throws SQLException {
        Timestamp bestaetigtAm = rs.getTimestamp("bestaetigt_am");
        return new Zustellweg(rs.getObject("id", UUID.class), rs.getString("ziel"),
                bestaetigtAm == null ? null : bestaetigtAm.toInstant(), rs.getBoolean("aktiv"),
                rs.getString("ab_schwere"), rs.getBoolean("zusammenfassung_aktiv"),
                rs.getObject("zusammenfassung_uhrzeit", LocalTime.class));
    }
}
