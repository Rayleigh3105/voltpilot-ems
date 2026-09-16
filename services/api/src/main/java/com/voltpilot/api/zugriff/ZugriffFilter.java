package com.voltpilot.api.zugriff;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.MediaType;
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
 * <p><b>Der Entzug wirkt hier (IP-9).</b> Hat ein Kundenkonto JEDE Zuweisung verloren, die es einmal hatte, ist
 * jede Kundenroute 404 {@code zugriff_beendet} — nicht eine leere Liste, die wie „Sie haben keine Anlagen" aussähe
 * (A6). Ein Partner, dessen Unterstützung endete, bekommt denselben Körper mit seinem Satz. Weil dieser Filter vor
 * jeder Kundenroute steht, gibt es keinen Weg daran vorbei; {@code /api/v1/me} bleibt ausgenommen, damit das Portal
 * die neue Startansicht (den Leerzustand L3) noch rechnen kann.
 *
 * <p>Der {@link ZugriffContext} wird im {@code finally} abgeräumt, so wie der {@code TenantFilter} seinen
 * Kundenbereich abräumt — ein Thread des Pools trägt nie den Zugriff der vorigen Anfrage.
 */
public class ZugriffFilter extends OncePerRequestFilter {

    private static final ObjectMapper JSON = new ObjectMapper();

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
            boolean selbstauskunft = SELBSTAUSKUNFT.equals(pfad(request));
            if (e.abgewiesen()) {
                TenantContext.clear();
                if (!selbstauskunft) {
                    antworte(response, e.beendet());
                    return;
                }
            } else if (e.beendet() != null && !selbstauskunft) {
                // Der Kundenbereich bleibt (das Konto gehört weiter dazu), aber es ist kein Zugriff mehr da.
                antworte(response, e.beendet());
                return;
            }
            if (e.zugriff() != null) {
                ZugriffContext.set(e.zugriff());
            }
            filterChain.doFilter(request, response);
        } finally {
            ZugriffContext.clear();
        }
    }

    /** 404 — mit dem Grund, wenn der Zugang einmal da war, sonst stumm wie bisher. */
    private static void antworte(HttpServletResponse response, ZugriffBeendet beendet) throws IOException {
        if (beendet == null) {
            response.sendError(HttpServletResponse.SC_NOT_FOUND);
            return;
        }
        response.setStatus(HttpServletResponse.SC_NOT_FOUND);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(JSON.writeValueAsString(beendet.koerper()));
    }

    static String pfad(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String kontext = request.getContextPath();
        return kontext != null && !kontext.isEmpty() && uri.startsWith(kontext) ? uri.substring(kontext.length()) : uri;
    }
}
