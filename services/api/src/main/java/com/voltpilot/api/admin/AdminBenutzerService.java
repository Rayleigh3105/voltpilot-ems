package com.voltpilot.api.admin;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
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
    private final TransactionTemplate tx;

    public AdminBenutzerService(KeycloakAdminClient keycloak, ZugriffRepository zugriffe,
            ZugriffAenderung aenderung, PlatformTransactionManager transactions) {
        this.keycloak = keycloak;
        this.zugriffe = zugriffe;
        this.aenderung = aenderung;
        this.tx = new TransactionTemplate(transactions);
    }

    public KeycloakUser sperren(UUID tenant, String sub) { return aendern(tenant, sub, KontoZustand.GESPERRT); }
    public KeycloakUser aktivieren(UUID tenant, String sub) { return aendern(tenant, sub, KontoZustand.AKTIV); }
    public void entfernen(UUID tenant, String sub) { aendern(tenant, sub, KontoZustand.ENTFERNT); }

    private KeycloakUser aendern(UUID tenant, String sub, KontoZustand zustand) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        var jwt = (Jwt) auth.getPrincipal();
        UUID vorherTenant = TenantContext.get();
        Zugriff vorherZugriff = ZugriffContext.get();
        try {
            // Admin-Routen durchlaufen den ZugriffFilter absichtlich nicht. Der Rollencheck oben erlaubt
            // diesen Kontext nur für den Plattformweg; X-Tenant-Id darf das Pfadziel nicht umbiegen.
            TenantContext.set(tenant);
            ZugriffContext.set(new Zugriff(jwt.getSubject(), Konto.PLATTFORM, tenant, Zugang.UMSCHALTER,
                    List.of(), Instant.now()));
            ProtokollAkteur akteur = ProtokollAkteur.aus(auth).orElseThrow();
            return tx.execute(status -> {
                aenderung.sperreKundenbereich();
                KeycloakUser konto = keycloak.getUser(sub);
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
        } finally {
            if (vorherZugriff == null) ZugriffContext.clear(); else ZugriffContext.set(vorherZugriff);
            if (vorherTenant == null) TenantContext.clear(); else TenantContext.set(vorherTenant);
        }
    }
}
