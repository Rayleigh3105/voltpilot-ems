package com.voltpilot.api.uems;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Importe der Bezugsdaten (Tabellen V20260914173000) — unter RLS: ein Import eines fremden
 * Kundenbereichs ist hier nicht da, auch nicht mit demselben Fingerabdruck. Seit AP-09 IP-12 NUR
 * LESEND: die Vorschau fragt, ob eine Datei schon übernommen wurde; geschrieben wird mit der
 * Übernahme (IP-13).
 */
@Repository
public class BezugsdatenImportRepository {

    private final JdbcTemplate jdbc;

    public BezugsdatenImportRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die gespeicherten Importe mit diesem Datei-Fingerabdruck: Kennung, Status der HÖCHSTEN Fassung
     * (eine Rücknahme ist Fassung n + 1), Zeitpunkt der Fassung 1. Welcher davon die Datei „bekannt“
     * macht, entscheidet {@link ImportVorschau}.
     */
    public List<ImportVorschau.FruehererImport> mitFingerabdruck(String sha256) {
        return jdbc.query("SELECT i.kennung, i.created_at, (SELECT j.status FROM bezugsdaten_import j "
                + "WHERE j.tenant_id = i.tenant_id AND j.kennung = i.kennung ORDER BY j.fassung DESC LIMIT 1) AS status "
                + "FROM bezugsdaten_import i WHERE i.datei_sha256 = ? AND i.fassung = 1 ORDER BY i.created_at, i.kennung",
                (rs, n) -> new ImportVorschau.FruehererImport(rs.getString("kennung"), rs.getString("status"),
                        rs.getTimestamp("created_at").toInstant()),
                sha256);
    }
}
