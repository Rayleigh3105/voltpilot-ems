package com.voltpilot.api.zugriff;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
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
import org.springframework.beans.factory.annotation.Value;
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
 *   <li><b>Plattform ohne den Kopf</b>: der Mandanten-Umschalter {@code X-Tenant-Id} — mit ihm der Kundenbereich,
 *       ohne ihn keiner. <b>Er ist seit IP-8 abschaltbar</b> ({@code voltpilot.uems.unterstuetzung.umschalter-enabled},
 *       Vorgabe AN = das heutige Verhalten): AUS wird eine Plattform ohne wirksame Unterstützung auf jeder
 *       Kundenroute abgewiesen wie ein Partner ohne Gewährung — das ist der Satz aus A5 („nicht der heutige
 *       {@code X-Tenant-Id}-Vollzugriff"). Umgelegt wird der Schalter mit der Portal-Umstellung (IP-15), damit die
 *       Admin-Konsole nicht vor ihr blind wird; bis dahin ist der Weg über Anfrage und Notfall-Zugriff der
 *       sichtbare, nicht der einzige (AP-03 W3).</li>
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
    private final boolean umschalter;
    private volatile Clock uhr = Clock.systemUTC();

    public ZugriffKontextLader(ZugriffRepository zugriffe, MeterRegistry metriken,
            @Value("${voltpilot.uems.unterstuetzung.umschalter-enabled:true}") boolean umschalter) {
        this.zugriffe = zugriffe;
        this.metriken = metriken;
        this.umschalter = umschalter;
    }

    /** Gilt der Mandanten-Umschalter {@code X-Tenant-Id} auf Kundenrouten noch? (AP-03 W3, IP-8) */
    public boolean umschalterGilt() {
        return umschalter;
    }

    /**
     * Ein Zugriff, keiner (kein Kundenbereich im Spiel) oder abgewiesen (404 auf jeder Kundenroute).
     *
     * @param beendet gesetzt, wenn die Abweisung ein ENTZUG ist (IP-9): der Aufrufer hatte hier einmal Zugang,
     *     und der ist vorbei. Dann sagt die 404 das auch — {@code zugriff_beendet} mit dem Satz des Vertrags,
     *     statt schweigend die Existenz zu verneinen. Ohne frühere Zuweisung bleibt es bei der stummen 404.
     */
    public record Ergebnis(Zugriff zugriff, boolean abgewiesen, ZugriffBeendet beendet, boolean kontoUngueltig) {
        static Ergebnis entferntesKonto() {
            return new Ergebnis(null, true, null, true);
        }

        static Ergebnis keiner() {
            return new Ergebnis(null, false, null, false);
        }

        static Ergebnis abgewiesenOhneZugriff() {
            return new Ergebnis(null, true, null, false);
        }

        static Ergebnis abgewiesenWeilBeendet(ZugriffBeendet b) {
            return new Ergebnis(null, true, b, false);
        }

        static Ergebnis mit(Zugriff z) {
            return new Ergebnis(z, false, null, false);
        }

        static Ergebnis mit(Zugriff z, ZugriffBeendet b) {
            return new Ergebnis(z, false, b, false);
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
            if (tenant == null) {
                return Ergebnis.keiner();
            }
            if (!zugriffe.kundenbereichVorhanden()) {
                return Ergebnis.entferntesKonto();
            }
            var spiegel = zugriffe.spiegel(sub);
            if (spiegel.filter(b -> b.zustand() == KontoZustand.GESPERRT
                    || b.zustand() == KontoZustand.ENTFERNT).isPresent()) {
                // Auch ein altes JWT und die E12-Bestandsregel dürfen die Kontosperre nicht umgehen.
                return Ergebnis.mit(new Zugriff(sub, konto, tenant, Zugang.KONTO, List.of(), jetzt),
                        ZugriffBeendet.standort(null));
            }
            ZugriffRepository.Stand stand = stand(sub, jetzt);
            Zugriff z = new Zugriff(sub, konto, tenant, Zugang.KONTO, stand.wirksam(), jetzt,
                    stand.wirksam().isEmpty() && bestandskonto(sub), stand.vorbei());
            // A6: kein wirksamer Zugriff mehr, aber einmal einer da gewesen — der Entzug wirkt mit DIESER Anfrage.
            return z.jederZugriffBeendet() ? Ergebnis.mit(z, ZugriffBeendet.standort(letzterStandort(stand.vorbei())))
                    : Ergebnis.mit(z);
        }
        if (kundenbereichKopf != null && !kundenbereichKopf.isBlank()) {
            return unterstuetzung(sub, konto, kundenbereichKopf.trim(), jetzt);
        }
        if (konto == Konto.PLATTFORM) {
            UUID gewaehlt = TenantContext.get();
            if (gewaehlt == null) {
                return Ergebnis.keiner();
            }
            if (!umschalter) {
                // A5: ohne gewährte Unterstützung oder Notfall-Zugriff ist ein Kundenbereich für VoltPilot
                // nicht da - dieselbe 404 wie für einen Partner ohne Gewährung. /api/v1/admin/** bleibt
                // unberührt, dort filtert der ZugriffFilter gar nicht.
                zaehle("abgewiesen");
                return Ergebnis.abgewiesenOhneZugriff();
            }
            return Ergebnis.mit(new Zugriff(sub, konto, gewaehlt, Zugang.UMSCHALTER, List.of(), jetzt));
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

    /**
     * Die Bestandsregel E12 in der Anfrage — jetzt mit STICHTAG ({@code V20260916060000}): ein Bestandskonto hatte in
     * diesem Kundenbereich NIE eine Zuweisung (auch keine beendete oder künftige) UND der Kundenbereich ist noch nicht
     * übernommen. Nach der Übernahme ist ein Konto ohne Zuweisung ein NEUES Konto und bekommt den engsten Zaun.
     *
     * <p>Ein Lesefehler heißt nein, also der enge Zaun.
     */
    private boolean bestandskonto(String sub) {
        try {
            return zugriffe.bestandskonto(sub);
        } catch (RuntimeException e) {
            log.warn("Zuweisungs-Geschichte von {} nicht lesbar - enger Zaun: {}", sub, e.toString());
            zaehle("fehler");
            return false;
        }
    }

    private ZugriffRepository.Stand stand(String sub, Instant jetzt) {
        try {
            return zugriffe.stand(sub, jetzt);
        } catch (RuntimeException e) {
            log.warn("Zuweisungen von {} nicht lesbar - Kontext ohne Zuweisung: {}", sub, e.toString());
            zaehle("fehler");
            return new ZugriffRepository.Stand(List.of(), List.of());
        }
    }

    /**
     * Der Standort, den der Satz „Ihr Zugriff auf … wurde beendet." nennt: der Name aus der ZULETZT beendeten
     * Zuweisung. Eine unternehmensweite Zuweisung trägt keinen — dann bleibt der Satz ohne Standort
     * ({@link ZugriffBeendet#standort}).
     */
    private static String letzterStandort(List<Zeile> vorbei) {
        String name = null;
        Instant spaetestes = null;
        for (Zeile z : vorbei) {
            Instant ende = z.beendetAm() != null ? z.beendetAm() : z.endetAm();
            if (z.standortName() != null && (spaetestes == null || ende == null || ende.isAfter(spaetestes))) {
                name = z.standortName();
                spaetestes = ende;
            }
        }
        return name;
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
        List<Zeile> vorbei;
        String kundenbereichName = null;
        TenantContext.set(kandidat);
        try {
            ZugriffRepository.Stand stand = zugriffe.stand(sub, jetzt);
            zeilen = stand.wirksam().stream().filter(z -> gilt(konto, z)).toList();
            vorbei = stand.vorbei().stream().filter(z -> gilt(konto, z)).toList();
            if (zeilen.isEmpty() && !vorbei.isEmpty()) {
                kundenbereichName = zugriffe.kundenbereichKopf().name();
            }
        } catch (RuntimeException e) {
            log.warn("Unterstützung von {} nicht lesbar - {} abgewiesen: {}", sub, KUNDENBEREICH_HEADER, e.toString());
            zaehle("fehler");
            zeilen = List.of();
            vorbei = List.of();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
        if (zeilen.isEmpty()) {
            zaehle("abgewiesen");
            // Wer hier NIE eine Unterstützung hatte, erfährt nichts — auch nicht, dass es den Kundenbereich gibt
            // (W2). Wer eine HATTE, kennt ihn längst; ihm sagt die 404, dass sie beendet ist (§4.7, A4).
            return vorbei.isEmpty() || kundenbereichName == null
                    ? Ergebnis.abgewiesenOhneZugriff()
                    : Ergebnis.abgewiesenWeilBeendet(ZugriffBeendet.unterstuetzung(kundenbereichName));
        }
        TenantContext.set(kandidat);
        zaehle("unterstuetzung");
        return Ergebnis.mit(new Zugriff(sub, konto, kandidat, Zugang.UNTERSTUETZUNG, zeilen, jetzt));
    }

    private void zaehle(String ergebnis) {
        Counter.builder("voltpilot.zugriff.kontext").tag("ergebnis", ergebnis).register(metriken).increment();
    }
}
