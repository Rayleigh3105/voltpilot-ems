package com.voltpilot.api.kundenbereich;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Löschen eines Kundenbereichs (vp-kunde-sofort-loeschen-mit-daten, Captain 12.11.2026: der
 * Plattform-Admin löscht jeden Kunden sofort endgültig - mit oder ohne Datenbestand, aktiv oder
 * beendet, ohne vorheriges Vertragsende und ohne Wartefrist). Der Löschweg bleibt der eine
 * ({@code POST /api/v1/admin/tenants/{id}/delete}); eine frühere Frist nach Vertragsende
 * ({@code KundenbereichEnde}, IP-18) sperrte das Löschen - das tut sie nicht mehr. Was „keine
 * Daten" heißt, steht weiter EINMAL in {@link KundeDatenBestand} - nicht mehr als Sperre, nur noch
 * als ehrlicher Anlass im Nachweis.
 *
 * <p><b>Der Datenbestand wird einmal gelesen</b>, in {@link Wache#vorDemAbbau} unter {@code FOR
 * UPDATE} auf der Mandantenzeile, auf der VERBINDUNG DES LÖSCHZUGS - eine Messung, die zwischendurch
 * ankam, zählt noch mit. Das entscheidet nur noch, welcher {@link Anlass} in den Nachweis geht, nie
 * mehr, ob gelöscht wird.
 *
 * <p><b>Der Löschnachweis</b> ({@code mandant_loeschnachweis}, {@code V20260925223000}, Anlass seit
 * {@code V20261111210000}/{@code V20261112090000}) entsteht im SELBEN Zug: ohne Personendaten des
 * Kunden - der Bereich nur als Kennung, die Zeilen je Tabelle vor dem Löschen, was danach noch mit
 * seiner Kennung da ist ({@code verblieben}), die Prüfsumme des letzten abgeschlossenen
 * Gesamtabzugs (IP-17), wer vom Betrieb gelöscht hat. Die Tabellen kommen aus dem Katalog (jede mit
 * {@code tenant_id}), nicht aus der Liste des Löschwegs — sonst zählte der Nachweis nur, was der
 * Löschweg ohnehin kennt. Daneben (gleicher Zug) das Plattform-Protokoll
 * {@code kundenbereich_geloescht_protokoll} MIT Namen: wer welchen Kunden wann und aus welchem
 * Anlass gelöscht hat.
 */
@Component
public class KundenbereichLoeschung {

    /** Der Anlass einer Löschung - die Werte des DB-CHECKs (V20261111210000, V20261112090000). */
    public enum Anlass {
        /** Nur in Bestandszeilen vor vp-kunde-sofort-loeschen-mit-daten: kein neuer Löschzug erzeugt ihn mehr. */
        FRIST_ABGELAUFEN("frist_abgelaufen"),
        SOFORT_KEINE_DATEN("sofort_keine_daten"),
        SOFORT_MIT_DATEN("sofort_mit_daten");

        private final String wert;

        Anlass(String wert) {
            this.wert = wert;
        }

