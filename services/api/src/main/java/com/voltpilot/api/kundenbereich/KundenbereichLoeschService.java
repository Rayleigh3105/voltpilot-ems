package com.voltpilot.api.kundenbereich;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.AdminBenutzerService;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.geraete.BoxLoesenAbgelehnt;
import com.voltpilot.api.geraete.BoxLoesenService;
import com.voltpilot.api.kundenbereich.KundenbereichLoeschlaufRepository.Lauf;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.repo.TenantRepository.OffboardCounts;
import com.voltpilot.api.repo.TenantRepository.TenantDevice;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.TenantOffboardingCleanupDto;
import com.voltpilot.api.web.dto.TenantOffboardingReportDto;
import com.voltpilot.api.web.dto.TenantDto;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

/**
 * Der Löschweg als serverseitiger Auftrag (vp-kunde-loeschen-504): in Produktion brauchte der Zug
 * ~60 s, der Ingress (60-s-Grenze) antwortete 504, und das Portal meldete fälschlich
 * „fehlgeschlagen", obwohl der Zug durchlief. Das Löschen hängt darum an KEINEM HTTP-Request mehr:
 * {@link #starte} legt den {@link Lauf} an (je Bereich höchstens einen laufenden - ein Doppelklick
 * bekommt denselben zurück) und arbeitet ihn auf einem eigenen Thread ab; das Portal fragt
 * {@link #stand} ab, bis der Lauf fertig oder mit ehrlichem Satz gescheitert ist.
 *
 * <p>Die Semantik des Zugs ist unverändert (vp-kunde-loeschen-500): Konten sperren committet
 * zuerst; der DB-Abbau ist EINE Transaktion - ein Fehler rollt alles zurück, nichts ist gelöscht,
 * die Konten bleiben gesperrt, der Weg ist wiederholbar. Neu ist nur, WO der Zug läuft und dass
 * sein Stand in {@code kundenbereich_loeschlauf} steht: „fertig" schreibt die Abbau-Transaktion
 * selbst (fertig heißt committed), ein Absturz davor hinterlässt „laeuft" mit verhungertem
 * Herzschlag, und {@link #aufgeloest} macht daraus ehrlich „gescheitert - nichts gelöscht"
 * (Mandant noch da) oder „fertig" (Mandant weg, nur der Bericht fehlt).
 */
@Service
public class KundenbereichLoeschService {

    private static final Logger log = LoggerFactory.getLogger(KundenbereichLoeschService.class);

    /** Nach so vielen Sekunden ohne Herzschlag gilt ein „laufender" Zug als verwaist (6 Schläge). */
    static final String VERWAIST_NACH = "180 seconds";

    static final String SATZ_FEHLGESCHLAGEN = "Beim Löschen ist ein Fehler aufgetreten - es wurde"
            + " nichts gelöscht. Die Konten des Kunden bleiben gesperrt; bitte versuchen Sie es erneut.";
    static final String SATZ_KONTEN = "Die Benutzerverwaltung ist gerade nicht erreichbar - es wurde"
            + " nichts gelöscht. Bitte versuchen Sie es später erneut.";
    static final String SATZ_UNTERBROCHEN = "Der Löschzug wurde unterbrochen (z. B. durch einen"
            + " Neustart des Servers) - es wurde nichts gelöscht. Die Konten des Kunden bleiben"
            + " gesperrt; bitte versuchen Sie es erneut.";

    private final TenantRepository tenants;
    private final AdminBenutzerService adminBenutzer;
    private final KundenbereichLoeschung loeschung;
    private final BoxLoesenService boxLoesen;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final KeycloakAdminClient keycloak;
    private final KundenbereichLoeschlaufRepository laeufe;
    private final ObjectMapper json;

