package com.voltpilot.api.control;

import com.voltpilot.api.repo.ControlCertificationRepository;
import com.voltpilot.api.repo.ControlCertificationRepository.Activation;
import com.voltpilot.api.repo.ControlCertificationRepository.Certification;
import com.voltpilot.api.repo.ControlCertificationRepository.DeviceIdentity;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

/**
 * Das PLATTFORM-Gedächtnis der Steuerungs-Freigabe: Register pflegen, Anlagen
 * scharfschalten, und beides an die Geräte verteilen.
 *
 * <p><b>Zwei Halbwahrheiten, eine Freigabe.</b> Das Register sagt „Modell X ist
 * am Prüfstand freigegeben" (einmal, flottenweit); die Scharfschaltung sagt
 * „Anlage Y darf das nutzen" (ausdrücklich, je Anlage). Erst beides zusammen
 * ergibt eine Freigabe, und weil die Entscheidung auf dem GERÄT fällt, reist
 * beides zusammen im selben Dokument.
 *
 * <p><b>Warum das Dokument an JEDES beanspruchte Gerät geht, nicht nur an die
 * scharfgeschalteten:</b> nur so kann eine Box selbst berichten, ob ihr Modell
 * gedeckt ist. Ohne das könnte das Portal „Modell noch nicht zertifiziert
 * (Prüfstand nötig)" nicht von „Modell zertifiziert - Aktivierung ausstehend
 * (1 Klick)" unterscheiden, und genau diese Unterscheidung ist der Auftrag. Ein
 * Dokument mit {@code activated:false} steuert nichts.
 *
 * <p><b>⚠ Kein {@code @Transactional}</b> - aus demselben Grund wie in
 * {@code RolloutService}: Springs Transaktionsmanager hängt am {@code @Primary}
 * (mandantenbezogenen) Datenpfad, jeder Schreibvorgang hier läuft aber über
 * {@code adminJdbcTemplate}. Die Annotation öffnete eine Transaktion auf der
 * FALSCHEN Verbindung und behauptete eine Atomarität, die es nicht gibt.
 * Getragen wird es von der Reihenfolge: erst prüfen, dann schreiben, dann
 * (best-effort) veröffentlichen - und jeder Schritt für sich idempotent.
 */
@Service
public class ControlCertificationService {

    private static final Logger log = LoggerFactory.getLogger(ControlCertificationService.class);

    private final ControlCertificationRepository repo;
    private final ObjectProvider<ControlCertificationPublisher> publisher;

    public ControlCertificationService(ControlCertificationRepository repo,
            ObjectProvider<ControlCertificationPublisher> publisher) {
        this.repo = repo;
        this.publisher = publisher;
    }

    /** Eine fachliche Ablehnung mit deutschem Grund (der Controller mappt sie). */
    public static class Refused extends RuntimeException {
        private final boolean conflict;

        public Refused(String message, boolean conflict) {
            super(message);
            this.conflict = conflict;
        }

        public boolean isConflict() {
            return conflict;
        }
    }

    // ── Register ──────────────────────────────────────────────────────────

    public List<Certification> register() {
        return repo.listCertifications();
    }

