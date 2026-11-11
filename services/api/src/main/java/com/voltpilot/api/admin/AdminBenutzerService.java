package com.voltpilot.api.admin;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.benutzer.BenutzerService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.zugriff.ZugriffAenderung;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Plattform-Kontenwege: Zielmandant aus dem geschützten Pfad, Entzugsregeln allein in ZugriffAenderung. */
@Service
@PreAuthorize("hasRole('platform-admin')")
public class AdminBenutzerService {
    private final KeycloakAdminClient keycloak;
    private final ZugriffRepository zugriffe;
    private final ZugriffAenderung aenderung;
    private final BenutzerService benutzer;
    private final TransactionTemplate tx;

    public AdminBenutzerService(KeycloakAdminClient keycloak, ZugriffRepository zugriffe,
            ZugriffAenderung aenderung, BenutzerService benutzer, PlatformTransactionManager transactions) {
        this.keycloak = keycloak;
        this.zugriffe = zugriffe;
        this.aenderung = aenderung;
        this.benutzer = benutzer;
        this.tx = new TransactionTemplate(transactions);
    }

    public KeycloakUser sperren(UUID tenant, String sub) { return aendern(tenant, sub, KontoZustand.GESPERRT); }
    public KeycloakUser aktivieren(UUID tenant, String sub) { return aendern(tenant, sub, KontoZustand.AKTIV); }
    public void entfernen(UUID tenant, String sub) { aendern(tenant, sub, KontoZustand.ENTFERNT); }

    /**
     * P2: „Person hinzufügen" - der Plattform-Admin legt eine WEITERE Person an (nicht nur die erste), mit
     * Rolle und Standorten wie der Kundenadministrator. Dieselbe Reihe wie beim Sperren/Entfernen: im
     * Mandantensprung (UMSCHALTER) ist {@code ZugriffContext.imSprung()} wahr, also lässt
     * {@link BenutzerService#anlegen} die Plattform durch, ohne dass sie je ein Kundenkonto wäre.
     */
    public BenutzerService.Angelegt person(UUID tenant, BenutzerService.Anlage anlage) {
        return imKundenbereich(tenant, akteur -> benutzer.anlegen(anlage, akteur));
    }

    /** N6: der Plattform-Admin vergibt ein neues Startpasswort - derselbe Weg wie der Kundenadministrator. */
    public BenutzerService.Angelegt neuesStartpasswort(UUID tenant, String sub) {
        return imKundenbereich(tenant, akteur -> benutzer.neuVergeben(sub, akteur));
    }

    /**
     * P1 (N1) + P3: „Bearbeiten" ganz machen UND den Anmeldenamen ändern - Keycloak UND der Spiegel
     * ({@code benutzer.anzeigename}/{@code email}) in EINER Transaktion, mit Protokoll {@code konto_geaendert}
     * (Grund = „vorher → nachher", nur wenn sich der Anmeldename ändert). {@code username == null} oder
     * unverändert lässt den Anmeldenamen stehen.
     */
    public KeycloakUser profilAendern(UUID tenant, String sub, String username, String email, String firstName,
            String lastName) {
        return imKundenbereich(tenant, akteur -> {
            KeycloakUser vorher = keycloak.getUser(sub);
            if (!tenant.toString().equals(vorher.tenantId())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found in this tenant");
            }
            String neuerAnmeldename = username != null && !username.isBlank()
                    && !username.trim().equals(vorher.username()) ? username.trim() : null;
            if (neuerAnmeldename != null) {
                BenutzerService.anmeldenamePruefen(neuerAnmeldename);
            }
            // Vor dem Schreiben lesen: nur eine WIRKLICHE Änderung schreibt das Protokoll - ein
            // unverändertes „Speichern" (etwa nur ein anderes Formularfeld berührt) tut es nicht.
            var spiegelVorher = zugriffe.spiegel(sub);
            String anzeigenameVorher = spiegelVorher.map(ZugriffRepository.BenutzerSpiegel::anzeigename).orElse(null);
            String emailVorher = spiegelVorher.map(ZugriffRepository.BenutzerSpiegel::email).orElse(null);
            KeycloakUser nachher = keycloak.updateProfile(sub, neuerAnmeldename, email, firstName, lastName);
            String anzeigename = ((nachher.firstName() == null ? "" : nachher.firstName()) + " "
                    + (nachher.lastName() == null ? "" : nachher.lastName())).trim();
            if (anzeigename.isBlank()) anzeigename = nachher.username();
            zugriffe.benutzerAktualisieren(sub, anzeigename, nachher.email());
            boolean geaendert = neuerAnmeldename != null || !anzeigename.equals(anzeigenameVorher)
                    || !java.util.Objects.equals(nachher.email(), emailVorher);
            if (geaendert) {
                String grund = neuerAnmeldename == null ? null
                        : "Anmeldename: " + vorher.username() + " → " + neuerAnmeldename;
                zugriffe.kontoProtokoll("konto_geaendert", sub, anzeigename, akteur, grund);
            }
            return nachher;
        });
    }

