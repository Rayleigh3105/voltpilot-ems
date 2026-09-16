package com.voltpilot.api.probe;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Asks a plant's box to read some registers once, and waits for the answer
 * (Einheitsmodell Stufe 0b; contract
 * {@code docs/contracts/mqtt-probe.schema.json}).
 *
 * <p><b>Synchronous, with a short timeout, and nothing persisted.</b> This is
 * the opposite end of the {@code SimulationClient}: a simulation is a long job
 * with an id you poll, a probe answers in a second or two and is worthless
 * afterwards. So the request thread waits (bounded by {@link #TIMEOUT}), the
 * correlation lives in memory only, and a timeout is an honest OUTCOME the
 * assistant renders - not an error.
 *
 * <p><b>Every policy decision belongs to the BOX.</b> This service resolves WHO
 * to ask and forwards WHAT was asked; whether the target is inside the
 * customer's own network, whether the request is still fresh, and how often the
 * box may knock at all are decided on the device
 * ({@code edge-app/core/internal/probe}). Duplicating any of that here would
 * create a second truth about a LAN this service has never seen.
 *
 * <p>The tenancy fence is the caller's: {@code /api/v1/sites/**} routes are
 * RLS-scoped, and the controller proves the site belongs to the current tenant
 * BEFORE any id reaches this class.
 */
@Service
public class ProbeService {

    private static final Logger log = LoggerFactory.getLogger(ProbeService.class);

    /**
     * How long the portal waits. Short on purpose: this sits behind a button in
     * an assistant, and a wizard that hangs for half a minute is worse than one
     * that says "das Gerät hat nicht rechtzeitig geantwortet" and lets the
     * customer try again. The box's own budget is wider - an answer that
     * arrives after this is simply dropped by the registry, which costs nothing.
     */
    static final Duration TIMEOUT = Duration.ofSeconds(5);

    private static final SecureRandom RANDOM = new SecureRandom();

    private final DeviceRepository devices;
    private final com.voltpilot.api.entities.EinmalAuftragZiel ziel;
    private final ProbeRegistry registry;
    private final ObjectProvider<ProbePublisher> publisher;

    public ProbeService(DeviceRepository devices, ProbeRegistry registry,
            ObjectProvider<ProbePublisher> publisher, com.voltpilot.api.entities.EinmalAuftragZiel ziel) {
        this.devices = devices;
        this.ziel = ziel;
        this.registry = registry;
        this.publisher = publisher;
    }

    /**
     * Run one probe against a plant's device.
     *
     * @param siteId the site, already proven to belong to the current tenant
     */
    public ProbeResult probe(UUID siteId, ProbeRequest request, String requestedBy) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            // Belt and braces: without a tenant the RLS path returns nothing
            // anyway, but a probe must never be published on a guessed topic.
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        DeviceDto device = ziel.pruefung(siteId, request.deviceId(), request.entityId());
        ProbePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Prüfung ist derzeit nicht möglich.");
        }

        String requestId = newRequestId();
        CompletableFuture<ProbeResult> future = registry.register(requestId, device.id());
        try {
            pub.publish(tenantId, siteId, device.id(), requestId, Instant.now(), requestedBy,
                    request.ops());
        } catch (Exception e) {
            registry.forget(requestId);
            // The message IS the question: if it did not go out, nothing was
            // asked, and the caller must learn that instead of waiting out the
            // timeout on a question that never left.
            log.warn("probe {} could not be published: {}", requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Anlage ist gerade nicht erreichbar. Bitte in einem Moment erneut versuchen.");
        }
        try {
            ProbeResult result = registry.await(future, TIMEOUT);
            if (result != null) {
                return result;
            }
            // An honest outcome, not an error: the box may be offline, busy or
            // slow, and the customer's next move is the same in all three cases.
            return new ProbeResult(requestId, "timeout",
                    "Die Anlage hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.",
                    List.of());
        } finally {
            registry.forget(requestId);
        }
    }

    /**
     * Run the assistant's CONNECTION TEST against a plant's device
     * (Einheitsmodell Stufe 1): one {@code test_connection} op, generalized to
     * every transport.
     *
     * <p>Identical machinery to {@link #probe}: same correlation, same short
     * wait, same honest timeout outcome, nothing persisted. Only the op differs.
     *
     * @param siteId the site, already proven to belong to the current tenant
     */
    public ProbeResult testConnection(UUID siteId, UUID deviceId, String opId, String brand,
            String model, String family, String role, java.util.Map<String, Object> connection,
            String requestedBy) {
        return testConnection(siteId, deviceId, null, opId, brand, model, family, role, connection, requestedBy);
    }

    public ProbeResult testConnection(UUID siteId, UUID deviceId, UUID entityId, String opId, String brand,
            String model, String family, String role, java.util.Map<String, Object> connection,
            String requestedBy) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        DeviceDto device = ziel.pruefung(siteId, deviceId, entityId);
        ProbePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Prüfung ist derzeit nicht möglich.");
        }
        String requestId = newRequestId();
        CompletableFuture<ProbeResult> future = registry.register(requestId, device.id());
        try {
            pub.publishTest(tenantId, siteId, device.id(), requestId, Instant.now(), requestedBy,
                    opId, brand, model, family, role, connection);
        } catch (Exception e) {
            registry.forget(requestId);
            log.warn("connection test {} could not be published: {}", requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Anlage ist gerade nicht erreichbar. Bitte in einem Moment erneut versuchen.");
        }
        try {
            ProbeResult result = registry.await(future, TIMEOUT);
            if (result != null) {
                return result;
            }
            return new ProbeResult(requestId, "timeout",
                    "Die Anlage hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.",
                    List.of());
        } finally {
            registry.forget(requestId);
        }
    }

    /**
     * Run ONE writing op - the guided switch test or its cancel (Einheitsmodell
     * Stufe 4). Deliberately the SAME machinery as a read: same correlation,
     * same 5-second wait, same honest timeout. What makes it a write is only
     * which op the box gets, and the box arms its auto-off before performing it.
     *
     * <p>A TIMEOUT here is a genuinely awkward outcome and is reported as such
     * rather than as a failure: the write may well have landed and only its
     * answer got lost - the box's watchdog covers exactly that, and the surface
     * says "unklar", never "hat nicht geschaltet".
     */
    public ProbeResult switchOp(UUID siteId, UUID deviceId, ProbePublisher.SwitchOp op,
            String requestedBy) {
        return switchOp(siteId, deviceId, null, op, requestedBy);
    }

    public ProbeResult switchOp(UUID siteId, UUID deviceId, UUID entityId, ProbePublisher.SwitchOp op,
            String requestedBy) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        DeviceDto device = ziel.pruefung(siteId, deviceId, entityId);
        ProbePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Schalt-Test ist derzeit nicht möglich.");
        }
        String requestId = newRequestId();
        CompletableFuture<ProbeResult> future = registry.register(requestId, device.id());
        try {
            pub.publishSwitch(tenantId, siteId, device.id(), requestId, Instant.now(),
                    requestedBy, op);
        } catch (Exception e) {
            registry.forget(requestId);
            log.warn("switch op {} could not be published: {}", requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Anlage ist gerade nicht erreichbar. Bitte in einem Moment erneut versuchen.");
        }
        try {
            ProbeResult result = registry.await(future, TIMEOUT);
            if (result != null) {
                return result;
            }
            return new ProbeResult(requestId, "timeout",
                    "Die Anlage hat nicht rechtzeitig geantwortet. Falls das Gerät doch "
                            + "geschaltet hat, fällt es von selbst wieder zurück.",
                    List.of());
        } finally {
            registry.forget(requestId);
        }
    }

    /**
     * Ask EXACTLY this box - the reachability check of a data source (UEMS AP-06
     * IP-3, E11: a check only counts from EXACTLY the target box).
     *
     * <p>Here the caller NAMES the box, and it may have a different home
     * plant than the source it checks (a box may read a source of another plant
     * if it reaches it - contract {@code data-source-assignment.md} §1). So the
     * box is resolved by id inside the tenant fence (RLS: a foreign box is simply
     * not there, 404), and the question goes out on the box's OWN topic
     * {@code ems/{t}/{home site}/{box}/v2/probe} - the only one it listens on and
     * the only one its ACL lets it answer on. Same envelope, same correlation,
     * same short wait, nothing persisted, no edge change.
     *
     * @return the box's answer; EMPTY when it did not answer within
     *     {@link #TIMEOUT}. Never a synthesized result: "the box said nothing" is a
     *     fact about the BOX, and the caller must be able to tell it apart from
     *     anything the box reported about the device.
     */
    public Optional<ProbeResult> probeBox(UUID boxId, List<ProbeRequest.Op> ops, String requestedBy) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden.");
        }
        DeviceDto box = devices.findById(boxId).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden."));
        ProbePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Prüfung ist derzeit nicht möglich.");
        }
        String requestId = newRequestId();
        CompletableFuture<ProbeResult> future = registry.register(requestId, box.id());
        try {
            pub.publish(tenantId, box.siteId(), box.id(), requestId, Instant.now(), requestedBy, ops);
        } catch (Exception e) {
            registry.forget(requestId);
            log.warn("box probe {} could not be published: {}", requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Box ist gerade nicht erreichbar. Bitte in einem Moment erneut versuchen.");
        }
        try {
            return Optional.ofNullable(registry.await(future, TIMEOUT));
        } finally {
            registry.forget(requestId);
        }
    }

    /** A hex correlation id matching the contract's {@code request_id} pattern. */
    private static String newRequestId() {
        byte[] b = new byte[8];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }
}
