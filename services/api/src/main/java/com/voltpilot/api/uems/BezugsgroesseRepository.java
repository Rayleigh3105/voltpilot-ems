package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Die Bezugsgrößen, ihre Kennzeichen-Belegung, ihre Werte und ihr Protokoll (Tabellen
 * V20260913104500, Löschen V20260913120000) — unter RLS: eine fremde Bezugsgröße ist hier nicht
 * da. Keine Regel steht hier; die urteilt {@link BezugsgroesseRegeln}.
 */
@Repository
public class BezugsgroesseRepository {

    private final JdbcTemplate jdbc;

    public BezugsgroesseRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine gespeicherte Bezugsgröße; {@code geltungId} ist die gesetzte Verweis-Spalte. */
    public record Zeile(
            UUID id,
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            boolean hatWerte,
            Instant archiviertAm,
            Instant angelegtAm) {}

    /** Eine gespeicherte Wert-Zeile (eine Fassung). */
    public record WertZeile(
            LocalDate periodeVon,
            LocalDate periodeBis,
            Instant zeitpunkt,
            String zeitzone,
            int fassung,
            Integer ersetztFassung,
            String vorgang,
            String status,
            BigDecimal betrag,
            String begruendung,
            String herkunftArt,
            String importKennung,
            Integer importZeile,
            String geliefertText,
            String geliefertEinheit,
            String kennzeichenJson,
            String actorName,
            String actorRolle,
            String actorArt,
            String freigeberName,
            String freigeberRolle,
            String freigeberArt,
            Instant createdAt) {}

