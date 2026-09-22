package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Nur ergänzende Lesungen: wirksame Prozessbindungen und Ersatzmenge der gelesenen Monatsversion. */
@Repository
public class BewertungMengenRepository {
    private final JdbcTemplate jdbc;
    public BewertungMengenRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }

    public List<UUID> messstellen(UUID prozess, LocalDate am) {
        return jdbc.queryForList("""
                SELECT m.id FROM messstelle_prozess p
                JOIN messstelle m ON m.id=p.messstelle_id AND m.tenant_id=p.tenant_id
                WHERE p.prozess_id=? AND p.aufgehoben_am IS NULL
                  AND daterange(p.gueltig_ab,p.gueltig_bis,'[]') @> ?::date ORDER BY m.kennzeichen
                """, UUID.class, prozess, am);
    }

    public boolean prozessAusgeschlossen(UUID umfang, UUID prozess) {
        if (umfang==null) return false;
        // Auch in einer Teilansicht anwenden; die Antwort nennt keine ausgeschlossenen fremden Prozesse.
        return Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM bewertung_umfang_ausschluss
                WHERE umfang_id=? AND art='prozess' AND verweis=?)
                """,Boolean.class,umfang,prozess));
    }

    public boolean imStandortUmfang(UUID messstelle, LocalDate am, Set<UUID> standorte) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM messstelle_ort mo
                    LEFT JOIN ort_zuordnung z ON z.ort_id=mo.ort_id AND z.tenant_id=mo.tenant_id
                        AND z.aufgehoben_am IS NULL AND daterange(z.gueltig_ab,z.gueltig_bis,'[]') @> ?::date
                    LEFT JOIN ort_zuordnung p ON p.ort_id=z.eltern_ort_id AND p.tenant_id=z.tenant_id
                        AND p.aufgehoben_am IS NULL AND daterange(p.gueltig_ab,p.gueltig_bis,'[]') @> ?::date
                    WHERE mo.messstelle_id=? AND mo.aufgehoben_am IS NULL
                    AND daterange(mo.gueltig_ab,mo.gueltig_bis,'[]') @> ?::date
                    AND coalesce(mo.standort_id,z.eltern_standort_id,p.eltern_standort_id)=ANY (?))
                """,Boolean.class,am,am,messstelle,am,standorte.toArray(UUID[]::new)));
    }

    public BigDecimal ersatz(MessstelleWerteDto.Wert w) {
        if (w.menge()==null) return null;
        boolean hatErsatz = "mit Ersatzwert".equals(w.zustand()) || w.kennzeichen().stream().anyMatch(k -> k.contains("Ersatz"));
        if (!hatErsatz) return BigDecimal.ZERO;
        if (w.quelle()==null || w.version()==null || w.version()<2) return null;
        // Anteil ist die schon gebildete Ersatzmenge, keine erneute Verbrauchsbildung. Die Monatsversion
        // begrenzt den Lesestand: ein neuerer Ersatzwert darf eine noch alte Monatszahl nicht verändern.
        return jdbc.queryForObject("""
                SELECT sum(v.anteil) FROM messstelle_quelle q
                JOIN measurement_point mp ON mp.id=q.entity_id AND mp.tenant_id=q.tenant_id
                JOIN site s ON s.id=mp.site_id AND s.tenant_id=mp.tenant_id
                JOIN LATERAL (
                    SELECT v.anteil, row_number() OVER (PARTITION BY v.intervall_beginn ORDER BY v.version DESC) AS rang
                    FROM messreihe_viertelstunde_version v
                    WHERE v.tenant_id=q.tenant_id AND v.entity_id=q.entity_id AND v.messkanal=q.kanal
                      AND v.intervall_beginn>=? AND v.intervall_beginn<?
                      AND v.created_at <= (SELECT coalesce(p.nachgezogen_am,p.created_at) FROM messreihe_periode_version p
                          WHERE p.tenant_id=q.tenant_id AND p.entity_id=q.entity_id AND p.messkanal=q.kanal
                            AND p.ebene='monat' AND p.periode_beginn=? AND p.version=?)
                ) v ON v.rang=1 WHERE q.id=? AND q.tenant_id=?
                """,BigDecimal.class,zeit(w.von()),zeit(w.bis()),zeit(w.von()),w.version(),w.quelle(),TenantContext.get());
    }
    private static Timestamp zeit(String s) { return Timestamp.from(OffsetDateTime.parse(s).toInstant()); }
}
