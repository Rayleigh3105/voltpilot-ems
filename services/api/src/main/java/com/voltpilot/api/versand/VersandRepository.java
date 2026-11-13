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

    // --------------------------------------------------------------------- Beruhigung (Kunden-Alarmierung P4, §6.5)

    /** Der Grund an einer Zeile, die die Beruhigung zurückhält ({@code wartet}) oder hat entfallen lassen. */
    public static final String GRUND_BERUHIGT = "beruhigt";

    /**
     * Wann ging an diese Person über diesen Weg zuletzt eine ANDERE Meldung derselben Meldungsart am selben Bezug
     * hinaus ({@code anlass = 'ausgeloest'}, wirklich {@code gesendet}), und zwar nach {@code seit}? Dieselbe Art am
     * selben Bezug heißt: dieselbe Regel ({@code ueberwachung_id}) und dieselbe {@code bezug_kennung} - eine Regel ab
     * Werk ist genau eine Meldungsart, eine eigene Überwachung ihre eigene. Zwei verschiedene Regeln beruhigen sich nie
     * gegenseitig. Nur was angekommen ist, zählt: eine unterdrückte oder fehlgeschlagene Zeile ist keine Meldung.
     */
    public Optional<Instant> zuletztGemeldetGleicheArt(UUID tenantId, UUID alarmId, String empfaengerSub, String weg,
            Instant seit) {
        Timestamp am = admin.queryForObject("""
                SELECT max(b.gesendet_am) FROM benachrichtigung b
                  JOIN alarm a ON a.tenant_id = b.tenant_id AND a.id = b.quelle_id
                  JOIN alarm d ON d.tenant_id = a.tenant_id AND d.id = ?
                 WHERE b.tenant_id = ? AND b.empfaenger_sub = ? AND b.weg = ? AND b.quelle = 'alarm'
                   AND b.anlass = 'ausgeloest' AND b.zustand = 'gesendet' AND b.gesendet_am > ?
                   AND b.quelle_id <> d.id
                   AND a.ueberwachung_id = d.ueberwachung_id AND a.bezug_kennung = d.bezug_kennung
                """, Timestamp.class, alarmId, tenantId, empfaengerSub, weg, Timestamp.from(seit));
        return Optional.ofNullable(am).map(Timestamp::toInstant);
    }

    /** Hält eine Zeile bis {@code bis} zurück (Grund {@link #GRUND_BERUHIGT}); sie bleibt {@code wartet}. */
    public void beruhigen(UUID id, Instant bis) {
        admin.update("UPDATE benachrichtigung SET naechster_versuch = ?, grund = ? WHERE id = ?", Timestamp.from(bis),
                GRUND_BERUHIGT, id);
    }

    /** Wurde diese Zeile schon einmal von der Beruhigung zurückgehalten? */
    public boolean wurdeBeruhigt(UUID id) {
        return Boolean.TRUE.equals(admin.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM benachrichtigung WHERE id = ? AND grund = ?)", Boolean.class, id,
                GRUND_BERUHIGT));
    }

    /** Ist die Meldung inzwischen erledigt (Wert zurück, Regel geändert oder aus)? */
    public boolean alarmErledigt(UUID alarmId) {
        return Boolean.TRUE.equals(admin.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM alarm WHERE id = ? AND zustand = 'erledigt')", Boolean.class, alarmId));
    }

    /**
     * Hält die Beruhigung die Auslösung DIESER Meldung für genau diese Person und diesen Weg zurück (oder ließ sie
     * entfallen)? Dann sind Entwarnung und Erinnerung dazu leer: sie sprächen von etwas, das nie angekommen ist.
     */
    public boolean ausloesungBeruhigt(UUID alarmId, String empfaengerSub, String weg) {
        return Boolean.TRUE.equals(admin.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM benachrichtigung WHERE quelle = 'alarm' AND quelle_id = ?
                                 AND anlass = 'ausgeloest' AND empfaenger_sub = ? AND weg = ?
                                 AND grund = ? AND zustand <> 'gesendet')
                """, Boolean.class, alarmId, empfaengerSub, weg, GRUND_BERUHIGT));
    }

    // --------------------------------------------------------------------- Zustellstand (Kunden-Alarmierung P4)

    /**
     * Eine Zeile des Versand-Protokolls zu einer Meldung, so wie die Person sie lesen darf: {@code am} ist beim
     * Zustand {@code gesendet} der Sendezeitpunkt, bei {@code wartet} der nächste Versuch (Ruhezeit, Beruhigung,
     * Wiederholung), sonst der Zeitpunkt des Einreihens.
     */
    public record Zustellung(UUID alarmId, String weg, String anlass, String zustand, String grund, Instant am,
            int versuche) {}

    /**
     * Was mit den Meldungen {@code alarmIds} an DIESE Person ging - über die RLS-Verbindung des Aufrufers, mit
     * {@code alarm} verbunden, damit der Standort-Zaun ({@code site_scope} auf {@code alarm}) auch hier entscheidet:
     * eine Meldung hinter dem Zaun hat keinen Zustellstand.
     */
    public List<Zustellung> zustellungen(String empfaengerSub, List<UUID> alarmIds) {
        if (alarmIds.isEmpty()) {
            return List.of();
        }
        return jdbc.query("""
                SELECT b.quelle_id, b.weg, b.anlass, b.zustand, b.grund, b.versuche,
                       CASE b.zustand WHEN 'gesendet' THEN b.gesendet_am WHEN 'wartet' THEN b.naechster_versuch
                            ELSE b.erstellt_am END AS am
                  FROM benachrichtigung b
                  JOIN alarm a ON a.tenant_id = b.tenant_id AND a.id = b.quelle_id
                 WHERE b.quelle = 'alarm' AND b.empfaenger_sub = ? AND b.quelle_id = ANY (?::uuid[])
                 ORDER BY b.erstellt_am, b.weg
                """, (rs, n) -> new Zustellung(rs.getObject("quelle_id", UUID.class), rs.getString("weg"),
                        rs.getString("anlass"), rs.getString("zustand"), rs.getString("grund"),
                        rs.getTimestamp("am") == null ? null : rs.getTimestamp("am").toInstant(),
                        rs.getInt("versuche")),
                empfaengerSub, (Object) alarmIds.stream().map(UUID::toString).toArray(String[]::new));
    }

    /**
     * Die Meldungen des Tages, die die Beruhigung bei dieser Person zurückhielt oder entfallen ließ - für die
     * Tages-Zusammenfassung (§6.5 „was dazwischen passiert, steht in der Liste und in der Zusammenfassung“).
     */
    public List<UUID> beruhigteSeit(String empfaengerSub, Instant seit) {
        return jdbc.query("""
                SELECT DISTINCT b.quelle_id FROM benachrichtigung b
                 WHERE b.quelle = 'alarm' AND b.anlass = 'ausgeloest' AND b.empfaenger_sub = ? AND b.grund = ?
                   AND b.zustand <> 'gesendet' AND b.erstellt_am >= ?
                """, (rs, n) -> rs.getObject(1, UUID.class), empfaengerSub, GRUND_BERUHIGT, Timestamp.from(seit));
    }

    /**
     * Ein E-Mail-Weg fällt aus (Kunden-Alarmierung P4): die jüngste abgeschlossene Zustellung über den eigenen Weg
     * ({@code ziel IS NULL} - nicht die Bestätigungs-Mail an eine neue Adresse) ist endgültig
     * {@code fehlgeschlagen}. Ging danach wieder eine durch, ist nichts ausgefallen. Liefert den Zeitpunkt, seit dem
     * und den letzten Fehlertext.
     */
    public Optional<EmailAusfall> emailAusfall(String empfaengerSub) {
        return jdbc.query("""
                SELECT zustand, erstellt_am, fehler FROM benachrichtigung
                 WHERE empfaenger_sub = ? AND weg = 'email' AND ziel IS NULL
                   AND zustand IN ('gesendet', 'fehlgeschlagen')
                 ORDER BY erstellt_am DESC LIMIT 1
                """, (rs, n) -> "fehlgeschlagen".equals(rs.getString("zustand"))
                        ? new EmailAusfall(rs.getTimestamp("erstellt_am").toInstant(), rs.getString("fehler"))
                        : null, empfaengerSub).stream().filter(java.util.Objects::nonNull).findFirst();
    }

    /** Siehe {@link #emailAusfall}. */
    public record EmailAusfall(Instant seit, String fehler) {}

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