    private static final String SPALTEN = "b.id, b.kennzeichen, b.name, b.wertart, b.einheit, b.periode_art, "
            + "b.geltung_art, coalesce(b.unternehmen_id, b.standort_id, b.ort_id, b.prozess_id, b.kostenstelle_id, "
            + "b.messstelle_id) AS geltung_id, "
            + "coalesce(u.name, s.name, o.name, p.name, k.name, m.name, m.kennzeichen) AS geltung_name, "
            + "(EXISTS (SELECT 1 FROM bezugsgroesse_wert w WHERE w.bezugsgroesse_id = b.id "
            + "AND w.tenant_id = b.tenant_id) OR EXISTS (SELECT 1 FROM bezugsgroesse_stammdatum sd "
            + "WHERE sd.bezugsgroesse_id = b.id AND sd.tenant_id = b.tenant_id)) AS hat_werte, b.archiviert_am, b.created_at "
            + "FROM bezugsgroesse b "
            + "LEFT JOIN unternehmen u ON u.id = b.unternehmen_id AND u.tenant_id = b.tenant_id "
            + "LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id "
            + "LEFT JOIN ort o ON o.id = b.ort_id AND o.tenant_id = b.tenant_id "
            + "LEFT JOIN prozess p ON p.id = b.prozess_id AND p.tenant_id = b.tenant_id "
            + "LEFT JOIN kostenstelle k ON k.id = b.kostenstelle_id AND k.tenant_id = b.tenant_id "
            + "LEFT JOIN messstelle m ON m.id = b.messstelle_id AND m.tenant_id = b.tenant_id ";

    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class),
            rs.getString("kennzeichen"),
            rs.getString("name"),
            rs.getString("wertart"),
            rs.getString("einheit"),
            rs.getString("periode_art"),
            rs.getString("geltung_art"),
            rs.getObject("geltung_id", UUID.class),
            rs.getString("geltung_name"),
            rs.getBoolean("hat_werte"),
            instant(rs, "archiviert_am"),
            instant(rs, "created_at"));

    /** Das Vokabular des Vertrags aus seiner EINEN Stelle in der Datenbank ({@code bezugsdaten_vokabular()}). */
    public BezugsgroesseRegeln.Vokabular vokabular() {
        Map<String, List<String>> listen = new LinkedHashMap<>();
        Map<String, List<String>> einheiten = new LinkedHashMap<>();
        jdbc.query("SELECT vokabular, wort, groesse FROM bezugsdaten_vokabular() ORDER BY vokabular, nr", rs -> {
            String vokabular = rs.getString("vokabular");
            if ("einheiten".equals(vokabular)) {
                einheiten.computeIfAbsent(rs.getString("groesse"), g -> new ArrayList<>()).add(rs.getString("wort"));
            } else {
                listen.computeIfAbsent(vokabular, v -> new ArrayList<>()).add(rs.getString("wort"));
            }
        });
        return new BezugsgroesseRegeln.Vokabular(listen.getOrDefault("wertart", List.of()),
                listen.getOrDefault("geltung_art", List.of()), listen.getOrDefault("periode_art", List.of()), einheiten);
    }

    public List<Zeile> alle() {
        return jdbc.query("SELECT " + SPALTEN + "ORDER BY b.kennzeichen, b.id", ZEILE);
    }

    public Optional<Zeile> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + "WHERE b.id = ?", ZEILE, id).stream().findFirst();
    }

    /** Wie {@link #finde}, aber unter der Zeilensperre FOR UPDATE — ein gleichzeitig entstehender erster Wert wartet. */
    public Optional<Zeile> sperre(UUID id) {
        List<UUID> da = jdbc.queryForList("SELECT id FROM bezugsgroesse WHERE id = ? FOR UPDATE", UUID.class, id);
        return da.isEmpty() ? Optional.empty() : finde(id);
    }

    /**
     * Schreibvorgänge an Bezugsgrößen je Kundenbereich nacheinander: die automatische Vergabe folgt
     * auf die höchste je belegte Nummer, und zwei gleichzeitige Vergaben dürfen nicht dieselbe sehen.
     * Die Sperre gilt bis zum Ende der Transaktion.
     */
    public void kundenbereichSperren(UUID tenant) {
        jdbc.queryForObject("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(?, 0))) x", Integer.class,
                "uems_bezugsgroesse:" + tenant);
    }

    /** Jedes Kennzeichen, das je eine Bezugsgröße des Kundenbereichs trug — auch eine gelöschte (Grabstein). */
    public List<String> jeBelegt() {
        return jdbc.queryForList("SELECT kennzeichen FROM bezugsgroesse_kennzeichen_verlauf", String.class);
    }

    /** Wie {@link #jeBelegt}, ohne die Kennzeichen der Bezugsgröße selbst (sie darf zu ihrem früheren zurück). */
    public List<String> belegtVonAnderen(UUID id) {
        return jdbc.queryForList("SELECT kennzeichen FROM bezugsgroesse_kennzeichen_verlauf "
                + "WHERE bezugsgroesse_id IS DISTINCT FROM ?", String.class, id);
    }

    /** M1/M6: die Wert-Zeilen — alle Fassungen UND jedes Intervall eines Stammdatums (auch ein aufgehobenes). */
    public long werteZahl(UUID id) {
        Long n = jdbc.queryForObject("SELECT (SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ?) "
                + "+ (SELECT count(*) FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id = ?)", Long.class, id, id);
        return n == null ? 0 : n;
    }

    // ------------------------------------------------------------ Stammdatum (E15, V20260914151500)

    /** Ein Intervall eines Stammdatums; {@code gueltigBis} ist der LETZTE Tag, {@code aufgehobenAm} eine Korrektur. */
    public record StammdatumZeile(UUID id, BigDecimal wert, LocalDate gueltigAb, LocalDate gueltigBis,
            Instant aufgehobenAm, Instant createdAt) {

        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    /** Alle Intervalle, aufgehobene eingeschlossen, nach Beginn und Eintrag. */
    public List<StammdatumZeile> stammdaten(UUID id) {
        return jdbc.query("SELECT id, wert, gueltig_ab, gueltig_bis, aufgehoben_am, created_at "
                + "FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id = ? ORDER BY gueltig_ab, created_at, id",
                (rs, n) -> new StammdatumZeile(rs.getObject("id", UUID.class), rs.getBigDecimal("wert"),
                        rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class),
                        instant(rs, "aufgehoben_am"), instant(rs, "created_at")), id);
    }

    /** Ein neues Intervall; Wertart und Einheit reisen als Kopie mit (M1-Fremdschlüssel). */
    public void stammdatumEintragen(UUID tenant, UUID id, String wertart, String einheit, BigDecimal wert,
            LocalDate gueltigAb, LocalDate gueltigBis, String createdBy) {
        jdbc.update("INSERT INTO bezugsgroesse_stammdatum (tenant_id, bezugsgroesse_id, wertart, einheit, wert, "
                + "gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?,?)",
                tenant, id, wertart, einheit, wert, gueltigAb, gueltigBis, createdBy);
    }

    /** Beendet ein nicht aufgehobenes Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean stammdatumBeenden(UUID zeile, LocalDate gueltigBis) {
        return jdbc.update("UPDATE bezugsgroesse_stammdatum SET gueltig_bis = ? WHERE id = ? AND aufgehoben_am IS NULL",
                gueltigBis, zeile) == 1;
    }

    /** Hebt ein Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean stammdatumAufheben(UUID zeile) {
        return jdbc.update("UPDATE bezugsgroesse_stammdatum SET aufgehoben_am = now() WHERE id = ? AND aufgehoben_am IS NULL",
                zeile) == 1;
    }

    /**
     * Die Zeitzone, in der die Tage einer Bezugsgröße liegen: die ihres Standorts, sonst die des Unternehmens
     * (Z1) — {@code Europe/Berlin}, wenn der Kundenbereich keines hat.
     */
    public String zeitzone(UUID id) {
        return jdbc.queryForObject("SELECT coalesce((SELECT s.zeitzone FROM bezugsgroesse b JOIN standort s "
                + "ON s.id = b.standort_id AND s.tenant_id = b.tenant_id WHERE b.id = ?), "
                + "(SELECT u.zeitzone FROM unternehmen u ORDER BY u.id LIMIT 1), 'Europe/Berlin')", String.class, id);
    }

    /** Gibt es das Objekt des Geltungsbereichs im Kundenbereich? Ein fremdes ist unter RLS nicht da. */
    public boolean geltungDa(String art, UUID id) {
        String sql = switch (art) {
            case "unternehmen" -> "SELECT EXISTS (SELECT 1 FROM unternehmen WHERE id = ?)";
            case "standort" -> "SELECT EXISTS (SELECT 1 FROM standort WHERE id = ?)";
            case "gebaeude", "bereich" -> "SELECT EXISTS (SELECT 1 FROM ort WHERE id = ? AND art = '" + art + "')";
            case "prozess" -> "SELECT EXISTS (SELECT 1 FROM prozess WHERE id = ?)";
            case "kostenstelle" -> "SELECT EXISTS (SELECT 1 FROM kostenstelle WHERE id = ?)";
            case "messstelle" -> "SELECT EXISTS (SELECT 1 FROM messstelle WHERE id = ?)";
            default -> null;
        };
        return sql != null && Boolean.TRUE.equals(jdbc.queryForObject(sql, Boolean.class, id));
    }

    /** Legt an; die Verweis-Spalte folgt der Geltungsbereich-Art. Das Kennzeichen belegt der Trigger. */
    public UUID anlegen(UUID tenant, BezugsgroesseRegeln.Entwurf e, UUID geltungId) {
        UUID[] verweis = verweis(e.geltungArt(), geltungId);
        return jdbc.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, unternehmen_id, standort_id, ort_id, messstelle_id, prozess_id, "
                + "kostenstelle_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant,
                e.kennzeichen(), e.name(), e.wertart(), e.einheit(), e.periodeArt(), e.geltungArt(), verweis[0],
                verweis[1], verweis[2], verweis[3], verweis[4], verweis[5]);
    }

    public void aendern(UUID id, BezugsgroesseRegeln.Entwurf e, UUID geltungId) {
        UUID[] verweis = verweis(e.geltungArt(), geltungId);
        jdbc.update("UPDATE bezugsgroesse SET kennzeichen = ?, name = ?, wertart = ?, einheit = ?, periode_art = ?, "
                + "geltung_art = ?, unternehmen_id = ?, standort_id = ?, ort_id = ?, messstelle_id = ?, "
                + "prozess_id = ?, kostenstelle_id = ?, updated_at = now() WHERE id = ?", e.kennzeichen(), e.name(),
                e.wertart(), e.einheit(), e.periodeArt(), e.geltungArt(), verweis[0], verweis[1], verweis[2],
                verweis[3], verweis[4], verweis[5], id);
    }

    public void archivieren(UUID id) {
        jdbc.update("UPDATE bezugsgroesse SET archiviert_am = now(), updated_at = now() WHERE id = ?", id);
    }

    /** Löscht die Zeile; der Kennzeichen-Verlauf behält seine Belegung als Grabstein (V20260913120000). */
    public int loeschen(UUID id) {
        return jdbc.update("DELETE FROM bezugsgroesse WHERE id = ?", id);
    }

    /**
     * Die Wert-Zeilen im Zeitraum, je Schlüssel alle Fassungen, älteste zuerst. Tagesgenau mit dem
     * letzten Tag EINSCHLIESSLICH: ein Periodenwert gehört dazu, wenn seine Periode den Zeitraum
     * berührt; ein Stand, wenn sein Tag in SEINER Zone ({@code zeitzone}) darin liegt.
     */
    public List<WertZeile> werte(UUID id, LocalDate von, LocalDate bis) {
        StringBuilder sql = new StringBuilder("SELECT w.* FROM bezugsgroesse_wert w WHERE w.bezugsgroesse_id = ?");
        List<Object> args = new ArrayList<>(List.of(id));
        if (von != null) {
            sql.append(" AND coalesce(w.periode_bis, (w.zeitpunkt AT TIME ZONE w.zeitzone)::date) >= ?");
            args.add(von);
        }
        if (bis != null) {
            sql.append(" AND coalesce(w.periode_von, (w.zeitpunkt AT TIME ZONE w.zeitzone)::date) <= ?");
            args.add(bis);
        }
        sql.append(" ORDER BY w.periode_von NULLS LAST, w.zeitpunkt NULLS LAST, w.fassung");
        return jdbc.query(sql.toString(), (rs, n) -> new WertZeile(
                rs.getObject("periode_von", LocalDate.class),
                rs.getObject("periode_bis", LocalDate.class),
                instant(rs, "zeitpunkt"),
                rs.getString("zeitzone"),
                rs.getInt("fassung"),
                (Integer) rs.getObject("ersetzt_fassung"),
                rs.getString("vorgang"),
                rs.getString("status"),
                rs.getBigDecimal("betrag"),
                rs.getString("begruendung"),
                rs.getString("herkunft_art"),
                rs.getString("import_kennung"),
                (Integer) rs.getObject("import_zeile"),
                rs.getString("geliefert_text"),
                rs.getString("geliefert_einheit"),
                rs.getString("kennzeichen"),
                rs.getString("actor_name"),
                rs.getString("actor_rolle"),
                rs.getString("actor_art"),
                rs.getString("freigeber_name"),
                rs.getString("freigeber_rolle"),
                rs.getString("freigeber_art"),
                instant(rs, "created_at")), args.toArray());
    }

    /** Ein Protokolleintrag; {@code gilt_ab} und die Eintragszeit setzt die Datenbank (jetzt, nicht rückwirkend). */
    public void protokoll(UUID tenant, UUID id, String art, String altJson, String neuJson, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb, now(), false, ?,?,?,?)", tenant, id, art, altJson, neuJson,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    /** Ein Protokolleintrag mit „gilt ab“ und „rückwirkend“ (S4); die Eintragszeit setzt die Datenbank. */
    public void protokoll(UUID tenant, UUID id, String art, String altJson, String neuJson, Instant giltAb,
            boolean rueckwirkend, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?)", tenant, id, art, altJson, neuJson, Timestamp.from(giltAb),
                rueckwirkend, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private static UUID[] verweis(String art, UUID id) {
        return new UUID[] {
            "unternehmen".equals(art) ? id : null,
            "standort".equals(art) ? id : null,
            "gebaeude".equals(art) || "bereich".equals(art) ? id : null,
            "messstelle".equals(art) ? id : null,
            "prozess".equals(art) ? id : null,
            "kostenstelle".equals(art) ? id : null
        };
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
