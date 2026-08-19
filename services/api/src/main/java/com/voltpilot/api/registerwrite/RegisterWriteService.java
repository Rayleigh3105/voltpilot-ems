package com.voltpilot.api.registerwrite;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die ZWEI-SCHRITT-STRECKE des Register-Schreibens (Konzept
 * {@code vp-reg-schreib-konzept-p8} §2.3, Captain-Vorentscheidung 3): erst den
 * Ist-Wert LESEN (die Vorschau), dann - und nur dann - EINMAL schreiben, danach
 * ein Beleg mit Rücklesung.
 *
 * <p><b>Die Vorschau liest über die SCHREIB-Lane, nicht über den Probe-Kanal</b>,
 * und das ist der Punkt: sie beweist damit zugleich, dass der Weg offen ist
 * (Gate an? Lane erreichbar? Selbstkonflikt?), BEVOR ein Mensch bestätigt. Ein
 * „würde abgelehnt: die Steuerung besitzt dieses Register" erscheint so in
 * Schritt 1 und nie erst nach dem Klick.
 *
 * <p><b>Jede POLITIK gehört der BOX.</b> Dieser Dienst löst auf, WER gefragt
 * wird, und reicht weiter, WAS gefragt wurde; ob die Adresse freigegeben ist, ob
 * der Wert im erlaubten Band liegt, ob das Ziel im Kunden-LAN steht und ob die
 * laufende Steuerung das Register gerade besitzt, entscheidet das Gerät
 * ({@code edge-app/core/internal/installerwrite}). Eine zweite Politik hier wäre
 * eine zweite Wahrheit über ein LAN, das dieser Dienst nie gesehen hat.
 *
 * <p><b>Die EINE Regel, die hier lebt, ist die Notiz-Pflicht (D5):</b> bei
 * Registerklasse {@code netz_compliance} - in Stufe 1 also bei {@code 0x00E7} -
 * ist die Notiz Pflicht, für jede Herkunft. Sie steht hier, weil die KLASSE hier
 * entschieden wird ({@link RegisterKnowledge}); die Box kennt sie nicht.
 *
 * <p><b>Die Reihenfolge des Journals ist tragend</b> (die OTA-Apply-Doktrin):
 * erst VERÖFFENTLICHEN, dann protokollieren. Scheitert schon das Veröffentlichen
 * (503), entsteht KEINE Zeile, die eine Anforderung behauptet, die es nie gab;
 * gelingt es, steht die Anforderungs-Zeile - auch wenn die api danach abstürzt.
 * Ein Schreibvorgang ist damit nie spurlos.
 *
 * <p>Der Mandanten-Zaun ist der des Aufrufers: {@code /api/v1/sites/**} ist
 * RLS-gefenced, und der Controller beweist die Zugehörigkeit der Anlage, BEVOR
 * eine Kennung hier ankommt.
 */
@Service
public class RegisterWriteService {

    private static final Logger log = LoggerFactory.getLogger(RegisterWriteService.class);

    private static final SecureRandom RANDOM = new SecureRandom();

    private final DeviceRepository devices;
    private final RegisterWriteRegistry registry;
    private final RegisterWriteEventRepository journal;
    private final ObjectProvider<RegisterWritePublisher> publisher;
    private final Duration readTimeout;
    private final Duration writeTimeout;

    /**
     * @param readTimeout  wie lange das Portal auf die Vorschau wartet. Kurz:
     *                     dahinter steht ein Knopf, und ein Assistent, der eine
     *                     halbe Minute hängt, ist schlimmer als einer, der „hat
     *                     nicht rechtzeitig geantwortet" sagt.
     * @param writeTimeout wie lange auf die Quittung eines echten
     *                     Schreibvorgangs gewartet wird - spürbar länger, weil
     *                     die Box dafür auf den laufenden Poll wartet, schreibt,
     *                     ~2 s setzen lässt und erneut liest. Läuft er ab, ist
     *                     der Zustand UNBEKANNT (nie „nicht geschrieben"), und
     *                     die Quittung landet trotzdem im Journal, sobald sie
     *                     eintrifft.
     */
    public RegisterWriteService(DeviceRepository devices, RegisterWriteRegistry registry,
            RegisterWriteEventRepository journal,
            ObjectProvider<RegisterWritePublisher> publisher,
            @Value("${voltpilot.register-write.read-timeout:PT20S}") Duration readTimeout,
            @Value("${voltpilot.register-write.write-timeout:PT45S}") Duration writeTimeout) {
        this.devices = devices;
        this.registry = registry;
        this.journal = journal;
        this.publisher = publisher;
        this.readTimeout = readTimeout;
        this.writeTimeout = writeTimeout;
    }

    /** Wer handelt - ausschließlich aus dem validierten Token abgeleitet. */
    public record Actor(String subject, String name, boolean platformAdmin) {

        /**
         * Die Herkunft, wie sie ins Journal gestempelt wird. Ein Kunde kann keine
         * VoltPilot-Herkunft behaupten und umgekehrt: sie kommt aus den
         * Realm-Rollen des Tokens, nie aus dem Request-Körper.
         */
        public String origin() {
            return platformAdmin
                    ? RegisterWriteEventRepository.ORIGIN_VOLTPILOT
                    : RegisterWriteEventRepository.ORIGIN_CUSTOMER;
        }

        public String role() {
            return platformAdmin ? "platform-admin" : "operator";
        }
    }

    /** Was der Aufrufer will - roh, wie er es getippt hat. */
    public record Command(UUID deviceId, String registerKind, String addressInput,
            String valueInput, Integer expectedBefore, Integer writeFc, String note) {
    }

    /** Das Ergebnis EINES Schritts, wie es die Oberfläche rendert. */
    public record Outcome(String requestId, String mode, boolean ok, String outcome,
            Integer beforeRaw, Integer afterRaw, Double beforeScaled, Double afterScaled,
            Boolean adopted, String errorCode, String message, String targetLabel,
            int address, String addressHex, String registerLabel, String registerClass,
            String scaleNote, boolean noteRequired, String confirm, Instant requestedAt) {
    }

    /**
     * Schritt 1: den Ist-Wert lesen. Es wird NICHTS geschrieben und NICHTS
     * protokolliert - eine Lesung ändert nichts, und ein Protokoll der Lesungen
     * würde die Schreibvorgänge begraben, für die das Journal existiert.
     */
    public Outcome preview(UUID siteId, Command cmd, Actor actor) {
        UUID tenantId = requireTenant();
        // Die FORM zuerst: ein offensichtlicher Tippfehler wird als Tippfehler
        // gemeldet, nicht als Geräte-Problem - und er kostet keine Broker-Runde
        // (die Probe-Kanal-Regel).
        int address = address(cmd.addressInput());
        String kind = registerKind(cmd.registerKind());
        RegisterKnowledge.Known known = RegisterKnowledge.of(address);
        DeviceDto device = resolveDevice(siteId, cmd.deviceId());

        String requestId = newRequestId();
        Instant requestedAt = Instant.now();
        RegisterWritePublisher.Order order = new RegisterWritePublisher.Order(
                RegisterWriteResult.MODE_READ, RegisterWritePublisher.Order.LANE_PRIMARY, null,
                null, null, null, kind, address, null, null, null, null);

        RegisterWriteResult result = exchange(tenantId, siteId, device, requestId, requestedAt,
                actor, order, readTimeout,
                "Die Anlage hat den Ist-Wert nicht rechtzeitig gemeldet. Bitte erneut versuchen.");
        return outcome(result, address, known, null);
    }

    /**
     * Schritt 2: der EINE Schreibvorgang. Er verlangt die Notiz, wo die Klasse
     * sie fordert (D5), baut die Bestätigung selbst (Protokoll-Sicherheit, kein
     * Tipp-Zwang - Captain: „ohne Hürden") und schreibt die Papier-Spur.
     */
    public Outcome write(UUID siteId, Command cmd, Actor actor) {
        UUID tenantId = requireTenant();
        // Erst die FORM, dann das Ziel: dieselbe Reihenfolge wie bei der
        // Vorschau, damit ein Tippfehler nie als Geräte-Problem erscheint.
        int address = address(cmd.addressInput());
        String kind = registerKind(cmd.registerKind());
        RegisterKnowledge.Known known = RegisterKnowledge.of(address);
        int value = RegisterKnowledge.parseValue(cmd.valueInput()).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Der Wert ist keine Registerzahl (0 bis 65535, dezimal oder 0x-hexadezimal)."));
        String note = trimToNull(cmd.note());
        if (known.noteRequired() && note == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Dieses Register betrifft die Netz-Anmeldung der Anlage. Bitte tragen Sie "
                            + "den Grund ein (z. B. die Freigabe des Netzbetreibers).");
        }
        DeviceDto device = resolveDevice(siteId, cmd.deviceId());

        String requestId = newRequestId();
        Instant requestedAt = Instant.now();
        String confirm = RegisterKnowledge.confirmToken(address, value);
        String targetLabel = targetLabel(device);
        RegisterWritePublisher.Order order = new RegisterWritePublisher.Order(
                RegisterWriteResult.MODE_WRITE, RegisterWritePublisher.Order.LANE_PRIMARY, null,
                null, null, null, kind, address, cmd.writeFc(), value, cmd.expectedBefore(),
                confirm);

        RegisterWritePublisher pub = requirePublisher();
        CompletableFuture<RegisterWriteResult> future = registry.register(requestId, device.id());
        try {
            pub.publish(tenantId, siteId, device.id(), requestId, requestedAt,
                    actor.subject(), order);
        } catch (Exception e) {
            registry.forget(requestId);
            // Der Auftrag hat das Haus nie verlassen: KEINE Journal-Zeile, die
            // eine Anforderung behauptet, die es nie gab.
            log.warn("register write {} could not be published: {}", requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Anlage ist gerade nicht erreichbar. Es wurde nichts geschrieben.");
        }
        // ERST veröffentlichen, DANN protokollieren - ab hier ist der Vorgang
        // aktenkundig, auch wenn diese api gleich abstürzt.
        journal.recordRequest(new RegisterWriteEventRepository.Request(
                requestId, RegisterWriteEventRepository.SOURCE_PORTAL, siteId, device.id(),
                device.externalRef(), RegisterWritePublisher.Order.LANE_PRIMARY, null, targetLabel,
                kind, address, cmd.writeFc(), cmd.addressInput().trim(), cmd.valueInput().trim(),
                note, value, cmd.expectedBefore(), known.label(), known.clazz(),
                known.scaleNote(value), actor.origin(), actor.subject(), actor.name(),
                actor.role(), actor.platformAdmin(), requestedAt));

        RegisterWriteResult result;
        try {
            result = registry.await(future, writeTimeout);
        } finally {
            registry.forget(requestId);
        }
        if (result == null) {
            // Schweigen ist NIE „nicht geschrieben" (die PR-280-Lehre).
            result = RegisterWriteResult.silent(requestId, RegisterWriteResult.MODE_WRITE,
                    "Es kam keine Rückmeldung. Der Zustand ist unbekannt - bitte den Ist-Wert "
                            + "erneut lesen, bevor Sie noch einmal schreiben.");
            journal.recordOutcome(new RegisterWriteEventRepository.Receipt(requestId,
                    RegisterWriteEventRepository.EVENT_SILENT,
                    RegisterWriteEventRepository.SOURCE_PORTAL, siteId, device.id(), null, null,
                    null, RegisterWriteResult.OUTCOME_UNKNOWN, result.message(), targetLabel,
                    Instant.now()));
        }
        // Die Quittungs-Zeile schreibt der Zuhörer - unabhängig davon, ob hier
        // noch jemand wartet.
        return outcome(result, address, known, value);
    }

    /** Der Verlauf der Schreibvorgänge dieser Anlage (optional je Gerät). */
    public List<RegisterWriteEventRepository.Entry> history(UUID siteId, UUID deviceId,
            int limit) {
        return journal.recent(siteId, deviceId, Math.max(1, Math.min(limit, 200)));
    }

    private RegisterWriteResult exchange(UUID tenantId, UUID siteId, DeviceDto device,
            String requestId, Instant requestedAt, Actor actor, RegisterWritePublisher.Order order,
            Duration timeout, String silenceMessage) {
        RegisterWritePublisher pub = requirePublisher();
        CompletableFuture<RegisterWriteResult> future = registry.register(requestId, device.id());
        try {
            pub.publish(tenantId, siteId, device.id(), requestId, requestedAt, actor.subject(),
                    order);
        } catch (Exception e) {
            registry.forget(requestId);
            log.warn("register write request {} could not be published: {}",
                    requestId, e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Die Anlage ist gerade nicht erreichbar. Bitte in einem Moment erneut versuchen.");
        }
        try {
            RegisterWriteResult result = registry.await(future, timeout);
            return result != null
                    ? result
                    : RegisterWriteResult.silent(requestId, order.mode(), silenceMessage);
        } finally {
            registry.forget(requestId);
        }
    }

    private Outcome outcome(RegisterWriteResult r, int address, RegisterKnowledge.Known known,
            Integer requestedValue) {
        return new Outcome(r.requestId(), r.mode(), r.ok(), r.outcome(), r.beforeRaw(),
                r.afterRaw(), known.scaled(r.beforeRaw()), known.scaled(r.afterRaw()),
                r.adopted(), r.errorCode(), r.message(), r.targetLabel(), address,
                RegisterKnowledge.hex(address), known.label(), known.clazz(),
                known.scaleNote(requestedValue == null ? r.beforeRaw() : requestedValue),
                known.noteRequired(),
                requestedValue == null ? null
                        : RegisterKnowledge.confirmToken(address, requestedValue),
                Instant.now());
    }

    private RegisterWritePublisher requirePublisher() {
        RegisterWritePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Register-Schreibpfad ist derzeit nicht verfügbar.");
        }
        return pub;
    }

    private static UUID requireTenant() {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            // Ohne Mandant liefert der RLS-Pfad ohnehin nichts - aber ein Auftrag
            // darf niemals auf einem geratenen Topic landen.
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return tenantId;
    }

    private static int address(String input) {
        return RegisterKnowledge.parseAddress(input).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Die Registeradresse ist nicht lesbar. Erlaubt sind 0 bis 65535 - "
                                + "dezimal (231) oder hexadezimal (0x00E7)."));
    }

    private static String registerKind(String raw) {
        String k = raw == null ? "holding" : raw.trim().toLowerCase(java.util.Locale.ROOT);
        if (k.isEmpty()) {
            k = "holding";
        }
        if (!"holding".equals(k) && !"coil".equals(k)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Es gibt nur Holding-Register und Spulen.");
        }
        return k;
    }

    /**
     * WOHIN geschrieben wird, in Klartext - schon zum Zeitpunkt der Anforderung,
     * damit die Papier-Spur auch dann ein Ziel nennt, wenn nie eine Quittung
     * kommt. Die Box echot in ihrer Quittung ihr eigenes, genaueres Label
     * (Modell, Host, Unit); beides steht nebeneinander im Journal.
     */
    private static String targetLabel(DeviceDto device) {
        String name = device.name() == null || device.name().isBlank()
                ? device.externalRef() : device.name();
        return "Primärer Wechselrichter · " + name;
    }

    /**
     * Welches Gerät gefragt wird, wird NIE geraten (die
     * {@code ProbeService}-Regel): ein ausdrückliches Gerät muss zur Anlage
     * gehören, ohne Angabe entscheidet das EINZIGE Gerät, und eine Anlage mit
     * mehreren wird beim Namen genannt.
     */
    private DeviceDto resolveDevice(UUID siteId, UUID requested) {
        List<DeviceDto> ofSite = devices.findAll().stream()
                .filter(d -> siteId.equals(d.siteId()))
                .toList();
        if (requested != null) {
            return ofSite.stream().filter(d -> requested.equals(d.id())).findFirst()
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                            "Gerät nicht gefunden."));
        }
        if (ofSite.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat noch kein verbundenes Gerät.");
        }
        if (ofSite.size() > 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat mehrere Geräte. Bitte wählen Sie aus, welches schreiben soll.");
        }
        return ofSite.get(0);
    }

    private static String trimToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    /** Eine Hex-Korrelation im Format des Kontrakts ({@code ^[0-9a-f]{16,64}$}). */
    private static String newRequestId() {
        byte[] b = new byte[8];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }
}
