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

    /** Ein Webhook-Ziel (Alerting Scheibe 6, §7 Scheibe 6) - wie es die Einstellungsfläche zeigt (ohne Geheimnis). */
    public record WebhookZielEigen(UUID id, String url, String name, boolean aktiv, String abSchwere,
            Instant erstelltAm) {
    }

    /** Dasselbe Ziel, wie der Zusteller es zur Sendezeit braucht (MIT Geheimnis, über die Admin-Rolle). */
    public record WebhookZiel(UUID id, String url, String geheimnis) {
    }

    /** Eine Telegram-Verbindung (Alerting Scheibe 6, §7 Scheibe 6) - wie es die Einstellungsfläche zeigt. */
    public record TelegramZielEigen(UUID id, boolean bestaetigt, boolean aktiv, String abSchwere,
            Instant erstelltAm) {
    }

    /** Dieselbe Verbindung, wie der Zusteller sie zur Sendezeit braucht (MIT chat_id). */
    public record TelegramZiel(UUID id, String chatId) {
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

    // --------------------------------------------------------------------- Webhook (Alerting Scheibe 6, §7)

    /** Alle eigenen Webhook-Ziele (für "Meine Benachrichtigungen"), OHNE das Geheimnis. */
    public List<WebhookZielEigen> webhookZieleEigene(String benutzerSub) {
        return jdbc.query("""
                SELECT id, url, name, aktiv, ab_schwere, erstellt_am FROM webhook_ziel
                 WHERE tenant_id = ? AND benutzer_sub = ? ORDER BY erstellt_am
                """, ZustellwegRepository::webhookZielEigen, TenantContext.get(), benutzerSub);
    }

    /** Legt ein neues Webhook-Ziel an; das Geheimnis wird NUR in dieser Antwort gezeigt. */
    public UUID webhookZielAnlegen(String benutzerSub, String url, String geheimnis, String name) {
        return jdbc.queryForObject("""
                INSERT INTO webhook_ziel (tenant_id, benutzer_sub, url, geheimnis, name)
                VALUES (?, ?, ?, ?, ?) RETURNING id
                """, UUID.class, TenantContext.get(), benutzerSub, url, geheimnis, name == null ? "" : name);
    }

    public boolean webhookZielEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return jdbc.update("""
                UPDATE webhook_ziel SET aktiv = ?, ab_schwere = ? WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?
                """, aktiv, abSchwere, id, TenantContext.get(), benutzerSub) > 0;
    }

    public boolean webhookZielEntfernen(UUID id, String benutzerSub) {
        return jdbc.update("DELETE FROM webhook_ziel WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?",
                id, TenantContext.get(), benutzerSub) > 0;
    }

    /** Alle aktiven Webhook-Ziele einer Person für den Versand (der Zusteller fächert auf). */
    public List<WebhookZiel> webhookZieleFuerVersand(UUID tenantId, String benutzerSub, String schwere) {
        return admin.query("""
                SELECT id, url, geheimnis FROM webhook_ziel
                 WHERE tenant_id = ? AND benutzer_sub = ? AND aktiv
                   AND schwere_rang(?) >= schwere_rang(ab_schwere)
                """, (rs, n) -> new WebhookZiel(rs.getObject("id", UUID.class), rs.getString("url"),
                        rs.getString("geheimnis")), tenantId, benutzerSub, schwere);
    }

    /** HTTP 404/410 oder ein unsicheres Ziel (§7 Scheibe 6: "dauerhaft tote Ziele aufräumen"). */
    public void webhookZielAlsAbgelaufenMarkieren(UUID id, Instant jetzt) {
        admin.update("UPDATE webhook_ziel SET aktiv = false, abgelaufen_am = ? WHERE id = ?",
                Timestamp.from(jetzt), id);
    }

    public void webhookZielErfolgVermerken(UUID id, Instant jetzt) {
        admin.update("UPDATE webhook_ziel SET letzter_erfolg_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    private static WebhookZielEigen webhookZielEigen(ResultSet rs, int n) throws SQLException {
        Timestamp erstelltAm = rs.getTimestamp("erstellt_am");
        return new WebhookZielEigen(rs.getObject("id", UUID.class), rs.getString("url"), rs.getString("name"),
                rs.getBoolean("aktiv"), rs.getString("ab_schwere"), erstelltAm == null ? null : erstelltAm.toInstant());
    }

    // --------------------------------------------------------------------- Telegram (Alerting Scheibe 6, §7)

    /** Alle eigenen Telegram-Verbindungen (für "Meine Benachrichtigungen") - offene UND bestätigte. */
    public List<TelegramZielEigen> telegramZieleEigene(String benutzerSub) {
        return jdbc.query("""
                SELECT id, chat_id, aktiv, ab_schwere, erstellt_am FROM telegram_ziel
                 WHERE tenant_id = ? AND benutzer_sub = ? ORDER BY erstellt_am
                """, ZustellwegRepository::telegramZielEigen, TenantContext.get(), benutzerSub);
    }

    /** "Telegram verbinden": legt den OFFENEN Verbindungs-Versuch an und gibt den Token zurück. */
    public UUID telegramVerbindungAnfordern(String benutzerSub, String token, Instant ablauf) {
        return jdbc.queryForObject("""
                INSERT INTO telegram_ziel (tenant_id, benutzer_sub, verbindungs_token, verbindungs_ablauf)
                VALUES (?, ?, ?, ?) RETURNING id
                """, UUID.class, TenantContext.get(), benutzerSub, token, Timestamp.from(ablauf));
    }

    /**
     * Die Bot-Antwort auf {@code /start <token>}: setzt die chat_id, wenn der Token noch gültig und
     * unverbraucht war - {@code Optional.empty()} sonst. Läuft über die Admin-Rolle (der Bot hat
     * keinen Mandanten-Kontext), wie die E-Mail-Bestätigung per Token.
     */
    public Optional<UUID> telegramVerbindungBestaetigen(String token, String chatId, Instant jetzt) {
        List<UUID> rows = admin.query("""
                UPDATE telegram_ziel SET chat_id = ?, bestaetigt_am = ?, verbindungs_token = NULL
                WHERE verbindungs_token = ? AND verbindungs_ablauf >= ? AND chat_id IS NULL
                RETURNING id
                """, (rs, n) -> rs.getObject("id", UUID.class), chatId, Timestamp.from(jetzt), token,
                Timestamp.from(jetzt));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public boolean telegramZielEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return jdbc.update("""
                UPDATE telegram_ziel SET aktiv = ?, ab_schwere = ? WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?
                """, aktiv, abSchwere, id, TenantContext.get(), benutzerSub) > 0;
    }

    /** "Trennen" (§7 Scheibe 6 Punkt 2) - löscht die Verbindung, wie ein Geräte-Abo entfernt wird. */
    public boolean telegramZielEntfernen(UUID id, String benutzerSub) {
        return jdbc.update("DELETE FROM telegram_ziel WHERE id = ? AND tenant_id = ? AND benutzer_sub = ?",
                id, TenantContext.get(), benutzerSub) > 0;
    }

    /** Alle aktiven, BESTÄTIGTEN Telegram-Verbindungen einer Person für den Versand. */
    public List<TelegramZiel> telegramZieleFuerVersand(UUID tenantId, String benutzerSub, String schwere) {
        return admin.query("""
                SELECT id, chat_id FROM telegram_ziel
                 WHERE tenant_id = ? AND benutzer_sub = ? AND aktiv AND chat_id IS NOT NULL
                   AND schwere_rang(?) >= schwere_rang(ab_schwere)
                """, (rs, n) -> new TelegramZiel(rs.getObject("id", UUID.class), rs.getString("chat_id")),
                tenantId, benutzerSub, schwere);
    }

    /** Die Person hat den Bot blockiert, oder der Chat existiert nicht mehr (§7 Scheibe 6). */
    public void telegramZielAlsAbgelaufenMarkieren(UUID id, Instant jetzt) {
        admin.update("UPDATE telegram_ziel SET aktiv = false, abgelaufen_am = ? WHERE id = ?",
                Timestamp.from(jetzt), id);
    }

    public void telegramZielErfolgVermerken(UUID id, Instant jetzt) {
        admin.update("UPDATE telegram_ziel SET letzter_erfolg_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    private static TelegramZielEigen telegramZielEigen(ResultSet rs, int n) throws SQLException {
        Timestamp erstelltAm = rs.getTimestamp("erstellt_am");
        return new TelegramZielEigen(rs.getObject("id", UUID.class), rs.getString("chat_id") != null,
                rs.getBoolean("aktiv"), rs.getString("ab_schwere"), erstelltAm == null ? null : erstelltAm.toInstant());
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
