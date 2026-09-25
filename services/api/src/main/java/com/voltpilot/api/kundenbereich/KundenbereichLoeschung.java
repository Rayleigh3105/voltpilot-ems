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
 * Vertragsende III (UEMS AP-20 IP-18, E10 = A, BT4, RF-08): gelöscht wird ein Kundenbereich nur im Zustand
 * „beendet" und erst ab {@link KundenbereichEnde#loeschungFruehestens} — sonst {@code 409 kundenbereich_nicht_beendet}
 * bzw. {@code 409 frist_laeuft}. Der Löschweg bleibt der eine ({@code POST /api/v1/admin/tenants/{id}/delete}).
 *
 * <p><b>Zweimal geprüft:</b> {@link #pruefen} vor dem Sperren der Konten (eine 409 hinterlässt nichts), und die
 * {@link #wache} noch einmal im Löschzug unter {@code FOR UPDATE} auf der Mandantenzeile — eine gleichzeitige
 * Wiederaufnahme gewinnt entweder ganz oder findet den Bereich nicht mehr.
 *
 * <p><b>Der Löschnachweis</b> ({@code mandant_loeschnachweis}, {@code V20260925223000}) entsteht im SELBEN Zug: ohne
 * Personendaten des Kunden — der Bereich nur als Kennung, die Zeilen je Tabelle vor dem Löschen, was danach noch mit
 * seiner Kennung da ist ({@code verblieben}), die Prüfsumme des letzten abgeschlossenen Gesamtabzugs (IP-17), wer vom
 * Betrieb gelöscht hat. Die Tabellen kommen aus dem Katalog (jede mit {@code tenant_id}), nicht aus der Liste des
 * Löschwegs — sonst zählte der Nachweis nur, was der Löschweg ohnehin kennt.
 */
@Component
public class KundenbereichLoeschung {

    public static final String NICHT_BEENDET = "kundenbereich_nicht_beendet";
    public static final String FRIST_LAEUFT = "frist_laeuft";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TABELLEN = "SELECT c.relname FROM pg_class c"
            + " JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'"
            + " JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped"
            + " WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname";

    private final KundenbereichEndeRepository ende;

    public KundenbereichLoeschung(KundenbereichEndeRepository ende) {
        this.ende = ende;
    }

    /** Die Ablehnung des Löschwegs — {@code code}, Satz und die Fakten, in der Form der UEMS-Ablehnungen. */
    public static final class Verweigert extends TenantRepository.AbbauVerweigert {
        private final Map<String, Object> koerper;

        Verweigert(String code, String message, KundenbereichEnde beendet) {
            super(code);
            koerper = new LinkedHashMap<>();
            koerper.put("code", code);
            koerper.put("message", message);
            if (beendet != null) {
                koerper.put("beendet_am", beendet.beendetAm().toString());
                koerper.put("loeschung_fruehestens", beendet.loeschungFruehestens().toString());
            }
        }

        public Map<String, Object> koerper() {
            return koerper;
        }
    }

    /** Was nach dem Löschen bleibt — die Zeile aus {@code mandant_loeschnachweis}. */
    public record Nachweis(String kennzeichen, UUID kundenbereich, Instant geloeschtAm, Map<String, Long> zaehlungen,
            Map<String, Long> verblieben, String abzugSha256) {}

    /** Vor dem Sperren der Konten: 409, wenn der Bereich nicht beendet oder die Frist nicht abgelaufen ist. */
    public void pruefen(UUID kundenbereich) {
        erlaubt(ende.beendet(kundenbereich).orElse(null));
    }

    /** Die Wache für EINEN Löschzug; {@link Wache#nachweis()} trägt nach dem Commit, was geschrieben wurde. */
    public Wache wache(UUID kundenbereich, ProtokollAkteur betrieb) {
        return new Wache(kundenbereich, betrieb);
    }

    private static KundenbereichEnde erlaubt(KundenbereichEnde beendet) {
        if (beendet == null) {
            throw new Verweigert(NICHT_BEENDET, "Der Kundenbereich ist nicht beendet. Gelöscht wird erst nach dem "
                    + "Vertragsende und der Frist.", null);
        }
        if (!beendet.fristAbgelaufen(LocalDate.now(KundenbereichEnde.ZONE))) {
            throw new Verweigert(FRIST_LAEUFT, "Die Frist nach dem Vertragsende läuft noch. Gelöscht wird frühestens am "
                    + beendet.loeschungFruehestens().format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))
                    + ".", beendet);
        }
        return beendet;
    }

    public final class Wache implements TenantRepository.Abbauwache {
        private final UUID kundenbereich;
        private final ProtokollAkteur betrieb;
        private KundenbereichEnde beendet;
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
            try (PreparedStatement st = con.prepareStatement("SELECT id, beendet_am, beendet_frist_tage, beendet_von"
                    + " FROM tenant WHERE id = ? FOR UPDATE")) {
                st.setObject(1, kundenbereich);
                try (ResultSet rs = st.executeQuery()) {
                    beendet = rs.next() && rs.getObject("beendet_am") != null
                            ? new KundenbereichEnde(kundenbereich,
                                    rs.getObject("beendet_am", OffsetDateTime.class).toInstant(),
                                    rs.getInt("beendet_frist_tage"), rs.getString("beendet_von"))
                            : null;
                }
            }
            erlaubt(beendet);
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
            try (PreparedStatement st = con.prepareStatement("INSERT INTO mandant_loeschnachweis (kennzeichen,"
                    + " kundenbereich, beendet_am, frist_tage, loeschung_fruehestens, geloescht_von, zaehlungen,"
                    + " verblieben, abzug_sha256, abzug_am)"
                    + " SELECT 'LN-' || j.jahr || '-' || lpad((count(n.id) + 1)::text, 4, '0'),"
                    + " ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?"
                    + " FROM (SELECT to_char(now() AT TIME ZONE 'Europe/Berlin', 'YYYY') AS jahr) j"
                    + " LEFT JOIN mandant_loeschnachweis n ON n.kennzeichen LIKE 'LN-' || j.jahr || '-%'"
                    + " GROUP BY j.jahr RETURNING kennzeichen, geloescht_am")) {
                st.setObject(1, kundenbereich);
                st.setObject(2, beendet.beendetAm().atOffset(java.time.ZoneOffset.UTC));
                st.setInt(3, beendet.fristTage());
                st.setObject(4, beendet.loeschungFruehestens());
                st.setString(5, betrieb.name());
                st.setString(6, json(zaehlungen));
                st.setString(7, json(verblieben));
                st.setString(8, abzugSha256);
                st.setObject(9, abzugAm);
                try (ResultSet rs = st.executeQuery()) {
                    rs.next();
                    nachweis = new Nachweis(rs.getString(1), kundenbereich,
                            rs.getObject(2, OffsetDateTime.class).toInstant(), Map.copyOf(zaehlungen),
                            Map.copyOf(verblieben), abzugSha256);
                }
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
