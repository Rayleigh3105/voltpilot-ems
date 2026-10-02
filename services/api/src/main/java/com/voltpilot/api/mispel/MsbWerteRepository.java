package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Werte des Messstellenbetreibers ({@code mispel_msb_wert}) und ihre Importe ({@code mispel_msb_import}),
 * V20261003015500. RLS + FORCE: jede Abfrage sieht nur den Mandanten der Anfrage. MiSpeL MP-15.
 */
@Repository
public class MsbWerteRepository {

    /** Ein Import: eine Datei, an einer Messstelle hochgeladen. */
    public record Import(UUID id, UUID messstelleId, String format, String dateiname, String sha256,
            int viertelstunden, int ersetzt, Instant von, Instant bis, Instant importiertAm, String importiertVon) {}

    private final JdbcTemplate jdbc;

    public MsbWerteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Import> mitPruefsumme(String sha256) {
        return jdbc.query(SELECT + " WHERE sha256 = ?", (rs, i) -> imp(rs), sha256).stream().findFirst();
    }

    public List<Import> derMessstelle(UUID messstelleId) {
        return jdbc.query(SELECT + " WHERE messstelle_id = ? ORDER BY importiert_am DESC, id", (rs, i) -> imp(rs),
                messstelleId);
    }

    /** Legt den Import an und schreibt seine Werte; ein vorhandener Wert derselben Viertelstunde wird ersetzt. */
    public Import anlegen(UUID tenantId, UUID messstelleId, String dateiname, String sha256,
            List<MsbWerteCsv.Wert> werte, String von) {
        Instant a = werte.stream().map(MsbWerteCsv.Wert::beginn).min(Instant::compareTo).orElseThrow();
        Instant b = werte.stream().map(MsbWerteCsv.Wert::beginn).max(Instant::compareTo).orElseThrow()
                .plusSeconds(900);
        // Wie viele Viertelstunden der Datei schon einen Wert hatten: je Zählpunkt und Richtung eine Abfrage.
        Map<String, List<MsbWerteCsv.Wert>> je = new LinkedHashMap<>();
        werte.forEach(w -> je.computeIfAbsent(w.zaehlpunkt() + "|" + w.richtung(), k -> new ArrayList<>()).add(w));
        int ersetzt = 0;
        for (List<MsbWerteCsv.Wert> l : je.values()) {
            MsbWerteCsv.Wert erster = l.get(0);
            Set<Instant> da = werte(erster.zaehlpunkt(), erster.richtung(), a, b).keySet();
            ersetzt += (int) l.stream().filter(w -> da.contains(w.beginn())).count();
        }
        UUID id = jdbc.queryForObject("INSERT INTO mispel_msb_import (tenant_id, messstelle_id, format, dateiname, "
                + "sha256, viertelstunden, ersetzt, von, bis, importiert_von) VALUES (?, ?, 'csv', ?, ?, ?, ?, ?, ?, ?) "
                + "RETURNING id", UUID.class, tenantId, messstelleId, dateiname, sha256, werte.size(), ersetzt,
                Timestamp.from(a), Timestamp.from(b), von);
        List<Object[]> zeilen = new ArrayList<>(werte.size());
        for (MsbWerteCsv.Wert w : werte) {
            zeilen.add(new Object[] {tenantId, w.zaehlpunkt(), w.richtung(), Timestamp.from(w.beginn()), w.kwh(), id});
        }
        jdbc.batchUpdate("INSERT INTO mispel_msb_wert (tenant_id, zaehlpunkt, richtung, beginn, kwh, import_id) "
                + "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, zaehlpunkt, richtung, beginn) "
                + "DO UPDATE SET kwh = EXCLUDED.kwh, import_id = EXCLUDED.import_id", zeilen);
        return mitPruefsumme(sha256).orElseThrow();
    }

    /** Die geltenden Werte je Viertelstundenbeginn über {@code [von, bis)}; eine fehlende Viertelstunde fehlt. */
    public Map<Instant, BigDecimal> werte(String zaehlpunkt, String richtung, Instant von, Instant bis) {
        Map<Instant, BigDecimal> out = new LinkedHashMap<>();
        jdbc.query("SELECT beginn, kwh FROM mispel_msb_wert WHERE zaehlpunkt = ? AND richtung = ? AND beginn >= ? "
                + "AND beginn < ? ORDER BY beginn", rs -> {
                    out.put(rs.getTimestamp(1).toInstant(), rs.getBigDecimal(2));
                }, zaehlpunkt, richtung, Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    private static final String SELECT = "SELECT id, messstelle_id, format, dateiname, sha256, viertelstunden, ersetzt, "
            + "von, bis, importiert_am, importiert_von FROM mispel_msb_import";

    private static Import imp(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Import(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4),
                rs.getString(5), rs.getInt(6), rs.getInt(7), rs.getTimestamp(8).toInstant(),
                rs.getTimestamp(9).toInstant(), rs.getTimestamp(10).toInstant(), rs.getString(11));
    }
}
