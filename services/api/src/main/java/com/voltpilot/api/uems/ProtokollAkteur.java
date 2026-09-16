package com.voltpilot.api.uems;

import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.util.Arrays;
import java.util.Optional;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Der Urheber eines Protokolleintrags im Akteur-Vokabular von AP-03 ({@code actor_sub},
 * {@code actor_name}, {@code actor_rolle}, {@code actor_art}) — dasselbe in Register-Journal,
 * Handeingriff, Befehls-Verlauf und Änderungsprotokoll (AP-03 IP-7, V20260916010000).
 *
 * <p><b>Die EINE Stelle, die aus dem Aufrufer Rolle und Art macht.</b> Sie liest den
 * {@link ZugriffContext} der Anfrage (IP-4), nie einen Anfragekörper:
 * <ul>
 *   <li>Kundenkonto → Art {@code kunde}; Rolle = die, unter der die Anfrage ihr Recht bekam
 *       ({@link ZugriffContext#handelndeRolle()}, gesetzt von der Rechte-Prüfung), sonst die
 *       höchste wirksame Zuweisung; nie zugewiesen → {@code kundenadministrator} (E12).</li>
 *   <li>Angenommene Unterstützung → Art {@code unterstuetzung}, beim Notfall-Zugriff
 *       {@code notfall}; Rolle {@code unterstuetzer} (bzw. die handelnde Rolle).</li>
 *   <li>Plattform am Umschalter {@code X-Tenant-Id} → {@code voltpilot_betrieb}, Art
 *       {@code voltpilot} — wie vor IP-7.</li>
 *   <li>Ohne Zugriff-Kontext (OIDC aus, Token ohne Kontoart): die Festlegung von vor IP-7 —
 *       Plattform-Admin → {@code voltpilot}, sonst {@code kundenadministrator}/{@code kunde}.</li>
 * </ul>
 * Der NAME bleibt, was er war: {@code preferred_username}, sonst {@code name}, sonst das Subject.
 */
public record ProtokollAkteur(String sub, String name, String rolle, String art) {

    static final String ART_KUNDE = "kunde";
    static final String ART_UNTERSTUETZUNG = "unterstuetzung";
    static final String ART_VOLTPILOT = "voltpilot";
    static final String ART_NOTFALL = "notfall";

    /** Dieselbe Realm-Rolle, an der {@code TenantFilter} den Mandanten-Umschalter freigibt. */
    private static final String PLATTFORM_ADMIN = "ROLE_platform-admin";

    /**
     * VoltPilot selbst, ohne Person: die Bestandsübernahme der Standorte (AP-02 IP-9). Im
     * Protokoll steht sie als „VoltPilot (Bestandsübernahme)" ({@link OrtProtokoll}), das
     * Subject ist {@code null} — dasselbe Wort wie der Unternehmen-Backfill (V20260911100000).
     */
    public static ProtokollAkteur bestandsuebernahme() {
        return new ProtokollAkteur(null, "Bestandsübernahme", Rolle.VOLTPILOT_BETRIEB.code(), ART_VOLTPILOT);
    }

    /** Der Urheber des angemeldeten Aufrufers; leer ohne JWT (nur bei abgeschaltetem OIDC). */
    public static Optional<ProtokollAkteur> aus(Authentication auth) {
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)
                || jwt.getSubject() == null || jwt.getSubject().isBlank()) {
            return Optional.empty();
        }
        Object name = jwt.getClaims().get("preferred_username");
        if (name == null) {
            name = jwt.getClaims().get("name");
        }
        boolean plattformAdmin = auth.getAuthorities().stream()
                .anyMatch(a -> PLATTFORM_ADMIN.equals(a.getAuthority()));
        return Optional.of(fuer(ZugriffContext.get(), jwt.getSubject(), name == null ? null : name.toString(),
                plattformAdmin));
    }

    /**
     * Der Urheber der laufenden Anfrage, wenn {@code sub} ihr Aufrufer ist — für die Journale,
     * deren Schreibweg seit jeher nur das Subject weiterreicht (Handeingriffe, Befehls-Verlauf,
     * Register-Journal). Leer ohne Anmeldung (Jobs, Listener) und für ein fremdes Subject: dort
     * wird kein Urheber behauptet.
     */
    public static Optional<ProtokollAkteur> angemeldetAls(String sub) {
        if (sub == null || sub.isBlank()) {
            return Optional.empty();
        }
        return aus(SecurityContextHolder.getContext().getAuthentication()).filter(a -> sub.equals(a.sub()));
    }

    /**
     * Ohne Zugriff-Kontext — die Festlegung von vor IP-7.
     *
     * @param sub das JWT-Subject — die maschinenstabile Identität
     * @param anzeigename {@code preferred_username} bzw. {@code name}; leer → das Subject, damit
     *     der Eintrag immer einen Namen trägt
     * @param plattformAdmin trägt der Aufrufer die Realm-Rolle {@code platform-admin}?
     */
    public static ProtokollAkteur fuer(String sub, String anzeigename, boolean plattformAdmin) {
        return fuer(null, sub, anzeigename, plattformAdmin);
    }

    /** Mit dem Zugriff der Anfrage; ein Kontext eines anderen Subjects zählt nicht. */
    static ProtokollAkteur fuer(Zugriff z, String sub, String anzeigename, boolean plattformAdmin) {
        String name = anzeigename == null || anzeigename.isBlank() ? sub : anzeigename.trim();
        if (z == null || sub == null || !sub.equals(z.sub())) {
            return plattformAdmin
                    ? new ProtokollAkteur(sub, name, Rolle.VOLTPILOT_BETRIEB.code(), ART_VOLTPILOT)
                    : new ProtokollAkteur(sub, name, Rolle.KUNDENADMINISTRATOR.code(), ART_KUNDE);
        }
        Optional<Rolle> handelnd = ZugriffContext.handelndeRolle();
        return switch (z.zugang()) {
            case UMSCHALTER -> new ProtokollAkteur(sub, name, Rolle.VOLTPILOT_BETRIEB.code(), ART_VOLTPILOT);
            case KONTO -> new ProtokollAkteur(sub, name,
                    handelnd.or(() -> hoechsteRolle(z)).map(Rolle::code).orElse(null), ART_KUNDE);
            case UNTERSTUETZUNG -> new ProtokollAkteur(sub, name,
                    handelnd.orElse(Rolle.UNTERSTUETZER).code(),
                    z.zuweisungen().stream().anyMatch(x -> x.art() == Art.NOTFALL) ? ART_NOTFALL : ART_UNTERSTUETZUNG);
        };
    }

    /** Nie zugewiesen = Kundenadministrator (E12); sonst die erste wirksame Rolle in der Reihenfolge der Matrix. */
    private static Optional<Rolle> hoechsteRolle(Zugriff z) {
        if (z.zugang() == Zugang.KONTO && z.bestandskonto()) {
            return Optional.of(Rolle.KUNDENADMINISTRATOR);
        }
        return Arrays.stream(Rolle.values())
                .filter(r -> z.zuweisungen().stream().map(ZugriffRepository.Zeile::rolle).anyMatch(r::equals))
                .findFirst();
    }
}
