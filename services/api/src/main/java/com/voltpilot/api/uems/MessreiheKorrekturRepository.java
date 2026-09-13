package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.MessreiheFassungen.ts;
import static com.voltpilot.api.uems.MessreiheFassungen.zeit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.voltpilot.api.uems.MessreiheFassungen.Fassung;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Lesen und Fortschreiben der Korrekturen ({@code messreihe_korrektur}, UEMS AP-08 IP-12, Migration
 * V20260913190000) — nie ändern, nie löschen.
 *
 * <p>Eine Korrektur beginnt IMMER als Vorschlag (E14: nie automatisch) und wird freigegeben oder
 * abgelehnt; eine freigegebene kann zurückgenommen werden. Jeder Schritt ist eine weitere Fassung
 * mit Urheber und Zeitpunkt — Ersteller und Freigeber sind zwei Fassungen, nie zwei Spalten. Ob eine
 * Person freigeben DARF (Vier-Augen, E8) ist nicht diese Stelle (IP-15), und keine Freigabe rechnet
 * hier etwas neu (Kaskade IP-17).
 *
 * <p>Die Erkennung „Rohwert nach der Frist“ steht weiter in {@code messreihe_korrektur_vorschlag}
 * (AP-07 IP-13) — die Vorstufe; aus ihr macht IP-14 eine Korrektur der Art
 * {@code nachlieferung_nach_endgueltigkeit}. Noch ruft niemand an.
 */
@Repository
public class MessreiheKorrekturRepository {

    static final String TABELLE = "messreihe_korrektur";

    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public MessreiheKorrekturRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Reihe (AP-07 E2): Komponente + Messkanal. */
    public record Reihe(UUID entityId, String messkanal) {
    }

    /**
     * Was eine Korrektur ausmacht — die Spalten der anlegenden Fassung. {@code ersatzwertKennung} genau
     * bei der Art {@code ersatzwert}, {@code beleg} Pflicht bei {@code wert_berichtigt}; {@code vorschau}
     * ist ein nicht leeres Array (alt/neu je Periode, Inhalt IP-14).
     */
    public record Anlage(String art, List<Reihe> reihen, Instant von, Instant bis, String begruendung,
            String beleg, String ersatzwertKennung, JsonNode vorschau) {
    }

    /** Eine Korrektur mit allen Fassungen; die letzte ist ihr Stand. */
    public record Korrektur(String kennung, Anlage anlage, List<Fassung> fassungen) {

        public String status() {
            return fassungen.get(fassungen.size() - 1).status();
        }

        /** Wer sie angelegt hat (Fassung 1) — bei einem System-Vorschlag VoltPilot. */
        public ProtokollAkteur ersteller() {
            return fassungen.get(0).akteur();
        }

        /** Wer sie freigegeben hat, wenn jemand es tat. */
        public Optional<ProtokollAkteur> freigeber() {
            return fassungen.stream()
                    .filter(f -> EreignisVokabular.KORREKTUR_STATUS.get(1).equals(f.status()))
                    .map(Fassung::akteur)
                    .findFirst();
        }
    }

