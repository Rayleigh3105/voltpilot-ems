package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;

/** Liest die bereits verdichteten Anteile von Laden/Entladen; eine Nettomenge ist kein Flusspaar. */
final class BilanzRichtungswerte {
    private BilanzRichtungswerte() {}
    static BigDecimal menge(JdbcTemplate jdbc, String raster, String anteil, MessstelleWerteDto.Wert w) {
        if (w==null) return null;
        if ("gesamt".equals(anteil)) return w.menge();
        // Eine korrigierte Version hat bisher kein gespeichertes Richtungspaar. Keine Zahl erfinden.
        if (w.quelle()==null || w.version()==null || w.version()!=1 || w.menge()==null) return null;
        String tabelle = "tag".equals(raster) ? "messreihe_tag" : "messreihe_periode";
        String art = "tag".equals(raster) ? "" : " AND p.art=?";
        var args=new java.util.ArrayList<Object>();
        args.add(w.quelle()); args.add(TenantContext.get());
        args.add(Timestamp.from(OffsetDateTime.parse(w.von()).toInstant()));
        if (!"tag".equals(raster)) args.add(raster);
        var paare=jdbc.query("""
                SELECT p.menge_positiv,p.menge_negativ FROM messstelle_quelle q
                JOIN measurement_point mp ON mp.id=q.entity_id AND mp.tenant_id=q.tenant_id
                JOIN site s ON s.id=mp.site_id AND s.tenant_id=mp.tenant_id
                JOIN %s p ON p.entity_id=q.entity_id AND p.messkanal=q.kanal AND p.tenant_id=q.tenant_id
                WHERE q.id=? AND q.tenant_id=? AND p.beginn=?
                """.formatted(tabelle)+art,(rs,n) -> new BigDecimal[]{rs.getBigDecimal(1),rs.getBigDecimal(2)},args.toArray());
        if (paare.isEmpty()) return null;
        return paare.getFirst()["positiv".equals(anteil) ? 0 : 1];
    }
}
