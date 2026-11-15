package com.voltpilot.api.fleet;

import com.voltpilot.api.web.dto.AdminDevicesDto;
import com.voltpilot.api.web.dto.AdminFleetDto;
import com.voltpilot.api.web.dto.EdgeUpdatesDto;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Die drei Flotten-Antworten der Plattform-Seiten - {@code GET /api/v1/admin/fleet}, {@code /admin/edge-updates}
 * und {@code /admin/devices} - kurz festgehalten (Lasttest vp-lasttest, Befund B6, Rang 5). Jede rechnet die
 * ganze Flotte; die Seiten fragen alle 30 s ab, und jeder offene Admin-Tab rechnete bisher selbst (bei 2 000 Boxen
 * je Abruf 1,4-4,4 MB und 0,7-3,6 s, unter Last bis 6,5 s). Jetzt gilt eine Antwort {@code
 * voltpilot.admin.flotte-speicher-ms} lang (Vorgabe 15 s) für alle Plattform-Administratoren, und gleichzeitige
 * Abrufe warten auf EINE Berechnung.
 *
 * <p><b>Warum für alle dieselbe Antwort richtig ist:</b> die drei Routen verlangen {@code platform-admin}, lesen
 * über die BYPASSRLS-Rolle und hängen weder an der Person noch am gewählten Kundenbereich - jede
 * Plattform-Administratorin bekäme Byte für Byte dasselbe.
 *
 * <p><b>Nach einer eigenen Handlung nie alt:</b> jede schreibende Anfrage unter {@code /api/v1/admin/} (alles
 * außer GET, HEAD, OPTIONS) zählt den Schreibstand vor UND nach ihrer Verarbeitung weiter ({@link Schreibstand});
 * eine festgehaltene Antwort, deren Berechnung vor diesem Stand begann, gilt danach nicht mehr. Wer eine
 * Aktualisierung verteilt und die Seite neu lädt, sieht sie sofort. Was ohne Admin-Handlung geschieht (eine Box
 * meldet ihren Stand, der Rollout-Wächter schreibt), erscheint spätestens nach der Gültigkeit - die Seiten fragen
 * ohnehin nur alle 30 s.
 */
@Component
public class AdminFlottenSpeicher {

    private final AtomicLong stand = new AtomicLong();
    private final KurzSpeicher<AdminFleetDto> flotte;
    private final KurzSpeicher<EdgeUpdatesDto> edgeUpdates;
    private final KurzSpeicher<AdminDevicesDto> geraete;

    @Autowired
    public AdminFlottenSpeicher(@Value("${voltpilot.admin.flotte-speicher-ms:15000}") long gueltigMs) {
        this(Duration.ofMillis(gueltigMs), Clock.systemUTC());
    }

    public AdminFlottenSpeicher(Duration gueltig, Clock clock) {
        this.flotte = new KurzSpeicher<>(gueltig, clock, stand);
        this.edgeUpdates = new KurzSpeicher<>(gueltig, clock, stand);
        this.geraete = new KurzSpeicher<>(gueltig, clock, stand);
    }

    /** Ein Speicher, der nie festhält - für Tests und Aufrufer ohne Spring. */
    public static AdminFlottenSpeicher aus() {
        return new AdminFlottenSpeicher(Duration.ZERO, Clock.systemUTC());
    }

    public AdminFleetDto flotte(Supplier<AdminFleetDto> rechne) {
        return flotte.hole(rechne);
    }

    public EdgeUpdatesDto edgeUpdates(Supplier<EdgeUpdatesDto> rechne) {
        return edgeUpdates.hole(rechne);
    }

    public AdminDevicesDto geraete(Supplier<AdminDevicesDto> rechne) {
        return geraete.hole(rechne);
    }

    /** Jede festgehaltene Antwort gilt ab jetzt nicht mehr. */
    public void veraltet() {
        stand.incrementAndGet();
    }

    /**
     * Zählt den Schreibstand bei jeder schreibenden Admin-Anfrage weiter - davor (eine gleichzeitig begonnene
     * Berechnung gilt nicht mehr) und danach (eine Berechnung, die während der Schreibhandlung begann und den
     * alten Stand las, gilt ebenfalls nicht mehr).
     */
    @Component
    public static class Schreibstand extends OncePerRequestFilter {

        private static final Set<String> LESEND = Set.of("GET", "HEAD", "OPTIONS");
        private final AdminFlottenSpeicher speicher;

        public Schreibstand(AdminFlottenSpeicher speicher) {
            this.speicher = speicher;
        }

        @Override
        protected boolean shouldNotFilter(HttpServletRequest request) {
            return LESEND.contains(request.getMethod())
                    || !request.getRequestURI().startsWith(request.getContextPath() + "/api/v1/admin/");
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                FilterChain filterChain) throws ServletException, IOException {
            speicher.veraltet();
            try {
                filterChain.doFilter(request, response);
            } finally {
                speicher.veraltet();
            }
        }
    }
}
