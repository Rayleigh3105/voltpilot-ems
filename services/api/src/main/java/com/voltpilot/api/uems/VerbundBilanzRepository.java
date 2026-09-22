package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Verbund-Bilanz in der Datenbank (UEMS AP-15 IP-12, Migration V20260921210000): das gespeicherte Ergebnis je
 * Verbund und Tag und die Messstellen, aus denen der Lauf seine Terme liest. Alles unter RLS des Kundenbereichs; der
 * Lauf setzt den {@code TenantContext}. Diese Klasse ist die EINZIGE, die {@code steuerungsverbund_bilanz} liest oder
 * schreibt (außer der Metrik über die Admin-Rolle).
 */
@Repository
public class VerbundBilanzRepository {

    /** Ein gespeichertes Tagesergebnis. */
    public record Ergebnis(UUID verbundId, UUID siteId, LocalDate tag, String zustand, String grund, int erwartet,
            int plausibel, int unplausibel, int unbekannt, java.math.BigDecimal geringstesKw,
            java.math.BigDecimal geringstesToleranzKw, Instant geringstesVon, String grundlageJson, String stufeVorher,
            boolean aufS1Zurueck, String gerechnetVon, java.math.BigDecimal hoechstesKw, Instant hoechstesVon) {}

    /**
     * Der Stand für die Auskunft: jüngstes Ergebnis, seit wann derselbe Zustand steht, wann gerechnet — und bei
     * {@code komponente_ohne_messstelle} die Komponente, der die Messstelle fehlt (aus der Grundlage), sonst null.
     */
    public record Stand(String zustand, LocalDate tag, LocalDate seit, String grund, Instant gerechnetAm,
            Komponente komponente) {}

    /** Eine Messstelle eines Terms: Kennzeichen und die Richtung ihrer Bindung (gibt das Vorzeichen). */
    public record Term(String kennzeichen, String richtung) {}

    private final JdbcTemplate jdbc;

    public VerbundBilanzRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Anlagen des Kundenbereichs (RLS) mit Gemeinsamer Steuerung, in fester Reihenfolge. */
    public List<UUID> anlagenMitVerbund() {
        return jdbc.queryForList("SELECT site_id FROM steuerungsverbund ORDER BY created_at, id", UUID.class);
    }