    /**
     * Trägt ein Modell ins Register ein und verteilt das neue Register an die
     * ganze Flotte.
     *
     * <p>Ein bereits vorhandenes Modell ist ein KONFLIKT, keine stille
     * Aktualisierung: zwei Aussagen über dasselbe Produkt könnten auseinander
     * laufen, und ein Prüfstandslauf, der etwas anderes ergab, gehört
     * ausdrücklich entfernt und neu eingetragen (mit sichtbarer Papier-Spur).
     */
    public Certification certify(String brand, String model, String family, String controlPath,
            Boolean invertControlSign, Instant certifiedAt, String firmwareNote, String note,
            String actor) {
        if (blank(brand) || blank(model) || blank(family)) {
            throw new Refused("Marke, Modell und Registerfamilie sind Pflicht.", false);
        }
        if (controlPath != null && !controlPath.isBlank()
                && !"remote".equals(controlPath) && !"tou".equals(controlPath)) {
            throw new Refused("Unbekannter Steuerpfad - erlaubt sind 'remote' und 'tou'.", false);
        }
        Certification c = new Certification(UUID.randomUUID(),
                ControlCertificationRepository.norm(brand),
                ControlCertificationRepository.norm(model),
                ControlCertificationRepository.norm(family),
                blank(controlPath) ? null : controlPath, invertControlSign,
                certifiedAt == null ? Instant.now() : certifiedAt,
                trimToNull(firmwareNote), trimToNull(note), Instant.now(), actor);
        if (!repo.insertCertification(c)) {
            throw new Refused("Dieses Modell steht bereits im Register. Nehmen Sie den bestehenden "
                    + "Eintrag zurück, wenn ein neuer Prüfstandslauf etwas anderes ergeben hat.", true);
        }
        log.warn("Steuerungs-Register: {} {} ({}) ZERTIFIZIERT durch {}",
                c.brand(), c.model(), c.family(), actor);
        republishFleet("Register erweitert");
        return c;
    }

    /** Nimmt ein Modell aus dem Register und verteilt das Register neu. */
    public void revoke(String brand, String model, String actor) {
        if (!repo.deleteCertification(brand, model)) {
            throw new Refused("Dieses Modell steht nicht im Register.", false);
        }
        log.warn("Steuerungs-Register: {} {} ZURÜCKGENOMMEN durch {}",
                ControlCertificationRepository.norm(brand),
                ControlCertificationRepository.norm(model), actor);
        republishFleet("Register verkleinert");
    }

    // ── Scharfschaltung ───────────────────────────────────────────────────

    public List<Activation> activations() {
        return repo.listActivations();
    }

    /** Jede Anlage als Kandidat, samt dem, was ihr Gerät gemeldet hat. */
    public List<ControlCertificationRepository.Candidate> candidates() {
        return repo.candidates();
    }

    public Optional<Activation> activation(UUID deviceId) {
        return repo.findActivation(deviceId);
    }

    /**
     * Schaltet EINE Anlage scharf - die ausdrückliche, sicherheitsrelevante
     * Entscheidung, die auch nach diesem Umbau ein Mensch trifft. Idempotent.
     */
    public void activate(UUID deviceId, String actor, String note) {
        DeviceIdentity id = repo.claimedDevice(deviceId)
                .orElseThrow(() -> new Refused("Unbekanntes Gerät.", false));
        repo.activate(deviceId, actor, trimToNull(note));
        log.warn("Steuerungs-Freigabe: Gerät {} SCHARFGESCHALTET durch {}", deviceId, actor);
        publishFor(new DeviceIdentity(id.deviceId(), id.tenantId(), id.siteId(), true), register());
    }

    /** Nimmt die Scharfschaltung zurück - das Gerät fällt sofort auf Nur-Lesen. */
    public void deactivate(UUID deviceId, String actor) {
        DeviceIdentity id = repo.claimedDevice(deviceId)
                .orElseThrow(() -> new Refused("Unbekanntes Gerät.", false));
        if (!repo.deactivate(deviceId)) {
            throw new Refused("Diese Anlage ist nicht scharfgeschaltet.", false);
        }
        log.warn("Steuerungs-Freigabe: Gerät {} ZURÜCKGENOMMEN durch {}", deviceId, actor);
        publishFor(new DeviceIdentity(id.deviceId(), id.tenantId(), id.siteId(), false), register());
    }