    /** Legt eine Korrektur als Vorschlag an (Fassung 1) und vergibt ihre Kennung im Jahr der Erfassung. */
    @Transactional
    public Korrektur vorschlagen(UUID tenantId, Anlage a, ProtokollAkteur akteur, ZoneId zone) {
        String kennung = MessreiheFassungen.naechsteKennung(jdbc, TABELLE, "K", tenantId, zone);
        ArrayNode reihen = JSON.createArrayNode();
        a.reihen().forEach(r -> reihen.addObject().put("entity_id", r.entityId().toString())
                .put("messkanal", r.messkanal()));
        jdbc.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, beleg, ersatzwert_kennung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,1,?,?,?::jsonb,?,?,?,?,?,?::jsonb,?,?,?,?)",
                tenantId, kennung, EreignisVokabular.KORREKTUR_STATUS.get(0), a.art(), reihen.toString(),
                ts(a.von()), ts(a.bis()), a.begruendung(), a.beleg(), a.ersatzwertKennung(),
                a.vorschau() == null ? null : a.vorschau().toString(),
                akteur.sub(), akteur.name(), akteur.rolle(), akteur.art());
        return lies(tenantId, kennung).orElseThrow();
    }

    /** Gibt einen Vorschlag frei — ab hier ist die Korrektur wirksam (die Neuberechnung ist IP-17). */
    @Transactional
    public Korrektur freigeben(UUID tenantId, String kennung, String grund, ProtokollAkteur akteur) {
        return fortschreiben(tenantId, kennung, EreignisVokabular.KORREKTUR_STATUS.get(1), grund, akteur);
    }

    /** Lehnt einen Vorschlag mit Grund ab — die Werte bleiben, wie sie sind. */
    @Transactional
    public Korrektur ablehnen(UUID tenantId, String kennung, String grund, ProtokollAkteur akteur) {
        return fortschreiben(tenantId, kennung, EreignisVokabular.KORREKTUR_STATUS.get(2), grund, akteur);
    }

    /** Nimmt eine freigegebene Korrektur mit Grund zurück — sie bleibt sichtbar. */
    @Transactional
    public Korrektur zuruecknehmen(UUID tenantId, String kennung, String grund, ProtokollAkteur akteur) {
        return fortschreiben(tenantId, kennung, EreignisVokabular.KORREKTUR_STATUS.get(3), grund, akteur);
    }

    public Optional<Korrektur> lies(UUID tenantId, String kennung) {
        return jdbc.query("SELECT art, reihen::text AS reihen, von, bis, begruendung, beleg, ersatzwert_kennung, "
                + "vorschau::text AS vorschau FROM messreihe_korrektur "
                + "WHERE tenant_id = ? AND kennung = ? AND fassung = 1",
                (rs, n) -> new Korrektur(kennung, anlage(rs),
                        MessreiheFassungen.fassungen(jdbc, TABELLE, tenantId, kennung)),
                tenantId, kennung).stream().findFirst();
    }

    /** Die Korrekturen, die eine Reihe berühren — älteste Kennung zuerst. */
    public List<Korrektur> fuerReihe(UUID tenantId, UUID entityId, String messkanal) {
        String reihe = JSON.createArrayNode().add(JSON.createObjectNode()
                .put("entity_id", entityId.toString()).put("messkanal", messkanal)).toString();
        return jdbc.queryForList("SELECT kennung FROM messreihe_korrektur WHERE tenant_id = ? AND fassung = 1 "
                + "AND reihen @> ?::jsonb ORDER BY created_at, kennung", String.class, tenantId, reihe).stream()
                .map(k -> lies(tenantId, k).orElseThrow())
                .toList();
    }

    private Korrektur fortschreiben(UUID tenantId, String kennung, String status, String grund,
            ProtokollAkteur akteur) {
        List<Fassung> bisher = MessreiheFassungen.fassungen(jdbc, TABELLE, tenantId, kennung);
        if (bisher.isEmpty()) {
            throw new IllegalArgumentException("keine Korrektur " + kennung);
        }
        MessreiheFassungen.fortschreiben(jdbc, TABELLE, tenantId, kennung, bisher.size() + 1, status, grund, akteur);
        return lies(tenantId, kennung).orElseThrow();
    }

    private static Anlage anlage(ResultSet rs) throws SQLException {
        try {
            List<Reihe> reihen = new ArrayList<>();
            for (JsonNode r : JSON.readTree(rs.getString("reihen"))) {
                reihen.add(new Reihe(UUID.fromString(r.get("entity_id").asText()), r.get("messkanal").asText()));
            }
            return new Anlage(rs.getString("art"), List.copyOf(reihen), zeit(rs, "von"), zeit(rs, "bis"),
                    rs.getString("begruendung"), rs.getString("beleg"), rs.getString("ersatzwert_kennung"),
                    JSON.readTree(rs.getString("vorschau")));
        } catch (JsonProcessingException e) {
            throw new SQLException("messreihe_korrektur: JSON nicht lesbar", e);
        }
    }
}
