package com.voltpilot.api.zugriff;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

/**
 * Lädt den {@link ZugriffContext} einer Anfrage (UEMS AP-03 IP-4) — nach dem {@code TenantFilter}, der den
 * Kundenbereich des Kundenkontos (Token) und den Umschalter der Plattform ({@code X-Tenant-Id}) schon gesetzt hat.
 *
 * <ul>
 *   <li><b>Kundenkonto</b> ({@code KONTO_benutzer}): der Kundenbereich bleibt der aus dem Token; geladen werden die
 *       wirksamen Zuweisungen. Ein Kundenkonto wird hier NIE abgewiesen — noch setzt niemand durch (IP-5 ff.).</li>
 *   <li><b>Partner und Plattform mit {@code X-Kundenbereich}</b>: angenommen NUR gegen eine wirksame Unterstützung
 *       des Kontos in genau diesem Kundenbereich — Partner: Installateur; Plattform: VoltPilot oder Notfall-Zugriff.
 *       Dann ist er der Kundenbereich der Anfrage ({@code TenantContext}); sonst abgewiesen.</li>
 *   <li><b>Partner ohne den Kopf</b>: abgewiesen.</li>
 *   <li><b>Plattform ohne den Kopf</b>: der heutige Umschalter gilt unverändert — mit {@code X-Tenant-Id} der
 *       Kundenbereich, ohne ihn keiner. Die Umstellung auf die Unterstützung ist IP-8 (AP-03 W3).</li>
 * </ul>
 *
 * <p>Die Kontoart kommt allein aus {@code KONTO_*} des {@link KeycloakRealmRoleConverter}. Ein Lesefehler bei der
 * Annahme weist ab; beim Kundenkonto bleibt der Kontext ohne Zuweisung — beides mit Log und Zähler
 * {@code voltpilot_zugriff_kontext_total{ergebnis="fehler"}}.
 */
@Component
public class ZugriffKontextLader {

    /** Der Kopf, mit dem ein Partner- oder Plattform-Konto seinen Kundenbereich wählt (AP-03 §6.2). */
    public static final String KUNDENBEREICH_HEADER = "X-Kundenbereich";

    private static final Logger log = LoggerFactory.getLogger(ZugriffKontextLader.class);

    private final ZugriffRepository zugriffe;
    private final MeterRegistry metriken;
    private volatile Clock uhr = Clock.systemUTC();

    public ZugriffKontextLader(ZugriffRepository zugriffe, MeterRegistry metriken) {
        this.zugriffe = zugriffe;
        this.metriken = metriken;
    }

    /** Ein Zugriff, keiner (kein Kundenbereich im Spiel) oder abgewiesen (404 auf jeder Kundenroute). */
    public record Ergebnis(Zugriff zugriff, boolean abgewiesen) {
        static Ergebnis keiner() {
            return new Ergebnis(null, false);
        }

        static Ergebnis abgewiesenOhneZugriff() {
            return new Ergebnis(null, true);
        }

        static Ergebnis mit(Zugriff z) {
            return new Ergebnis(z, false);
        }
    }

    /** Der Zeitpunkt, zu dem „wirksam" gilt. */
    public Instant jetzt() {
        return uhr.instant();
    }

    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * @param auth die Authentifizierung der Anfrage (nach dem Konverter)
     * @param kundenbereichKopf der Wert von {@code X-Kundenbereich} oder {@code null}
     */
    public Ergebnis laden(Authentication auth, String kundenbereichKopf) {
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)
                || jwt.getSubject() == null || jwt.getSubject().isBlank()) {
            return Ergebnis.keiner();
        }
        Konto konto = konto(auth);
        if (konto == null) {
            return Ergebnis.keiner();
        }
        String sub = jwt.getSubject();
        Instant jetzt = uhr.instant();
        if (konto == Konto.BENUTZER) {
            UUID tenant = TenantContext.get();
            return tenant == null
                    ? Ergebnis.keiner()
                    : Ergebnis.mit(new Zugriff(sub, konto, tenant, Zugang.KONTO, zuweisungen(sub, jetzt), jetzt));
        }
        if (kundenbereichKopf != null && !kundenbereichKopf.isBlank()) {
            return unterstuetzung(sub, konto, kundenbereichKopf.trim(), jetzt);
        }
        if (konto == Konto.PLATTFORM) {
            UUID umschalter = TenantContext.get();
            return umschalter == null
                    ? Ergebnis.keiner()
                    : Ergebnis.mit(new Zugriff(sub, konto, umschalter, Zugang.UMSCHALTER, List.of(), jetzt));
        }
        zaehle("abgewiesen");
        return Ergebnis.abgewiesenOhneZugriff();
    }

    /** Die Kontoart aus {@code KONTO_<code>}; {@code null}, wenn der Konverter keine abgelegt hat. */
    public static Konto konto(Authentication auth) {
        for (GrantedAuthority a : auth.getAuthorities()) {
            String s = a.getAuthority();
            if (s != null && s.startsWith(KeycloakRealmRoleConverter.KONTO_PREFIX)) {
                return Konto.vonCode(s.substring(KeycloakRealmRoleConverter.KONTO_PREFIX.length()));
            }
        }
        return null;
    }

    /** Trägt diese Zeile eine Unterstützung, die das Konto in einen Kundenbereich lässt? */
    static boolean gilt(Konto konto, Zeile z) {
        if (z.rolle() != Rolle.UNTERSTUETZER || z.art() == null) {
            return false;
        }
        return switch (konto) {
            case PARTNER -> z.art() == Art.INSTALLATEUR;
            case PLATTFORM -> z.art() == Art.VOLTPILOT || z.art() == Art.NOTFALL;
            case BENUTZER -> false;
        };
    }

    private List<Zeile> zuweisungen(String sub, Instant jetzt) {
        try {
            return zugriffe.wirksam(sub, jetzt);
        } catch (RuntimeException e) {
            log.warn("Zuweisungen von {} nicht lesbar - Kontext ohne Zuweisung: {}", sub, e.toString());
            zaehle("fehler");
            return List.of();
        }
    }

    private Ergebnis unterstuetzung(String sub, Konto konto, String kopf, Instant jetzt) {
        UUID kandidat;
        try {
            kandidat = UUID.fromString(kopf);
        } catch (IllegalArgumentException e) {
            zaehle("abgewiesen");
            return Ergebnis.abgewiesenOhneZugriff();
        }
        UUID vorher = TenantContext.get();
        List<Zeile> zeilen;
        TenantContext.set(kandidat);
        try {
            zeilen = zugriffe.wirksam(sub, jetzt).stream().filter(z -> gilt(konto, z)).toList();
        } catch (RuntimeException e) {
            log.warn("Unterstützung von {} nicht lesbar - {} abgewiesen: {}", sub, KUNDENBEREICH_HEADER, e.toString());
            zaehle("fehler");
            zeilen = List.of();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
        if (zeilen.isEmpty()) {
            zaehle("abgewiesen");
            return Ergebnis.abgewiesenOhneZugriff();
        }
        TenantContext.set(kandidat);
        zaehle("unterstuetzung");
        return Ergebnis.mit(new Zugriff(sub, konto, kandidat, Zugang.UNTERSTUETZUNG, zeilen, jetzt));
    }

    private void zaehle(String ergebnis) {
        Counter.builder("voltpilot.zugriff.kontext").tag("ergebnis", ergebnis).register(metriken).increment();
    }
}