    /** EIN Zug zur Zeit: auch Läufe verschiedener Bereiche laufen nacheinander, nie gegeneinander. */
    private final ExecutorService zug = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "kundenbereich-loeschzug");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService herz = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "kundenbereich-loeschzug-herzschlag");
        t.setDaemon(true);
        return t;
    });

    public KundenbereichLoeschService(TenantRepository tenants, AdminBenutzerService adminBenutzer,
            KundenbereichLoeschung loeschung, BoxLoesenService boxLoesen,
            ObjectProvider<ProvisioningPublisher> provisioning, KeycloakAdminClient keycloak,
            KundenbereichLoeschlaufRepository laeufe, ObjectMapper json) {
        this.tenants = tenants;
        this.adminBenutzer = adminBenutzer;
        this.loeschung = loeschung;
        this.boxLoesen = boxLoesen;
        this.provisioning = provisioning;
        this.keycloak = keycloak;
        this.laeufe = laeufe;
        this.json = json;
    }

    @PreDestroy
    void anhalten() {
        // Kein Warten: ein abgebrochener Zug rollt in der Datenbank zurück, und der verhungerte
        // Herzschlag macht den Lauf beim nächsten Blick ehrlich „gescheitert - nichts gelöscht".
        zug.shutdownNow();
        herz.shutdownNow();
    }

    /**
     * Startet den Löschzug für den (geprüften) Kundenbereich - oder liefert den schon laufenden
     * Lauf zurück (ein zweiter Versuch startet nie einen zweiten Zug). {@code auth} ist die
     * Anmeldung des startenden Plattform-Admins: der Zug trägt sie auf seinen Arbeits-Thread
     * weiter, denn die Konten-Sperrung ({@code AdminBenutzerService.imKundenbereich}) liest den
     * Akteur aus dem SecurityContext des Threads - ohne sie bräche jeder Lauf dort ab.
     */
    public Lauf starte(TenantDto tenant, ProtokollAkteur akteur, Authentication auth) {
        laeufe.juengster(tenant.id()).ifPresent(this::aufgeloest);
        Optional<Lauf> angelegt = laeufe.starte(tenant.id(), tenant.name(), akteur);
        if (angelegt.isEmpty()) {
            // Teil-Index: für den Bereich läuft schon ein Zug - derselbe Lauf ist die Antwort.
            return laeufe.juengster(tenant.id()).orElseThrow();
        }
        Lauf lauf = angelegt.get();
        log.info("Offboarding tenant {}: Löschzug {} angenommen", tenant.id(), lauf.id());
        zug.submit(() -> {
            SecurityContext kontext = SecurityContextHolder.createEmptyContext();
            kontext.setAuthentication(auth);
            SecurityContextHolder.setContext(kontext);
            try {
                fuehreAus(lauf, akteur);
            } finally {
                // Der eine Thread arbeitet den nächsten Lauf ab: nichts darf liegen bleiben.
                SecurityContextHolder.clearContext();
            }
        });
        return lauf;
    }

    /** Der jüngste Lauf des Bereichs für den Statusweg, verwaiste Läufe ehrlich aufgelöst. */
    public Optional<Lauf> stand(UUID kundenbereich) {
        return laeufe.juengster(kundenbereich).map(this::aufgeloest);
    }

    /** Löscht die gesperrten Konten nach dem Abbau; auch der wiederholbare Aufräumweg nutzt dies. */
    public TenantOffboardingCleanupDto kontenEntfernen(UUID tenantId, List<KeycloakUser> users) {
        List<String> deletedUsers = new ArrayList<>();
        List<String> failedUsers = new ArrayList<>();
        for (KeycloakUser user : users) {
            try {
                keycloak.deleteUser(user.id());
                deletedUsers.add(user.username());
            } catch (RuntimeException ex) {
                if (ex instanceof KeycloakAdminException kc && kc.status() == 404) {
                    deletedUsers.add(user.username()); // Another retry already removed it.
                    continue;
                }
                log.warn("Offboarding tenant {}: disabled Keycloak user {} pending cleanup", tenantId, user.id());
                failedUsers.add(user.username());
            }
        }
        log.info("Offboarding cleanup tenant {}: {} deleted, {} disabled users pending cleanup",
                tenantId, deletedUsers.size(), failedUsers.size());
        return new TenantOffboardingCleanupDto(tenantId, deletedUsers, failedUsers);
    }

    /** Ein verwaister Lauf (Absturz) wird beim Hinsehen ehrlich; alles andere bleibt, wie es ist. */
    private Lauf aufgeloest(Lauf lauf) {
        if (!lauf.laeuft() || lauf.herzschlagAm().isAfter(java.time.Instant.now().minusSeconds(180))) {
            return lauf;
        }
        boolean mandantVorhanden = tenants.existsById(lauf.kundenbereich());
        if (laeufe.verwaistAufloesen(lauf.id(), VERWAIST_NACH, mandantVorhanden, SATZ_UNTERBROCHEN)) {
            log.warn("Offboarding tenant {}: Löschzug {} verwaist (letzter Herzschlag {}) - aufgelöst als {}",
                    lauf.kundenbereich(), lauf.id(), lauf.herzschlagAm(),
                    mandantVorhanden ? "gescheitert (nichts gelöscht)" : "fertig (Bericht verloren)");
        }
        return laeufe.juengster(lauf.kundenbereich()).orElse(lauf);
    }

    private void fuehreAus(Lauf lauf, ProtokollAkteur akteur) {
        UUID tenantId = lauf.kundenbereich();
        ScheduledFuture<?> schlag = herz.scheduleAtFixedRate(() -> {
            try {
                laeufe.herzschlag(lauf.id());
            } catch (RuntimeException ex) {
                log.warn("Offboarding tenant {}: Herzschlag des Löschzugs {} scheiterte", tenantId, lauf.id());
            }
        }, 30, 30, TimeUnit.SECONDS);
        long start = System.nanoTime();
        try {
            log.info("Offboarding tenant {} ('{}'): Löschzug {} beginnt", tenantId, lauf.name(), lauf.id());
            KundenbereichLoeschung.Wache wache = loeschung.wache(tenantId, akteur);

            // Collected BEFORE the cascade: afterwards the rows are gone.
            List<TenantDevice> devices = tenants.devicesOfTenant(tenantId);
            List<KeycloakUser> users;
            long sperrenStart = System.nanoTime();
            try {
                users = new ArrayList<>(adminBenutzer.offboardingSperren(tenantId));
            } catch (RuntimeException ex) {
                log.warn("Offboarding tenant {}: account blocking failed; database retained", tenantId, ex);
                laeufe.gescheitert(lauf.id(), SATZ_KONTEN);
                return;
            }
            long sperrenMs = ms(sperrenStart);

            // Sofort-Weg: nie gemeldete Boxen VOR dem Abbau über den Dienst „Vom Kunden lösen" freigeben -
            // Broker, Zugang, Registry, Rollouts, Zertifizierung räumen wie beim Lösen von Hand, die Kennung
            // ist sofort wieder anmeldbar. Eine Box, die sich doch gemeldet hat, lehnt dort individuell mit
            // 409 ab - sie geht stattdessen wie jede andere gemeldete Box über die Kaskade.
            long boxenStart = System.nanoTime();
            List<String> freigegeben = new ArrayList<>();
            for (TenantDevice device : devices) {
                try {
                    if (boxLoesen.beimKundenLoeschen(device.externalRef(), akteur)) {
                        freigegeben.add(device.externalRef());
                    }
                } catch (BoxLoesenAbgelehnt ex) {
                    // Gemeldet - bleibt für die Kaskade.
                }
            }
            long boxenMs = ms(boxenStart);
            log.info("Offboarding tenant {}: Konten gesperrt in {} ms, {} Boxen freigegeben in {} ms",
                    tenantId, sperrenMs, freigegeben.size(), boxenMs);

            OffboardCounts counts;
            try {
                counts = tenants.offboard(tenantId, () -> {
                    // Close the gap between the blocking commit and the teardown transaction:
                    // a concurrent account enable/create must not leave an enabled orphan.
                    List<KeycloakUser> current = adminBenutzer.offboardingResteSperren(tenantId);
                    users.clear();
                    users.addAll(current);
                }, new FertigImZug(wache, lauf.id()));
            } catch (RuntimeException ex) {
                // vp-kunde-loeschen-500: die EINE Transaktion ist zurückgerollt - nichts ist gelöscht, nur
                // die Konten bleiben gesperrt, der Weg ist wiederholbar. Der Fehler gehört mit Stack ins
                // Log und als ehrlicher Satz in den Lauf (das Portal zeigt ihn statt „Server nicht
                // erreichbar").
                log.error("Offboarding tenant {}: database removal failed; accounts remain disabled;"
                        + " retry offboarding", tenantId, ex);
                laeufe.gescheitert(lauf.id(), ex instanceof TenantRepository.AbbauVerweigert verweigert
                        ? verweigert.getMessage() + " Es wurde nichts gelöscht." : SATZ_FEHLGESCHLAGEN);
                return;
            }

            // Broker cleanup (best-effort): clear each device's retained provisioning config +
            // schedule so the hardware falls back to its watchdog default and the refs become
            // claimable again.
            provisioning.ifAvailable(p -> devices.forEach(d -> {
                try {
                    p.clearRetained(d.externalRef(), tenantId, d.siteId(), d.id());
                } catch (RuntimeException ex) {
                    log.warn("Offboarding tenant {}: retained cleanup failed for device {}", tenantId, d.id());
                }
            }));

            TenantOffboardingCleanupDto cleanup = kontenEntfernen(tenantId, users);
            log.info("Offboarded tenant {} ('{}'): {} sites, {} devices, {} telemetry rows, "
                    + "{} users deleted, {} disabled users pending cleanup", tenantId, lauf.name(),
                    counts.sites(), counts.devices(), counts.telemetryRows(),
                    cleanup.deletedUsers().size(), cleanup.failedUsers().size());
            KundenbereichLoeschung.Nachweis nachweis = wache.nachweis();
            log.info("Offboarded tenant {}: deletion record {}, {} tables with remaining rows,"
                    + " Löschzug {} fertig in {} ms", tenantId, nachweis.kennzeichen(),
                    nachweis.verblieben().size(), lauf.id(), ms(start));
            TenantOffboardingReportDto bericht = new TenantOffboardingReportDto(tenantId, lauf.name(),
                    counts.sites(), counts.devices() + freigegeben.size(), counts.telemetryRows(),
                    cleanup.deletedUsers(), cleanup.failedUsers(), nachweis.anlass().wert(),
                    List.copyOf(freigegeben),
                    new TenantOffboardingReportDto.Loeschnachweis(nachweis.kennzeichen(),
                            nachweis.geloeschtAm(), nachweis.zaehlungen(), nachweis.verblieben(),
                            nachweis.abzugSha256()));
            try {
                laeufe.berichtNachtragen(lauf.id(), json.writeValueAsString(bericht));
            } catch (JsonProcessingException ex) {
                log.warn("Offboarding tenant {}: Bericht des Löschzugs {} nicht speicherbar", tenantId,
                        lauf.id(), ex);
            }
        } catch (RuntimeException ex) {
            // Letztes Netz (z. B. devicesOfTenant/Bericht): vor dem Abbau geworfen heißt nichts
            // gelöscht; nach dem Abbau steht der Lauf schon auf fertig und gescheitert griffe nicht.
            log.error("Offboarding tenant {}: Löschzug {} scheiterte unerwartet", tenantId, lauf.id(), ex);
            laeufe.gescheitert(lauf.id(), SATZ_FEHLGESCHLAGEN);
        } finally {
            schlag.cancel(false);
        }
    }

    private static long ms(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000;
    }

    /**
     * Die Abbauwache des Löschwegs plus der eine zusätzliche Schritt: „fertig" IN der
     * Abbau-Transaktion, NACH Löschnachweis und Protokoll - fertig heißt committed.
     */
    private record FertigImZug(KundenbereichLoeschung.Wache wache, UUID laufId)
            implements TenantRepository.Abbauwache {

        @Override
        public void vorDemAbbau(java.sql.Connection con) throws java.sql.SQLException {
            wache.vorDemAbbau(con);
        }

        @Override
        public void nachDemAbbau(java.sql.Connection con) throws java.sql.SQLException {
            wache.nachDemAbbau(con);
            KundenbereichLoeschlaufRepository.fertigImZug(con, laufId);
        }
    }
}
