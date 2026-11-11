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
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Vertragsende III (UEMS AP-20 IP-18, E10 = A, BT4, RF-08): gelöscht wird ein Kundenbereich im Zustand
 * „beendet" ab {@link KundenbereichEnde#loeschungFruehestens} — ODER SOFORT, wenn er KEINE DATEN hat
 * (vp-kunde-sofort-loeschen, Captain 11.11.2026: ein doppelt angelegter Kunde ohne Datenbestand, aktiv oder
 * beendet, ohne Frist; was „keine Daten" heißt, steht EINMAL in {@link KundeDatenBestand}). Sonst
 * {@code 409 kundenbereich_nicht_beendet} bzw. {@code 409 frist_laeuft}, jeweils mit der Liste der gefundenen
 * Datenarten. Der Löschweg bleibt der eine ({@code POST /api/v1/admin/tenants/{id}/delete}).
 *
 * <p><b>Zweimal geprüft:</b> {@link #pruefen} vor dem Sperren der Konten (eine 409 hinterlässt nichts), und die
 * {@link #wache} noch einmal im Löschzug unter {@code FOR UPDATE} auf der Mandantenzeile — eine gleichzeitige
 * Wiederaufnahme gewinnt entweder ganz oder findet den Bereich nicht mehr; der Datenbestand wird dort auf der
 * VERBINDUNG DES LÖSCHZUGS gelesen, nach der Sperre — eine Messung, die in der Lücke ankam, zählt.
 *
 * <p><b>Der Löschnachweis</b> ({@code mandant_loeschnachweis}, {@code V20260925223000}, Anlass seit
 * {@code V20261111210000}) entsteht im SELBEN Zug: ohne Personendaten des Kunden — der Bereich nur als Kennung,
 * die Zeilen je Tabelle vor dem Löschen, was danach noch mit seiner Kennung da ist ({@code verblieben}), die
 * Prüfsumme des letzten abgeschlossenen Gesamtabzugs (IP-17), wer vom Betrieb gelöscht hat. Die Tabellen kommen
 * aus dem Katalog (jede mit {@code tenant_id}), nicht aus der Liste des Löschwegs — sonst zählte der Nachweis
 * nur, was der Löschweg ohnehin kennt. Daneben (gleicher Zug) das Plattform-Protokoll
 * {@code kundenbereich_geloescht_protokoll} MIT Namen: wer welchen Kunden wann und aus welchem Anlass gelöscht
 * hat — der Auftrag verlangt den Eintrag „sofort, keine Daten".
 */
@Component
public class KundenbereichLoeschung {

    public static final String NICHT_BEENDET = "kundenbereich_nicht_beendet";
    public static final String FRIST_LAEUFT = "frist_laeuft";

    /** Der Anlass einer Löschung — die Werte des DB-CHECKs (V20261111210000). */
    public enum Anlass {
        FRIST_ABGELAUFEN("frist_abgelaufen"),
        SOFORT_KEINE_DATEN("sofort_keine_daten");

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

    private final KundenbereichEndeRepository ende;
    private final KundeDatenBestandRepository bestand;

    public KundenbereichLoeschung(KundenbereichEndeRepository ende, KundeDatenBestandRepository bestand) {
        this.ende = ende;
        this.bestand = bestand;
    }

    /** Die Ablehnung des Löschwegs — {@code code}, Satz und die Fakten, in der Form der UEMS-Ablehnungen. */
    public static final class Verweigert extends TenantRepository.AbbauVerweigert {
        private final Map<String, Object> koerper;

        Verweigert(String code, String message, KundenbereichEnde beendet, List<String> daten) {
            super(code);
            koerper = new LinkedHashMap<>();
            koerper.put("code", code);
            koerper.put("message", message);
            if (beendet != null) {
                koerper.put("beendet_am", beendet.beendetAm().toString());
                koerper.put("loeschung_fruehestens", beendet.loeschungFruehestens().toString());
            }
            if (daten != null) {
                koerper.put("daten", daten);
            }
        }

        public Map<String, Object> koerper() {
            return koerper;
        }
    }

    /** Was nach dem Löschen bleibt — die Zeile aus {@code mandant_loeschnachweis}. */
    public record Nachweis(String kennzeichen, UUID kundenbereich, Anlass anlass, Instant geloeschtAm,
            Map<String, Long> zaehlungen, Map<String, Long> verblieben, String abzugSha256) {}

    /**
     * Vor dem Sperren der Konten: 409, wenn weder die Frist abgelaufen ist noch der Kunde datenfrei ist.
     * Liefert den Anlass, unter dem gelöscht würde — {@link Anlass#SOFORT_KEINE_DATEN} nur, wenn die
     * Frist den Weg NICHT schon freigibt.
     */
    public Anlass pruefen(UUID kundenbereich) {
        KundenbereichEnde beendet = ende.beendet(kundenbereich).orElse(null);
        if (fristAbgelaufen(beendet)) {
            return Anlass.FRIST_ABGELAUFEN;
        }
        List<String> daten = bestand.fuerKunde(kundenbereich)
                .map(KundeDatenBestandRepository.Zeile::datenarten).orElse(List.of());
        if (daten.isEmpty()) {
            return Anlass.SOFORT_KEINE_DATEN;
        }
        throw verweigert(beendet, daten);
    }

    /** Die Wache für EINEN Löschzug; {@link Wache#nachweis()} trägt nach dem Commit, was geschrieben wurde. */
    public Wache wache(UUID kundenbereich, ProtokollAkteur betrieb) {
        return new Wache(kundenbereich, betrieb);
    }

    private static boolean fristAbgelaufen(KundenbereichEnde beendet) {
        return beendet != null && beendet.fristAbgelaufen(LocalDate.now(KundenbereichEnde.ZONE));
    }

    /** Die Ablehnung, wenn beide Wege zu sind: der Satz nennt den offenen Weg und die gefundenen Datenarten. */
    private static Verweigert verweigert(KundenbereichEnde beendet, List<String> daten) {
        if (beendet == null) {
            return new Verweigert(NICHT_BEENDET, "Der Kunde hat Daten und der Vertrag ist nicht beendet. Gelöscht "
                    + "wird erst nach dem Vertragsende und der Frist.", null, daten);
        }
        return new Verweigert(FRIST_LAEUFT, "Der Kunde hat Daten - die Frist nach dem Vertragsende läuft noch. "
                + "Gelöscht wird frühestens am "
                + beendet.loeschungFruehestens().format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))
                + ".", beendet, daten);
    }

    public final class Wache implements TenantRepository.Abbauwache {
        private final UUID kundenbereich;
        private final ProtokollAkteur betrieb;
        private KundenbereichEnde beendet;
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
            boolean gefunden = false;
            try (PreparedStatement st = con.prepareStatement("SELECT id, name, beendet_am, beendet_frist_tage,"
                    + " beendet_von FROM tenant WHERE id = ? FOR UPDATE")) {
                st.setObject(1, kundenbereich);
                try (ResultSet rs = st.executeQuery()) {
                    gefunden = rs.next();
                    name = gefunden ? rs.getString("name") : null;
                    beendet = gefunden && rs.getObject("beendet_am") != null
                            ? new KundenbereichEnde(kundenbereich,
                                    rs.getObject("beendet_am", OffsetDateTime.class).toInstant(),
                                    rs.getInt("beendet_frist_tage"), rs.getString("beendet_von"))
                            : null;
                }
            }
            if (fristAbgelaufen(beendet)) {
                anlass = Anlass.FRIST_ABGELAUFEN;
            } else {
                // Der Datenbestand UNTER der Sperre, auf der Verbindung des Löschzugs: eine Messung,
                // die zwischen pruefen() und hier ankam, zählt. Ein verschwundener Bereich lehnt ab.
                List<String> daten = gefunden ? KundeDatenBestandRepository.datenarten(con, kundenbereich)
                        : List.of("kundenbereich_fehlt");
                if (!daten.isEmpty()) {
                    throw verweigert(beendet, daten);
                }
                anlass = Anlass.SOFORT_KEINE_DATEN;
            }
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
            // Beim Anlass „sofort, keine Daten" eines AKTIVEN Kunden gibt es kein Vertragsende: die drei
            // Fristen-Spalten bleiben leer (V20261111210000). Ein BEENDETER datenfreier Kunde behält sein
            // beendet_am im Nachweis - nur Frist und Stichtag entfallen, denn sofort heißt ohne sie.
            boolean frist = anlass == Anlass.FRIST_ABGELAUFEN;
            try (PreparedStatement st = con.prepareStatement("INSERT INTO mandant_loeschnachweis (kennzeichen,"
                    + " kundenbereich, beendet_am, frist_tage, loeschung_fruehestens, geloescht_von, zaehlungen,"
                    + " verblieben, abzug_sha256, abzug_am, anlass)"
                    + " SELECT 'LN-' || j.jahr || '-' || lpad((count(n.id) + 1)::text, 4, '0'),"
                    + " ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?"
                    + " FROM (SELECT to_char(now() AT TIME ZONE 'Europe/Berlin', 'YYYY') AS jahr) j"
                    + " LEFT JOIN mandant_loeschnachweis n ON n.kennzeichen LIKE 'LN-' || j.jahr || '-%'"
                    + " GROUP BY j.jahr RETURNING kennzeichen, geloescht_am")) {
                st.setObject(1, kundenbereich);
                st.setObject(2, beendet == null ? null : beendet.beendetAm().atOffset(java.time.ZoneOffset.UTC));
                st.setObject(3, frist ? beendet.fristTage() : null);
                st.setObject(4, frist ? beendet.loeschungFruehestens() : null);
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