    /**
     * Räumt beim Unclaim den retained Slot: ein Gerät, das niemandem mehr
     * gehört, darf keine Freigabe behalten, die auf dem Broker auf seine
     * Rückkehr wartet - dieselbe Hygiene wie beim Provisionierungs-Config, beim
     * Entity-Push und bei der OTA-Zuweisung. Best-effort und nie werfend.
     *
     * <p><b>⚠ Die Aktivierungs-ZEILE wird hier ABSICHTLICH nicht gelöscht - sie
     * stirbt am FK-CASCADE.</b> Ein {@code DELETE} von hier aus wäre ein
     * SELBST-BLOCKADE (im Testcontainers-Lauf reproduziert, Thread hing im
     * Postgres-Zeilenlock): {@code DeviceController.unclaim} ist
     * {@code @Transactional} auf dem {@code @Primary} (mandantenbezogenen)
     * Datenpfad und hat die Gerätezeile schon gelöscht, hält also bis zum
     * Commit die Sperre auf den kaskadierenden Zeilen - während dieses
     * Repository an einer ANDEREN Verbindung hängt (der BYPASSRLS-Rolle
     * {@code voltpilot_admin}) und damit auf einen Commit wartet, der ohne
     * seinen eigenen Rücklauf nie kommt.
     *
     * <p>Das ist die Kehrseite derselben Regel, aus der in {@code RolloutService}
     * kein {@code @Transactional} steht: die zwei Datenpfade dürfen sich nie
     * gegenseitig belauern. Das {@code ON DELETE CASCADE} der Migration erledigt
     * das Aufräumen ohnehin ATOMAR mit dem Gerät - besser, als es von außen
     * nachzuziehen.
     */
    public void onDeviceUnclaimed(UUID tenantId, UUID siteId, UUID deviceId) {
        ControlCertificationPublisher p = publisher.getIfAvailable();
        if (p != null) {
            p.clear(tenantId, siteId, deviceId);
        }
    }

    // ── Verteilung ────────────────────────────────────────────────────────

    /**
     * Der Startup-Abgleich: veröffentlicht den AKTUELLEN Stand an jedes
     * beanspruchte Gerät.
     *
     * <p>Er ist der Grund, warum es keinen Haken im Claim-Pfad braucht: ein
     * frisch beanspruchtes Gerät bekommt sein Dokument spätestens beim nächsten
     * Deploy, und der Moment, in dem es zählt, ist ohnehin der Klick auf
     * „Steuerung aktivieren" - der veröffentlicht sofort.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void reconcileOnStartup() {
        if (publisher.getIfAvailable() == null) {
            return; // kein Broker konfiguriert (Tests, brokerlose Deployments)
        }
        try {
            republishFleet("Start");
        } catch (Exception e) {
            log.warn("control-certification startup reconcile failed: {} (a later change republishes)",
                    e.getMessage());
        }
    }

    /** Veröffentlicht das aktuelle Register an JEDES beanspruchte Gerät. */
    public void republishFleet(String why) {
        ControlCertificationPublisher p = publisher.getIfAvailable();
        if (p == null) {
            return;
        }
        List<Certification> reg = register();
        List<DeviceIdentity> devices = repo.allClaimedDevices();
        int ok = 0;
        Instant now = Instant.now();
        for (DeviceIdentity d : devices) {
            if (p.publish(d.tenantId(), d.siteId(), d.deviceId(), d.activated(), reg, now)) {
                ok++;
            }
        }
        log.info("control certification republished ({}): {}/{} devices, {} certified models",
                why, ok, devices.size(), reg.size());
    }

    private void publishFor(DeviceIdentity d, List<Certification> reg) {
        ControlCertificationPublisher p = publisher.getIfAvailable();
        if (p != null) {
            p.publish(d.tenantId(), d.siteId(), d.deviceId(), d.activated(), reg, Instant.now());
        }
    }

    private static boolean blank(String v) {
        return v == null || v.isBlank();
    }

    private static String trimToNull(String v) {
        if (v == null) {
            return null;
        }
        String t = v.trim();
        return t.isEmpty() ? null : t;
    }
}