        public String wert() {
            return wert;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Derselbe Katalog, über den der Löschzug zuletzt löscht. */
    private static final String TABELLEN = TenantRepository.KATALOG_MIT_MANDANT;

    /** Die Wache für EINEN Löschzug; {@link Wache#nachweis()} trägt nach dem Commit, was geschrieben wurde. */
    public Wache wache(UUID kundenbereich, ProtokollAkteur betrieb) {
        return new Wache(kundenbereich, betrieb);
    }

    /** Was nach dem Löschen bleibt — die Zeile aus {@code mandant_loeschnachweis}. */
    public record Nachweis(String kennzeichen, UUID kundenbereich, Anlass anlass, Instant geloeschtAm,
            Map<String, Long> zaehlungen, Map<String, Long> verblieben, String abzugSha256) {}

    public final class Wache implements TenantRepository.Abbauwache {
        private final UUID kundenbereich;
        private final ProtokollAkteur betrieb;
        private Instant beendetAm;
        private String name;
        private Anlass anlass;
        private List<String> tabellen;
        private Map<String, Long> zaehlungen;
        private String abzugSha256;
        private OffsetDateTime abzugAm;
        private Nachweis nachweis;

        private Wache(UUID kundenbereich, ProtokollAkteur betrieb) {
            this.kundenbereich = kundenbereich;
            this.betrieb = betrieb;
        }

        public Nachweis nachweis() {
            return nachweis;
        }

        @Override
        public void vorDemAbbau(Connection con) throws SQLException {
            // FOR UPDATE before any DELETE: the rollup jobs hold FOR KEY SHARE on the tenant row while they write
            // (V20260926004700), so the teardown waits for a running job here instead of deadlocking with it later.
            boolean gefunden;
            try (PreparedStatement st = con.prepareStatement(
                    "SELECT id, name, beendet_am FROM tenant WHERE id = ? FOR UPDATE")) {
                st.setObject(1, kundenbereich);
                try (ResultSet rs = st.executeQuery()) {
                    gefunden = rs.next();
                    name = gefunden ? rs.getString("name") : null;
                    OffsetDateTime beendet = gefunden ? rs.getObject("beendet_am", OffsetDateTime.class) : null;
                    beendetAm = beendet == null ? null : beendet.toInstant();
                }
            }
            // Der Datenbestand UNTER der Sperre, auf der Verbindung des Löschzugs: eine Messung, die
            // zwischen dem Lesen der Löschbarkeit und hier ankam, zählt noch mit - das entscheidet nur
            // noch den Anlass im Nachweis, nie mehr, OB gelöscht wird. Ein verschwundener Bereich (eine
            // gleichzeitige zweite Löschung) gilt vacuous als datenfrei; die Protokollzeile MIT Namen
            // scheitert dann ehrlich an ihrem eigenen NOT-NULL-Schutz (derselbe 500-Weg wie jeder andere
            // Löschzug-Fehler: nichts gelöscht, Konten bleiben gesperrt, wiederholbar).
            List<String> daten = gefunden ? KundeDatenBestandRepository.datenarten(con, kundenbereich) : List.of();
            anlass = daten.isEmpty() ? Anlass.SOFORT_KEINE_DATEN : Anlass.SOFORT_MIT_DATEN;
            tabellen = new ArrayList<>();
            try (PreparedStatement st = con.prepareStatement(TABELLEN); ResultSet rs = st.executeQuery()) {
                while (rs.next()) {
                    tabellen.add(rs.getString(1));
                }
            }
            zaehlungen = zaehlen(con);
            zaehlungen.put("tenant", 1L);
            try (PreparedStatement st = con.prepareStatement("SELECT manifest_sha256, abgeschlossen_am"
                    + " FROM kundenbereich_abzug WHERE tenant_id = ? AND abgeschlossen_am IS NOT NULL"
                    + " ORDER BY abgeschlossen_am DESC, id LIMIT 1")) {
                st.setObject(1, kundenbereich);
                try (ResultSet rs = st.executeQuery()) {
                    if (rs.next()) {
                        abzugSha256 = rs.getString(1);
                        abzugAm = rs.getObject(2, OffsetDateTime.class);
                    }
                }
            }
        }

        @Override
        public void nachDemAbbau(Connection con) throws SQLException {
            Map<String, Long> verblieben = zaehlen(con);
            try (PreparedStatement lock = con.prepareStatement("SELECT pg_advisory_xact_lock(hashtext(?))")) {
                lock.setString(1, "mandant_loeschnachweis");
                lock.execute();
            }
            // Seit vp-kunde-sofort-loeschen-mit-daten gibt es keine Frist-Löschung mehr: die drei
            // Fristen-Spalten bleiben für JEDEN neuen Anlass leer (V20261112090000). Ein beendeter Kunde
            // behält sein beendet_am im Nachweis - nur Frist und Stichtag entfallen, denn sofort heißt
            // ohne sie.
            try (PreparedStatement st = con.prepareStatement("INSERT INTO mandant_loeschnachweis (kennzeichen,"
                    + " kundenbereich, beendet_am, frist_tage, loeschung_fruehestens, geloescht_von, zaehlungen,"
                    + " verblieben, abzug_sha256, abzug_am, anlass)"
                    + " SELECT 'LN-' || j.jahr || '-' || lpad((count(n.id) + 1)::text, 4, '0'),"
                    + " ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?"
                    + " FROM (SELECT to_char(now() AT TIME ZONE 'Europe/Berlin', 'YYYY') AS jahr) j"
                    + " LEFT JOIN mandant_loeschnachweis n ON n.kennzeichen LIKE 'LN-' || j.jahr || '-%'"
                    + " GROUP BY j.jahr RETURNING kennzeichen, geloescht_am")) {
                st.setObject(1, kundenbereich);
                st.setObject(2, beendetAm == null ? null : beendetAm.atOffset(ZoneOffset.UTC));
                st.setObject(3, null);
                st.setObject(4, null);
                st.setString(5, betrieb.name());
                st.setString(6, json(zaehlungen));
                st.setString(7, json(verblieben));
                st.setString(8, abzugSha256);
                st.setObject(9, abzugAm);
                st.setString(10, anlass.wert());
                try (ResultSet rs = st.executeQuery()) {
                    rs.next();
                    nachweis = new Nachweis(rs.getString(1), kundenbereich, anlass,
                            rs.getObject(2, OffsetDateTime.class).toInstant(), Map.copyOf(zaehlungen),
                            Map.copyOf(verblieben), abzugSha256);
                }
            }
            // Das Plattform-Protokoll MIT Namen, im selben Zug: wer welchen Kunden wann und aus
            // welchem Anlass gelöscht hat (der Nachweis bleibt bewusst ohne Personendaten).
            try (PreparedStatement st = con.prepareStatement("INSERT INTO kundenbereich_geloescht_protokoll"
                    + " (kundenbereich, name, geloescht_von_sub, geloescht_von_name, anlass,"
                    + " loeschnachweis_kennzeichen) VALUES (?, ?, ?, ?, ?, ?)")) {
                st.setObject(1, kundenbereich);
                st.setString(2, name);
                st.setString(3, betrieb.sub());
                st.setString(4, betrieb.name());
                st.setString(5, anlass.wert());
                st.setString(6, nachweis.kennzeichen());
                st.executeUpdate();
            }
        }

        /** Zeilen mit der Kennung des Bereichs je Katalog-Tabelle, nur die mit Zeilen. */
        private Map<String, Long> zaehlen(Connection con) throws SQLException {
            Map<String, Long> je = new TreeMap<>();
            for (String tabelle : tabellen) {
                try (PreparedStatement st = con.prepareStatement(
                        "SELECT count(*) FROM \"" + tabelle.replace("\"", "\"\"") + "\" WHERE tenant_id = ?")) {
                    st.setObject(1, kundenbereich);
                    try (ResultSet rs = st.executeQuery()) {
                        rs.next();
                        long n = rs.getLong(1);
                        if (n > 0) {
                            je.put(tabelle, n);
                        }
                    }
                }
            }
            return je;
        }
    }

    private static String json(Map<String, Long> werte) {
        try {
            return JSON.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
