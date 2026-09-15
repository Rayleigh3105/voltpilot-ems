package com.voltpilot.api.zugriff;

import com.voltpilot.api.tenant.TenantContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Der Zugriff-Kontext je Anfrage (UEMS AP-03 IP-4) — in der {@code secured}-Kette direkt nach dem
 * {@code TenantFilter}. Was er lädt, sagt {@link ZugriffKontextLader}; dieser Filter entscheidet nur, was eine
 * Abweisung heißt:
 *
 * <p><b>404 auf jeder Kundenroute</b> — dieselbe Antwort wie für eine Route, die es nicht gibt. Weder 403 noch eine
 * leere Liste verraten einem Partner (oder einer Plattform mit {@code X-Kundenbereich}) ohne wirksame Unterstützung,
 * dass es den Kundenbereich gibt.
 *
 * <p>Kundenroute = alles unter {@code /api/v1/} außer {@code /api/v1/admin/**} (Plattform-Betrieb, unverändert —
 * dort filtert er gar nicht) und {@code /api/v1/me}: die Selbstauskunft antwortet jedem angemeldeten Konto, ohne
 * angenommenen Kundenbereich eben ohne ihn.
 *
 * <p>Der {@link ZugriffContext} wird im {@code finally} abgeräumt, so wie der {@code TenantFilter} seinen
 * Kundenbereich abräumt — ein Thread des Pools trägt nie den Zugriff der vorigen Anfrage.
 */
public class ZugriffFilter extends OncePerRequestFilter {

    static final String KUNDENROUTEN = "/api/v1/";
    static final String ADMIN = "/api/v1/admin/";
    /** Die Selbstauskunft — die eine Route unter {@code /api/v1/}, die eine Abweisung nicht mit 404 beantwortet. */
    public static final String SELBSTAUSKUNFT = "/api/v1/me";

    private final ZugriffKontextLader lader;

    public ZugriffFilter(ZugriffKontextLader lader) {
        this.lader = lader;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String pfad = pfad(request);
        return !pfad.startsWith(KUNDENROUTEN) || pfad.startsWith(ADMIN);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        try {
            ZugriffKontextLader.Ergebnis e = lader.laden(SecurityContextHolder.getContext().getAuthentication(),
                    request.getHeader(ZugriffKontextLader.KUNDENBEREICH_HEADER));
            if (e.abgewiesen()) {
                TenantContext.clear();
                if (!SELBSTAUSKUNFT.equals(pfad(request))) {
                    response.sendError(HttpServletResponse.SC_NOT_FOUND);
                    return;
                }
            }
            if (e.zugriff() != null) {
                ZugriffContext.set(e.zugriff());
            }
            filterChain.doFilter(request, response);
        } finally {
            ZugriffContext.clear();
        }
    }

    static String pfad(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String kontext = request.getContextPath();
        return kontext != null && !kontext.isEmpty() && uri.startsWith(kontext) ? uri.substring(kontext.length()) : uri;
    }
}