    /** Sperren und lokale Protokolle committen, bevor der Controller die Datenbank abbaut. */
    public List<KeycloakUser> offboardingSperren(UUID tenant) {
        return imKundenbereich(tenant, akteur -> {
            aenderung.sperreKundenbereich();
            List<KeycloakUser> konten = vollstaendigeKonten(tenant);
            for (KeycloakUser konto : konten) {
                zugriffe.benutzerSpiegeln(new BenutzerSpiegel(konto.id(), Konto.BENUTZER, konto.username(),
                        konto.email(), konto.enabled() ? KontoZustand.AKTIV : KontoZustand.GESPERRT));
            }
            aenderung.kundenbereichSperren(konten.stream().map(KeycloakUser::id).toList(), akteur);
            for (KeycloakUser konto : konten) keycloak.setEnabled(konto.id(), false);
            return konten;
        });
    }

    /** Nach dem DB-Abbau existiert kein Spiegel mehr; der Controller erlaubt dies nur ohne Mandant. */
    public List<KeycloakUser> offboardingResteSperren(UUID tenant) {
        List<KeycloakUser> konten = vollstaendigeKonten(tenant);
        for (KeycloakUser konto : konten) keycloak.setEnabled(konto.id(), false);
        return konten;
    }

    private List<KeycloakUser> vollstaendigeKonten(UUID tenant) {
        List<KeycloakUser> konten = keycloak.listUsersForTenant(tenant);
        if (konten.size() >= KeycloakAdminClient.MAX_KONTEN_JE_KUNDENBEREICH) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Kontenliste möglicherweise unvollständig.");
        }
        return konten;
    }

    private KeycloakUser aendern(UUID tenant, String sub, KontoZustand zustand) {
        return imKundenbereich(tenant, akteur -> {
            aenderung.sperreKundenbereich();
            KeycloakUser konto;
            try {
                konto = keycloak.getUser(sub);
            } catch (KeycloakAdminClient.KeycloakAdminException e) {
                // Eine Person OHNE Konto (Spiegel da, Keycloak-Konto weg - etwa ein Entfernen, dessen
                // Keycloak-Hälfte gelang und dessen Datenbank-Hälfte zurückrollte): das Entfernen räumt
                // dann den Spiegel ab, mit demselben Protokoll - sonst stünde die Person für immer ohne
                // Handlung in der Kundenakte. Der Spiegel ist RLS-beschränkt, die Mandantenprüfung ist
                // also sein Vorhandensein in DIESEM Kundenbereich.
                if (e.status() != 404 || zustand != KontoZustand.ENTFERNT
                        || zugriffe.spiegel(sub).isEmpty()) {
                    throw e;
                }
                aenderung.kontoBeenden(sub, true, akteur);
                return null;
            }
            if (!tenant.toString().equals(konto.tenantId())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found in this tenant");
            }
            // Vor E12 kann der lokale Spiegel fehlen. Der Entzug muss auch dann das alte JWT sperren.
            zugriffe.benutzerSpiegeln(new BenutzerSpiegel(sub, Konto.BENUTZER, konto.username(), konto.email(),
                    konto.enabled() ? KontoZustand.AKTIV : KontoZustand.GESPERRT));
            if (zustand == KontoZustand.AKTIV) {
                aenderung.kontoAktivieren(sub, akteur);
                return keycloak.setEnabled(sub, true);
            }
            aenderung.kontoBeenden(sub, zustand == KontoZustand.ENTFERNT, akteur);
            // Erst nach dem Urteil und den lokalen Schreibprüfungen. Upstream-Fehler rollen die DB
            // zurück; eine verteilte Transaktion zwischen Keycloak und PostgreSQL gibt es nicht.
            if (zustand == KontoZustand.GESPERRT) return keycloak.setEnabled(sub, false);
            keycloak.deleteUser(sub);
            return konto;
        });
    }


    private <T> T imKundenbereich(UUID tenant, java.util.function.Function<ProtokollAkteur, T> vorgang) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        var jwt = (Jwt) auth.getPrincipal();
        UUID vorherTenant = TenantContext.get();
        Zugriff vorherZugriff = ZugriffContext.get();
        try {
            // Ausschließlich Plattformrolle; der Pfad bestimmt das Ziel, nie X-Tenant-Id.
            TenantContext.set(tenant);
            ZugriffContext.set(new Zugriff(jwt.getSubject(), Konto.PLATTFORM, tenant, Zugang.UMSCHALTER,
                    List.of(), Instant.now()));
            ProtokollAkteur akteur = ProtokollAkteur.aus(auth).orElseThrow();
            return tx.execute(status -> vorgang.apply(akteur));
        } finally {
            if (vorherZugriff == null) ZugriffContext.clear(); else ZugriffContext.set(vorherZugriff);
            if (vorherTenant == null) TenantContext.clear(); else TenantContext.set(vorherTenant);
        }
    }
}