    /** Hat der Verbund für diesen Tag schon ein Ergebnis? Der Lauf rechnet einen Tag genau einmal. */
    public boolean vorhanden(UUID verbundId, LocalDate tag) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM steuerungsverbund_bilanz "
                + "WHERE steuerungsverbund_id = ? AND tag = ?)", Boolean.class, verbundId, tag));
    }

    /** Speichert ein Ergebnis; false, wenn der Tag schon eines hat (ein zweiter Lauf schreibt nichts). */
    public boolean speichern(UUID tenant, Ergebnis e) {
        return jdbc.update("INSERT INTO steuerungsverbund_bilanz (tenant_id, site_id, steuerungsverbund_id, tag, "
                + "zustand, grund, viertelstunden_erwartet, viertelstunden_plausibel, viertelstunden_unplausibel, "
                + "viertelstunden_unbekannt, geringstes_ungeregeltes_kw, geringstes_toleranz_kw, geringstes_von, "
                + "grundlage, stufe_vorher, auf_s1_zurueck, gerechnet_von, hoechstes_ungeregeltes_kw, hoechstes_von) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?) "
                + "ON CONFLICT (steuerungsverbund_id, tag) DO NOTHING", tenant, e.siteId(), e.verbundId(), e.tag(),
                e.zustand(), e.grund(), e.erwartet(), e.plausibel(), e.unplausibel(), e.unbekannt(), e.geringstesKw(),
                e.geringstesToleranzKw(), e.geringstesVon() == null ? null : Timestamp.from(e.geringstesVon()),
                e.grundlageJson(), e.stufeVorher(), e.aufS1Zurueck(), e.gerechnetVon(), e.hoechstesKw(),
                e.hoechstesVon() == null ? null : Timestamp.from(e.hoechstesVon())) > 0;
    }

    /**
     * Die Tage des Verbunds im Fenster [{@code von}, {@code bis}], die noch {@code unbekannt} stehen — nur sie rechnet
     * der Läufer neu ({@link #nachrechnen}); ein plausibel/unplausibel-Urteil wird nie wieder angefasst.
     */
    public List<LocalDate> unbekannteTage(UUID verbundId, LocalDate von, LocalDate bis) {
        return jdbc.queryForList("SELECT tag FROM steuerungsverbund_bilanz WHERE steuerungsverbund_id = ? "
                + "AND tag BETWEEN ? AND ? AND zustand = 'unbekannt' ORDER BY tag", LocalDate.class, verbundId, von,
                bis);
    }

    /**
     * Ersetzt das Ergebnis eines Tages, der noch {@code unbekannt} steht (A4: nachgelieferte Viertelstunden, IP-30);
     * false, wenn der Tag kein solches Ergebnis hat. Schlüssel und Zaun bleiben (Spaltenrechte V20260922110000).
     */
    public boolean nachrechnen(Ergebnis e) {
        return jdbc.update("UPDATE steuerungsverbund_bilanz SET zustand = ?, grund = ?, viertelstunden_erwartet = ?, "
                + "viertelstunden_plausibel = ?, viertelstunden_unplausibel = ?, viertelstunden_unbekannt = ?, "
                + "geringstes_ungeregeltes_kw = ?, geringstes_toleranz_kw = ?, geringstes_von = ?, "
                + "grundlage = ?::jsonb, stufe_vorher = ?, auf_s1_zurueck = ?, gerechnet_von = ?, "
                + "hoechstes_ungeregeltes_kw = ?, hoechstes_von = ?, gerechnet_am = now() "
                + "WHERE steuerungsverbund_id = ? AND tag = ? AND zustand = 'unbekannt'",
                e.zustand(), e.grund(), e.erwartet(), e.plausibel(), e.unplausibel(), e.unbekannt(), e.geringstesKw(),
                e.geringstesToleranzKw(), e.geringstesVon() == null ? null : Timestamp.from(e.geringstesVon()),
                e.grundlageJson(), e.stufeVorher(), e.aufS1Zurueck(), e.gerechnetVon(), e.hoechstesKw(),
                e.hoechstesVon() == null ? null : Timestamp.from(e.hoechstesVon()), e.verbundId(), e.tag()) > 0;
    }

    /**
     * Der Stand des Verbunds: sein jüngstes Ergebnis und der erste Tag der ununterbrochenen Reihe gleicher Zustände
     * davor („seit“). Leer ohne Ergebnis.
     */
    public Optional<Stand> stand(UUID verbundId) {
        return jdbc.query("WITH j AS (SELECT tag, zustand, grund, gerechnet_am, "
                + "grundlage -> 'komponente_ohne_messstelle' AS k FROM steuerungsverbund_bilanz "
                + "WHERE steuerungsverbund_id = ? ORDER BY tag DESC LIMIT 1) "
                + "SELECT j.zustand, j.tag, j.grund, j.gerechnet_am, j.k ->> 'entity_id' AS k_id, "
                + "j.k ->> 'name' AS k_name, (SELECT min(b.tag) FROM steuerungsverbund_bilanz b "
                + "WHERE b.steuerungsverbund_id = ? AND b.tag > coalesce((SELECT max(x.tag) FROM "
                + "steuerungsverbund_bilanz x WHERE x.steuerungsverbund_id = ? AND x.zustand <> j.zustand), "
                + "DATE '-infinity')) AS seit FROM j",
                (rs, n) -> new Stand(rs.getString("zustand"), rs.getObject("tag", LocalDate.class),
                        rs.getObject("seit", LocalDate.class), rs.getString("grund"),
                        rs.getTimestamp("gerechnet_am").toInstant(), rs.getString("k_id") == null ? null
                                : new Komponente(UUID.fromString(rs.getString("k_id")), rs.getString("k_name"))),
                verbundId, verbundId, verbundId).stream().findFirst();
    }

    /** Alle Ergebnisse eines Verbunds, jüngstes zuerst (für Tests und die Auskunft). */
    public List<Ergebnis> ergebnisse(UUID verbundId) {
        return jdbc.query("SELECT steuerungsverbund_id, site_id, tag, zustand, grund, viertelstunden_erwartet, "
                + "viertelstunden_plausibel, viertelstunden_unplausibel, viertelstunden_unbekannt, "
                + "geringstes_ungeregeltes_kw, geringstes_toleranz_kw, geringstes_von, grundlage::text AS grundlage, "
                + "stufe_vorher, auf_s1_zurueck, gerechnet_von, hoechstes_ungeregeltes_kw, hoechstes_von "
                + "FROM steuerungsverbund_bilanz WHERE steuerungsverbund_id = ? ORDER BY tag DESC",
                (rs, n) -> new Ergebnis(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, LocalDate.class), rs.getString(4), rs.getString(5), rs.getInt(6), rs.getInt(7),
                        rs.getInt(8), rs.getInt(9), rs.getBigDecimal(10), rs.getBigDecimal(11),
                        rs.getTimestamp(12) == null ? null : rs.getTimestamp(12).toInstant(), rs.getString(13),
                        rs.getString(14), rs.getBoolean(15), rs.getString(16), rs.getBigDecimal(17),
                        rs.getTimestamp(18) == null ? null : rs.getTimestamp(18).toInstant()),
                verbundId);
    }

    // ------------------------------------------------------------------ Terme

    /**
     * Die Messstellen einer Datenquelle am Tag [von, bis): je Komponente der Quelle ({@code measurement_point.
     * data_source_id}) und Richtung EINE führende Bindung der Wirkenergie oder Wirkleistung (Wirkenergie zuerst) —
     * zwei Größen derselben Richtung wären dieselbe Leistung doppelt.
     */
    public List<Term> termeDerQuelle(UUID dataSourceId, Instant von, Instant bis) {
        return terme("mp.data_source_id = ?", dataSourceId, von, bis);
    }

    /**
     * Die Geräte einer Box außerhalb ihres Messpunkts (B3: Summe der Geräteleistungen): Komponenten, die die Box liest
     * ({@code measurement_point.device_id}) und die nicht an der Quelle {@code ausser} hängen.
     */
    public List<UUID> geraeteDerBox(UUID box, UUID ausser) {
        return jdbc.queryForList("SELECT id FROM measurement_point WHERE device_id = ? "
                + "AND (data_source_id IS NULL OR data_source_id <> ?) ORDER BY id", UUID.class, box, ausser);
    }

    /** Eine erklärte Komponente einer Box: Kennung und Anzeigename (für den Grund {@code komponente_ohne_messstelle}). */
    public record Komponente(UUID id, String name) {}

    /**
     * Die erklärten Komponenten mit Schreibfreigabe einer Box im Verbund (IP-7, {@code steuerungsverbund_geraet}) — der
     * Beitrag einer mitsteuernden Box OHNE Abgangszähler (B3: „ohne ihn, ihre Geräte“). Je Komponente einmal, auch wenn
     * sie für beide Richtungen erklärt ist; das Ungeregelte hinter dem Abgang (Komponente leer) zählt nicht.
     */
    public List<Komponente> erklaerteKomponenten(UUID verbundId, UUID box) {
        return jdbc.query("SELECT DISTINCT g.entity_id, mp.label FROM steuerungsverbund_geraet g "
                + "JOIN measurement_point mp ON mp.id = g.entity_id WHERE g.steuerungsverbund_id = ? "
                + "AND g.device_id = ? AND g.entity_id IS NOT NULL AND g.schreibfreigabe AND g.aufgehoben_am IS NULL "
                + "ORDER BY g.entity_id", (rs, n) -> new Komponente(rs.getObject(1, UUID.class), rs.getString(2)),
                verbundId, box);
    }

    /** Die Messstellen einer Komponente am Tag, wie {@link #termeDerQuelle}. */
    public List<Term> termeDerKomponente(UUID entityId, Instant von, Instant bis) {
        return terme("mp.id = ?", entityId, von, bis);
    }

    private List<Term> terme(String bedingung, UUID wert, Instant von, Instant bis) {
        return jdbc.query("SELECT DISTINCT ON (q.entity_id, q.richtung) m.kennzeichen, q.richtung "
                + "FROM measurement_point mp JOIN messstelle_quelle q ON q.entity_id = mp.id AND q.rolle = 'fuehrend' "
                + "JOIN messstelle m ON m.id = q.messstelle_id WHERE " + bedingung
                + " AND q.groesse IN ('Wirkenergie', 'Wirkleistung') AND q.gueltig_ab < ? "
                + "AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?) "
                + "ORDER BY q.entity_id, q.richtung, (q.groesse = 'Wirkenergie') DESC, m.kennzeichen",
                (rs, n) -> new Term(rs.getString(1), rs.getString(2)), wert, Timestamp.from(bis), Timestamp.from(von));
    }
}
