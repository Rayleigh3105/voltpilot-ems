package com.voltpilot.api.kundenbereich;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Die Sperre des beendeten Kundenbereichs (UEMS AP-20 IP-16, E10 = A, BT4): EIN Filter vor jeder Route — in der
 * {@code secured}-Kette direkt nach dem {@code ZugriffFilter}, der den Kundenbereich der Anfrage schon angenommen hat
 * (Konto, Unterstützung, Umschalter). Er antwortet, bevor ein Handler, ein Körper-Leser oder eine Transaktion läuft.
 *
 * <p><b>Kundenrouten</b> ({@code /api/v1/**} außer {@code /api/v1/admin/**}) im beendeten Kundenbereich:
 * <ul>
 *   <li>jeder Schreibweg (alles außer GET/HEAD/OPTIONS) → {@code 409 kundenbereich_beendet};</li>
 *   <li>Lesen nur für den Kundenadministrator (Kundenkonto mit wirksamer Zuweisung „Kundenadministrator" oder
 *       Bestandskonto E12) — jede andere Person, Unterstützung und Umschalter bekommt dieselbe 409 („nur der
 *       Kundenadministrator meldet sich noch an", RF-08);</li>
 *   <li>ausgenommen {@code /api/v1/me}: jede Person erfährt dort ({@code kundenbereich.beendet}), was los ist.</li>
 * </ul>
 *
 * <p><b>Plattform-Routen</b>, die einen Kundenbereich im Pfad tragen ({@code /admin/tenants/{id}},
 * {@code /admin/sites/{siteId}}, {@code /admin/devices/{deviceId}}): jeder Schreibweg → 409, außer den Übergängen
 * selbst (beenden, wiederaufnehmen), dem Löschweg (bleibt in IP-16 unverändert; IP-18 verlangt dort „beendet" und die
 * abgelaufene Frist), dem Aufräumen nach dem Löschen und dem Sperren eines Kontos (schützt, ändert keine Daten).
 * Plattform-Routen ohne Kundenbereich (Vorlagen, Releases, Flotten-Rollouts, vorregistrierte Boxen) sperrt er nicht.
 *
 * <p>Welche Routen das sind, liest {@code KundenbereichBeendetApiTest} aus dem Routen-Verzeichnis (NW-5).
 */
public class KundenbereichEndeFilter extends OncePerRequestFilter {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PLATTFORM = "ROLE_" + KeycloakRealmRoleConverter.PLATFORM_ADMIN_ROLE;

    static final String KUNDENROUTEN = "/api/v1/";
    static final String ADMIN = "/api/v1/admin/";
    /** Die Route, die jede Person eines beendeten Kundenbereichs noch liest — die Selbstauskunft trägt den Zustand. */
    public static final Set<String> IMMER_LESBAR = Set.of("/api/v1/me");

    private static final String UUID_MUSTER = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
    private static final Pattern ADMIN_KUNDENBEREICH = Pattern.compile("^/api/v1/admin/tenants/" + UUID_MUSTER + "(/.*)?$");
    private static final Pattern ADMIN_ANLAGE = Pattern.compile("^/api/v1/admin/sites/" + UUID_MUSTER + "(/.*)?$");
    private static final Pattern ADMIN_BOX = Pattern.compile("^/api/v1/admin/devices/" + UUID_MUSTER + "(/.*)?$");

    /**
     * Plattform-Schreibwege, die im beendeten Kundenbereich bleiben — als Rest hinter {@code /admin/tenants/{id}}.
     * {@code KundenbereichBeendetApiTest} hält die Liste genau (jeder Eintrag hat seine Route).
     */
    public static final List<Pattern> ADMIN_AUSNAHMEN = List.of(
            Pattern.compile("^/beenden$"),
            Pattern.compile("^/wiederaufnehmen$"),
            Pattern.compile("^/delete$"),
            Pattern.compile("^/offboarding/cleanup$"),
            Pattern.compile("^/users/[^/]+/disable$"));

    private final ObjectProvider<KundenbereichEndeRepository> zustand;

    public KundenbereichEndeFilter(ObjectProvider<KundenbereichEndeRepository> zustand) {
        this.zustand = zustand;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !pfad(request).startsWith(KUNDENROUTEN);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        KundenbereichEndeRepository repo = zustand.getIfAvailable();
        if (repo == null) {
            filterChain.doFilter(request, response);
            return;
        }
        String pfad = pfad(request);
        boolean schreibend = schreibend(request.getMethod());
        if (pfad.startsWith(ADMIN)) {
            // Der Filter steht VOR der Autorisierung: nur einer Plattform-Rolle verrät er den Zustand — jeder andere
            // Aufrufer geht weiter und bekommt dort seine 401/403, nie eine 409 mit Daten eines Kundenbereichs.
            if (schreibend && plattform()) {
                Optional<KundenbereichEnde> ende = kundenbereichImAdminPfad(pfad, repo).flatMap(repo::beendet);
                if (ende.isPresent()) {
                    antworte(response, ende.get(), ende.get().text());
                    return;
                }
            }
            filterChain.doFilter(request, response);
            return;
        }
        UUID kundenbereich = TenantContext.get();
        Optional<KundenbereichEnde> ende = kundenbereich == null ? Optional.empty() : repo.beendet(kundenbereich);
        if (ende.isEmpty() || (!schreibend && IMMER_LESBAR.contains(pfad))) {
            filterChain.doFilter(request, response);
            return;
        }
        boolean kundenadministrator = kundenadministrator(ZugriffContext.get());
        if (!kundenadministrator) {
            antworte(response, ende.get(), ende.get().textNurKundenadministrator());
            return;
        }
        if (schreibend) {
            antworte(response, ende.get(), ende.get().text());
            return;
        }
        filterChain.doFilter(request, response);
    }

    /** Der Kundenadministrator liest im beendeten Kundenbereich weiter — nur sein eigenes Konto, nie ein Dritter. */
    public static boolean kundenadministrator(ZugriffContext.Zugriff z) {
        return z != null && z.zugang() == ZugriffContext.Zugang.KONTO
                && (z.bestandskonto() || z.zuweisungen().stream().anyMatch(x -> x.rolle() == Rolle.KUNDENADMINISTRATOR));
    }

    private static boolean plattform() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.isAuthenticated() && auth.getAuthorities().stream()
                .anyMatch(a -> PLATTFORM.equals(a.getAuthority()));
    }

    static boolean schreibend(String methode) {
        return !("GET".equals(methode) || "HEAD".equals(methode) || "OPTIONS".equals(methode));
    }

    /** Der Kundenbereich, den eine Plattform-Route im Pfad trägt — leer für Ausnahmen und Routen ohne Kundenbereich. */
    static Optional<UUID> kundenbereichImAdminPfad(String pfad, KundenbereichEndeRepository repo) {
        Matcher m = ADMIN_KUNDENBEREICH.matcher(pfad);
        if (m.matches()) {
            String rest = m.group(2) == null ? "" : m.group(2);
            boolean ausnahme = ADMIN_AUSNAHMEN.stream().anyMatch(a -> a.matcher(rest).matches());
            return ausnahme ? Optional.empty() : Optional.of(UUID.fromString(m.group(1)));
        }
        m = ADMIN_ANLAGE.matcher(pfad);
        if (m.matches()) {
            return repo.kundenbereichDerAnlage(UUID.fromString(m.group(1)));
        }
        m = ADMIN_BOX.matcher(pfad);
        if (m.matches()) {
            return repo.kundenbereichDerBox(UUID.fromString(m.group(1)));
        }
        return Optional.empty();
    }

    private static void antworte(HttpServletResponse response, KundenbereichEnde ende, String satz) throws IOException {
        response.setStatus(HttpServletResponse.SC_CONFLICT);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(JSON.writeValueAsString(ende.koerper(satz)));
    }

    static String pfad(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String kontext = request.getContextPath();
        return kontext != null && !kontext.isEmpty() && uri.startsWith(kontext) ? uri.substring(kontext.length()) : uri;
    }
}
