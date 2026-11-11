package com.voltpilot.api.versand;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Ausgang {@code benachrichtigung} (Alerting Scheibe 0, {@code V20261015120000}): einreihen über
 * die RLS-Verbindung des einreihenden Dienstes, abarbeiten und löschen über die BYPASSRLS-Admin-Rolle
 * (derselbe Zuschnitt wie {@code ComponentActivationOutboxService}: der Zusteller-Läufer hat keinen
 * Zugriffs-Kontext und muss über alle Kundenbereiche hinweg fällige Zeilen finden, aber JEDE einzelne
 * Zustellung bleibt eine Zeile ihres Mandanten).
 */
@Repository
public class VersandRepository implements BenachrichtigungAusgang {

    /** Eine zur Sendezeit fällige Ausgangszeile. {@code schwere} ist nur für {@code quelle = "alarm"} gesetzt;
     * {@code buendelSchluessel} nur für Mehrfach-Regeln (Alerting Scheibe 4, §6.4 Nr. 6). */
    public record Zeile(UUID id, UUID tenantId, String quelle, UUID quelleId, String empfaengerSub, String weg,
            String anlass, int nr, String ziel, String betreff, String inhalt, int versuche, String schwere,
            String buendelSchluessel) {}

    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;

    /** Beendete Kundenbereiche lässt {@link #faellig} aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public VersandRepository(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.jdbc = jdbc;
        this.admin = admin;
    }

    /** Reiht ein; ein bereits vorhandener Schlüssel (Doppelversand-Schutz, §9) bleibt unverändert. */
    @Override
    public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch) {
        email(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, null);
    }

    /** Wie oben, mit Bündel-Schlüssel (Alerting Scheibe 4, §6.4 Nr. 6) - siehe {@link BenachrichtigungAusgang}. */
    @Override
    public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String buendelSchluessel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, naechster_versuch, buendel_schluessel) "
                        + "VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt,
                Timestamp.from(naechsterVersuch), buendelSchluessel);
    }

    /** Wie oben, MIT Stufe (B3) - siehe {@link BenachrichtigungAusgang#email(String, UUID, String, String, int,
     * String, String, Instant, String, String)}. */
    @Override
    public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, naechster_versuch, schwere, buendel_schluessel) "
                        + "VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt,
                Timestamp.from(naechsterVersuch), schwere, buendelSchluessel);
    }

    /** Wie {@link #email}, aber über Web-Push (Alerting Scheibe 3) - Geräte-Abos fächert der Zusteller auf. */
    @Override
    public void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere) {
        webpush(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere, null);
    }

    /** Wie oben, mit Bündel-Schlüssel (Alerting Scheibe 4, §6.4 Nr. 6). */
    @Override
    public void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, naechster_versuch, schwere, buendel_schluessel) "
                        + "VALUES (?, ?, ?, ?, 'webpush', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt,
                Timestamp.from(naechsterVersuch), schwere, buendelSchluessel);
    }

    /** Wie {@link #webpush}, aber über Webhook (Alerting Scheibe 6) - siehe {@link BenachrichtigungAusgang}. */
    @Override
    public void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere) {
        webhook(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere, null);
    }

    @Override
    public void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, naechster_versuch, schwere, buendel_schluessel) "
                        + "VALUES (?, ?, ?, ?, 'webhook', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt,
                Timestamp.from(naechsterVersuch), schwere, buendelSchluessel);
    }

    /** Wie {@link #webpush}, aber über Telegram (Alerting Scheibe 6) - siehe {@link BenachrichtigungAusgang}. */
    @Override
    public void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere) {
        telegram(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere, null);
    }

    @Override
    public void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, naechster_versuch, schwere, buendel_schluessel) "
                        + "VALUES (?, ?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt,
                Timestamp.from(naechsterVersuch), schwere, buendelSchluessel);
    }

    /** Alerting Scheibe 6 (Entscheid 11B) - siehe {@link BenachrichtigungAusgang#emailExtern}. */
    @Override
    public void emailExtern(UUID quelleId, String empfaengerKennung, String anlass, String betreff, String inhalt,
            String ziel) {
        emailMitZiel("alarm_extern", quelleId, empfaengerKennung, anlass, 0, betreff, inhalt, ziel);
    }

    /**
     * Wie {@link #email}, aber mit einem direkt vorgegebenen Ziel - nur für die Bestätigungs-Mail
     * selbst. {@code nr} unterscheidet wiederholte Anforderungen derselben Adresse (B2): ein fest
     * {@code nr = 0} ließ den Doppelversand-Schutz jede ERNEUTE Anforderung verschlucken, weil
     * {@code quelle_id} (der unveränderte {@code zustellweg}-Datensatz) über alle Versuche hinweg
     * gleich bleibt - siehe {@link ZustellwegService#anfordern}.
     */
    public void emailMitZiel(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
            String betreff, String inhalt, String ziel) {
        jdbc.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr, "
                        + "betreff, inhalt, ziel) VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                TenantContext.get(), quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, ziel);
    }

    /** Eine Sende-Pause, bevor ein geclaimter, aber nie beantworteter Versand erneut versucht wird. */
    private static final Duration PACHT = Duration.ofMinutes(2);

    /**
     * Fällige Zeilen quer über alle Kundenbereiche claimen - EIN atomares Statement
     * (UPDATE … FOR UPDATE SKIP LOCKED … RETURNING, wie die Entnahme in
     * {@code ViertelstundeVerdichter}): zwei gleichzeitige Läufer bekommen disjunkte Stapel, keiner
     * wartet auf den anderen. Der Claim ist eine befristete Pacht ({@code naechster_versuch} nach
     * vorn verschoben) statt eines eigenen Zustands - stirbt der Prozess mitten im Versand, greift
     * ein späterer Lauf die Zeile nach Ablauf der Pacht erneut.
     */
    public List<Zeile> faellig(Instant jetzt, int limit) {
        return admin.query("""
                UPDATE benachrichtigung b SET naechster_versuch = ?
                FROM (SELECT id FROM benachrichtigung WHERE zustand = 'wartet' AND naechster_versuch <= ?
                      AND NOT (tenant_id = ANY (?::uuid[]))
                      ORDER BY erstellt_am LIMIT ? FOR UPDATE SKIP LOCKED) c
                WHERE b.id = c.id
                RETURNING b.id, b.tenant_id, b.quelle, b.quelle_id, b.empfaenger_sub, b.weg, b.anlass, b.nr,
                          b.ziel, b.betreff, b.inhalt, b.versuche, b.schwere, b.buendel_schluessel
                """, VersandRepository::zeile, Timestamp.from(jetzt.plus(PACHT)), Timestamp.from(jetzt),
                (Object) beendete.sqlFeld(), limit); // Kundenbereich beendet: bleibt liegen
    }

    public void gesendet(UUID id, Instant jetzt) {
        admin.update("UPDATE benachrichtigung SET zustand = 'gesendet', gesendet_am = ?, versuche = versuche + 1 "
                + "WHERE id = ?", Timestamp.from(jetzt), id);
    }

    /** Fehlgeschlagen: bleibt {@code wartet} bis zur Obergrenze, dann endgültig {@code fehlgeschlagen}. */
    public void fehlgeschlagen(UUID id, String fehler, Instant naechsterVersuch, int hoechstversuche) {
        admin.update("UPDATE benachrichtigung SET versuche = versuche + 1, fehler = ?, "
                        + "naechster_versuch = ?, zustand = CASE WHEN versuche + 1 >= ? THEN 'fehlgeschlagen' "
                        + "ELSE 'wartet' END WHERE id = ?",
                fehler, Timestamp.from(naechsterVersuch), hoechstversuche, id);
    }

    public void unterdrueckt(UUID id, String grund) {
        admin.update("UPDATE benachrichtigung SET zustand = 'unterdrueckt', grund = ?, versuche = versuche + 1 "
                + "WHERE id = ?", grund, id);
    }

    /**
     * Verschiebt eine Zustellung auf einen späteren Zeitpunkt, OHNE sie als Fehlschlag zu zählen
     * (Alerting Scheibe 3, §6.4: Ruhezeit - "Warnung kommt am Ende der Ruhezeit nach, falls noch
     * aktiv"). Bleibt {@code wartet}; der Zusteller prüft beim nächsten Fälligwerden erneut, ob der
     * Alarm noch aktiv ist.
     */
    public void verschieben(UUID id, Instant naechsterVersuch) {
        admin.update("UPDATE benachrichtigung SET naechster_versuch = ? WHERE id = ?",
                Timestamp.from(naechsterVersuch), id);
    }

    /**
     * B7 (Einstellungen-Konzept Entscheid 5A): ob die Auslösung ({@code anlass = "ausgeloest"})
     * desselben Alarms für genau diesen Empfänger/Weg endgültig unterdrückt wurde (keine Sicht
     * oder Stummschaltung) - niemals angekommen und wird es auch nicht mehr. Fehlt die Zeile ganz
     * (noch nicht geclaimt) oder steht sie noch auf {@code wartet}/{@code gesendet}, ist sie NICHT
     * unterdrückt: eine "Wieder normal" dazu hält dann wie die Auslösung selbst, statt zu entfallen.
     */
    public boolean ausloesungWurdeUnterdrueckt(UUID alarmId, String empfaengerSub, String weg) {
        List<String> zustaende = admin.query(
                "SELECT zustand FROM benachrichtigung WHERE quelle = 'alarm' AND quelle_id = ? "
                        + "AND anlass = 'ausgeloest' AND empfaenger_sub = ? AND weg = ?",
                (rs, n) -> rs.getString("zustand"), alarmId, empfaengerSub, weg);
        return !zustaende.isEmpty() && zustaende.stream().allMatch("unterdrueckt"::equals);
    }

    /** Der Löschlauf (Entscheid 13A, 90 Tage) - unabhängig vom Zustand, wie {@code AblaufLaeufer}'s Takt. */
    public int loeschenAelterAls(Instant grenze) {
        return admin.update("DELETE FROM benachrichtigung WHERE erstellt_am < ?", Timestamp.from(grenze));
    }

    /**
     * Die Dedup-Zeile der Tages-Zusammenfassung (§6.4 Nr. 6, {@code taeglicher_rueckblick}):
     * {@code Optional.empty()}, wenn diese Person für diesen Tag schon eine Zeile hat - ihre ID
     * dient als {@code quelle_id} der E-Mail (derselbe Kniff wie {@code zustellweg_bestaetigung}).
     */
    public Optional<UUID> rueckblickNeuAnlegen(String benutzerSub, java.time.LocalDate tag) {
        List<UUID> rows = jdbc.query("""
                INSERT INTO taeglicher_rueckblick (tenant_id, benutzer_sub, tag) VALUES (?, ?, ?)
                ON CONFLICT DO NOTHING RETURNING id
                """, (rs, n) -> rs.getObject("id", UUID.class), TenantContext.get(), benutzerSub,
                java.sql.Date.valueOf(tag));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    private static Zeile zeile(ResultSet rs, int n) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("tenant_id", UUID.class),
                rs.getString("quelle"), rs.getObject("quelle_id", UUID.class), rs.getString("empfaenger_sub"),
                rs.getString("weg"), rs.getString("anlass"), rs.getInt("nr"), rs.getString("ziel"),
                rs.getString("betreff"), rs.getString("inhalt"), rs.getInt("versuche"), rs.getString("schwere"),
                rs.getString("buendel_schluessel"));
    }
}
