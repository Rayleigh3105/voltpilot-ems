package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Liest die bereits verdichteten Anteile von Laden/Entladen; eine Nettomenge ist kein Flusspaar. Das Paar gehört zur
 * GELESENEN Version: Version 1 aus {@code messreihe_tag}/{@code messreihe_periode}, eine korrigierte aus
 * {@code messreihe_periode_version} (V20260923231500). Trägt sie keins — ein Ersatzwert, ein berichtigter Wert, vor
 * der Migration gebildet —, bleibt der Term „keine Werte“. Keine Zahl erfinden.
 */
final class BilanzRichtungswerte {
    private BilanzRichtungswerte() {}
    static BigDecimal menge(JdbcTemplate jdbc, String raster, String anteil, MessstelleWerteDto.Wert w) {
        if (w==null) return null;
        if ("gesamt".equals(anteil)) return w.menge();
        if (w.quelle()==null || w.version()==null || w.version()<1 || w.menge()==null) return null;
        boolean korrigiert = w.version()>1;
        String tabelle = korrigiert ? "messreihe_periode_version" : "tag".equals(raster) ? "messreihe_tag" : "messreihe_periode";
        String beginn = korrigiert ? "p.periode_beginn" : "p.beginn";
        String art = korrigiert ? " AND p.ebene=? AND p.version=?" : "tag".equals(raster) ? "" : " AND p.art=?";
        var args=new java.util.ArrayList<Object>();
        args.add(w.quelle()); args.add(TenantContext.get());
        args.add(Timestamp.from(OffsetDateTime.parse(w.von()).toInstant()));
        if (korrigiert) { args.add(raster); args.add(w.version()); }
        else if (!"tag".equals(raster)) args.add(raster);
        var paare=jdbc.query("""
                SELECT p.menge_positiv,p.menge_negativ FROM messstelle_quelle q
                JOIN measurement_point mp ON mp.id=q.entity_id AND mp.tenant_id=q.tenant_id
                JOIN site s ON s.id=mp.site_id AND s.tenant_id=mp.tenant_id
                JOIN %s p ON p.entity_id=q.entity_id AND p.messkanal=q.kanal AND p.tenant_id=q.tenant_id
                WHERE q.id=? AND q.tenant_id=? AND %s=?
                """.formatted(tabelle, beginn)+art,(rs,n) -> new BigDecimal[]{rs.getBigDecimal(1),rs.getBigDecimal(2)},args.toArray());
        if (paare.isEmpty()) return null;
        return paare.getFirst()["positiv".equals(anteil) ? 0 : 1];
    }
}
