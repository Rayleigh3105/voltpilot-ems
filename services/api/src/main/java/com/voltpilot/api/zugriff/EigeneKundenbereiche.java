package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung.Konto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Repository;

/** Schmaler mandantenübergreifender Selbst-Leseweg: ausschließlich das verifizierte JWT-Subject.
 * Kein frei übergebbarer Benutzer oder Mandant; keine Kundendaten außer den eigenen gültigen Zugängen.
 * Die Annahme eines Bereichs prüft weiterhin ZugriffKontextLader über die RLS-Verbindung je Anfrage.
 */
@Repository
public class EigeneKundenbereiche {
    private final JdbcTemplate jdbc;
    public EigeneKundenbereiche(@Qualifier("adminJdbcTemplate") JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public record Eintrag(UUID id, String name, String umfang, OffsetDateTime endet) {}

    @org.springframework.security.access.prepost.PreAuthorize("hasAnyAuthority('KONTO_partner', 'KONTO_plattform')")
    public List<Eintrag> lesen() {
        Authentication auth = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt) || jwt.getSubject() == null) return List.of();
        Konto konto = ZugriffKontextLader.konto(auth);
        if (konto != Konto.PARTNER && konto != Konto.PLATTFORM) return List.of();
        return jdbc.query("""
                SELECT z.tenant_id, coalesce(u.name, t.name) AS name, z.umfang, max(z.endet_am) AS endet
                FROM zugriff z JOIN tenant t ON t.id = z.tenant_id
                LEFT JOIN unternehmen u ON u.tenant_id = z.tenant_id
                JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub
                WHERE z.benutzer_sub = ? AND b.konto = ? AND b.zustand IN ('angelegt', 'aktiv')
                  AND z.rolle = 'unterstuetzer'
                  AND ((? = 'partner' AND z.art = 'installateur')
                    OR (? = 'plattform' AND z.art IN ('voltpilot', 'notfall')))
                  AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> now()
                GROUP BY z.tenant_id, coalesce(u.name, t.name), z.umfang
                ORDER BY name, z.tenant_id, z.umfang
                """, (rs, n) -> new Eintrag(rs.getObject("tenant_id", UUID.class), rs.getString("name"),
                rs.getString("umfang"), rs.getObject("endet", OffsetDateTime.class)),
                jwt.getSubject(), konto.code(), konto.code(), konto.code());
    }
}
