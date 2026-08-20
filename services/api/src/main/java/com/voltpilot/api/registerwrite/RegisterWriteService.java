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
 *
 * <p><b>⚠ DER CLOUD-NOT-AUS WOHNT HIER, NICHT AN DER ROUTE</b> (Stufe 3 „Bis
 * zum Endkunden"). Bis Stufe 2 nahm {@code @ConditionalOnProperty} dem
 * Controller die Bohne, sobald {@code voltpilot.register-write.enabled} auf
 * {@code false} stand - die Routen verschwanden und antworteten mit einem
 * nackten <b>404</b>. Das war aus zwei Gründen die falsche Abschaltung:
 * <ul>
 *   <li>ein 404 ist auf diesem Pfad schon vergeben - so antwortet der
 *       RLS-Zaun auf eine FREMDE Anlage. Der Not-Aus sah damit exakt aus wie
 *       „diese Anlage gehört Ihnen nicht", und ein Kunde hätte in seiner
 *       eigenen Anlage einen Fehler gesucht, den es nicht gab;</li>
 *   <li>er nahm den VERLAUF mit. Das Schreiben abzuschalten darf nie die
 *       Papier-Spur verstecken - das Journal ist genau dann interessant, wenn
 *       jemand den Not-Aus gedrückt hat.</li>
 * </ul>
 * Seither refüsieren nur noch die zwei SCHREIBENDEN Schritte, mit <b>503</b>
 * und einem deutschen Grund; {@code targets}, das Register-Wissen und
 * {@code history} bleiben lesbar. Die Prüfung ist die ERSTE Anweisung beider
 * Schritte - kein Ziel wird aufgelöst, keine Runde zum Broker gedreht, keine
 * Journal-Zeile geschrieben.
 *
 * <p>Er ist zugleich der EINZIGE plattformweite Hebel: auf der Box gibt es seit
 * der Captain-Korrektur vom 20.08.2026 (D2 KORRIGIERT) KEIN Feature-Flag mehr -
 * das frühere {@code VP_INSTALLER_WRITE_ENABLED} ist ersatzlos entfallen, der
 * Einmal-Schreibpfad ist dort immer verfügbar. Die Sicherung des Pfades sind
 * unverändert die inhaltlichen Tore: Identität (Broker-ACL + mTLS-CN),
 * Zeitfenster, Zwei-Schritt-Bestätigung, {@code expected_before}, Einmaligkeit,
 * Lane-Politik (Wertgrenzen, LAN-Whitelist) und die Selbstkonflikt-Sperre auf
 * dem Gerät - plus RLS/JWT auf diesem Weg.
 *
 * <p><b>⚠ DIE ZEITFENSTER-INVARIANTE (Produktionsvorfall 20.08.2026, die
 * Ursache): das Warte-Budget der CLOUD muss GRÖSSER sein als die Schranke, mit
 * der die BOX ihre eigene Runde begrenzt.</b> Die Box bindet EINEN
 * Bus-Rundlauf an {@code installerWriteTimeout} = 30 s
 * ({@code edge-app/core/internal/agent/installerwrite.go}) - so lange darf ein
 * Lesen dauern, weil der Node-RED-Knoten hinter der EINEN Warteschlange je
 * (Host, Port) auf den laufenden Poll wartet, bevor er überhaupt lesen kann.
 * Die Vorschau wartete aber nur <b>20 s</b>: jede Anlage, deren Bus gerade
 * belegt war, lief damit strukturell ins Leere - die Box antwortete korrekt
 * (gemessen: 22 s, Ist-Wert 3300 = 33,0 kW), die api hatte die Korrelation da
 * längst vergessen, und die Oberfläche behauptete „die Anlage hat nicht
 * geantwortet" - obwohl genau sie geliefert hatte. Der lokale
 * {@code :8484}-Knopf funktionierte durchgehend, weil sein HTTP-Handler die
 * vollen 30 s abwartet; dieser Widerspruch (lokal geht es, aus dem Portal nie)
 * war der eigentliche Hinweis.
 *
 * <p>Wer eine der beiden Zahlen anfasst, fasst BEIDE an: {@link #BOX_ROUND_TRIP}
 * ist die hier notierte Schranke des Geräts, und {@code RegisterWriteBudgetTest}
 * nagelt fest, dass beide Vorgaben darüber liegen. Ein zu kleines Budget ist
 * nicht „ein bisschen ungeduldig", sondern ein Feature, das auf jeder belegten
 * Anlage nie funktioniert.
 */
@Service
public class RegisterWriteService {

    private static final Logger log = LoggerFactory.getLogger(RegisterWriteService.class);

    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * Die Schranke, mit der die BOX ihren eigenen Bus-Rundlauf begrenzt
     * ({@code installerWriteTimeout} in
     * {@code edge-app/core/internal/agent/installerwrite.go}). Sie steht hier
     * als NOTIERTE Tatsache, nicht als Konfiguration: die Cloud kann sie nicht
     * setzen, sie muss sie nur überbieten (siehe die Zeitfenster-Invariante im
     * Klassen-Javadoc).
     */
    public static final Duration BOX_ROUND_TRIP = Duration.ofSeconds(30);

    private final DeviceRepository devices;
    private final RegisterKnowledge knowledge;
    private final RegisterWriteTargets targets;
    private final RegisterWriteRegistry registry;
    private final RegisterWriteEventRepository journal;
    private final ObjectProvider<RegisterWritePublisher> publisher;
    private final Duration readTimeout;
    private final Duration writeTimeout;
    private final boolean enabled;

    /**
     * @param readTimeout  wie lange das Portal auf die Vorschau wartet.
     *                     <b>⚠ MUSS ÜBER {@link #BOX_ROUND_TRIP} LIEGEN</b> -
     *                     siehe die Invariante im Klassen-Javadoc. Vorgabe
     *                     PT40S.
     * @param writeTimeout wie lange auf die Quittung eines echten
     *                     Schreibvorgangs gewartet wird - dieselbe Invariante,
     *                     mit mehr Luft, weil die Box in DERSELBEN Runde liest,
     *                     schreibt, ~2 s setzen lässt und erneut liest. Läuft er
     *                     ab, ist der Zustand UNBEKANNT (nie „nicht
     *                     geschrieben"), und die Quittung landet trotzdem im
     *                     Journal, sobald sie eintrifft.
     * @param enabled      der plattformweite NOT-AUS. Vorgabe AN - ein per
     *                     Vorgabe ausgeschaltetes Flag müsste im gitops-Repo
     *                     nachgezogen werden, und genau diese Klasse hat diesem
     *                     Repo schon einen stillen Produktions-Ausfall gekostet
     *                     (die OTA-Listener-Falle). Auf {@code false} gesetzt
     *                     refüsieren Vorschau und Schreibvorgang mit deutschem
     *                     Grund; gelesen werden darf weiter.
     */
    public RegisterWriteService(DeviceRepository devices, RegisterKnowledge knowledge,
            RegisterWriteTargets targets, RegisterWriteRegistry registry,
            RegisterWriteEventRepository journal,
            ObjectProvider<RegisterWritePublisher> publisher,
            @Value("${voltpilot.register-write.read-timeout:PT40S}") Duration readTimeout,
            @Value("${voltpilot.register-write.write-timeout:PT60S}") Duration writeTimeout,
            @Value("${voltpilot.register-write.enabled:true}") boolean enabled) {
        this.devices = devices;
        this.knowledge = knowledge;
        this.targets = targets;
        this.registry = registry;
        this.journal = journal;
        this.publisher = publisher;
        this.readTimeout = readTimeout;
        this.writeTimeout = writeTimeout;
        this.enabled = enabled;
        // ⚠ Ein Budget unterhalb der Geräte-Schranke macht das Feature auf jeder
        // belegten Anlage unbrauchbar (siehe die Zeitfenster-Invariante). Es
        // wird nicht stillschweigend korrigiert - eine Vorgabe, die jemand
        // bewusst gesetzt hat, gehört ihm -, aber es wird LAUT gesagt.
        warnIfTooShort("read-timeout", readTimeout);
        warnIfTooShort("write-timeout", writeTimeout);
    }

    private static void warnIfTooShort(String name, Duration budget) {
        if (budget.compareTo(BOX_ROUND_TRIP) <= 0) {
            log.warn("voltpilot.register-write.{}={} liegt NICHT über der Geräte-Schranke von {} "
                    + "- eine Anlage, deren Wechselrichter-Bus gerade belegt ist, kann in diesem "
                    + "Fenster nicht antworten und jede Anfrage läuft in einen Timeout.",
                    name, budget, BOX_ROUND_TRIP);
        }
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

    /**
     * Was der Aufrufer will - roh, wie er es getippt hat, plus das gewählte ZIEL.
     *
     * <p><b>Die Lane ist eine WAHL, kein Default im Verborgenen</b> (Konzept
     * §2.3): {@code null}/leer heißt {@code primary}, also der Wechselrichter,
     * den die Box selbst auflöst - dieselbe Vorgabe wie in Stufe 1, damit ein
     * älterer Client zeichengleich weiterarbeitet.
     */
    public record Command(UUID deviceId, String lane, UUID entityId, String host, Integer port,
            Integer unitId, String registerKind, String addressInput, String valueInput,
            Integer expectedBefore, Integer writeFc, String note) {

        /** Die normalisierte Lane - unbekannte Wörter sind eine kaputte Anfrage. */
        public String laneOrDefault() {
            String l = lane == null ? "" : lane.trim().toLowerCase(java.util.Locale.ROOT);
            return l.isEmpty() ? RegisterWriteTargets.LANE_PRIMARY : l;
        }
    }

    /**
     * Das Ergebnis EINES Schritts, wie es die Oberfläche rendert.
     *
     * @param registerNote  der Betreiber-Hinweis des Register-Wissens (etwa
     *                      „gehört zur laufenden Steuerung"), oder {@code null}.
     * @param scaleUnit     die Einheit des SKALIERTEN Werts, oder {@code null} -
     *                      ein Register ohne bekannte Skala bekommt NIE eine
     *                      erfundene Einheit.
     * @param writesToday   wie oft dieses Register auf diesem Gerät HEUTE schon
     *                      geschrieben wurde (Berliner Tag) - EEPROM-Ehrlichkeit
     *                      statt einer Sperre.
     */
    public record Outcome(String requestId, String mode, boolean ok, String outcome,
            Integer beforeRaw, Integer afterRaw, Double beforeScaled, Double afterScaled,
            Boolean adopted, String errorCode, String message, String targetLabel,
            int address, String addressHex, String registerLabel, String registerClass,
            String scaleNote, String registerNote, String scaleUnit, boolean noteRequired,
            String confirm, int writesToday, String lane, Instant requestedAt) {
    }

    /**
     * Schritt 1: den Ist-Wert lesen. Es wird NICHTS geschrieben und NICHTS
     * protokolliert - eine Lesung ändert nichts, und ein Protokoll der Lesungen
     * würde die Schreibvorgänge begraben, für die das Journal existiert.
     */
    public Outcome preview(UUID siteId, Command cmd, Actor actor) {
        requireEnabled();
        UUID tenantId = requireTenant();
        // Die FORM zuerst: ein offensichtlicher Tippfehler wird als Tippfehler
        // gemeldet, nicht als Geräte-Problem - und er kostet keine Broker-Runde
        // (die Probe-Kanal-Regel).
        int address = address(cmd.addressInput());
        String kind = registerKind(cmd.registerKind());
        String lane = lane(cmd);
        DeviceDto device = resolveDevice(siteId, cmd.deviceId());
        RegisterKnowledge.Known known = knowledge.of(
                targets.familyFor(siteId, device.id(), lane, cmd.entityId()), address);

        String requestId = newRequestId();
        Instant requestedAt = Instant.now();
        RegisterWritePublisher.Order order = new RegisterWritePublisher.Order(
                RegisterWriteResult.MODE_READ, lane, cmd.entityId(), cmd.host(), cmd.port(),
                cmd.unitId(), kind, address, null, null, null, null);

        RegisterWriteResult result = exchange(tenantId, siteId, device, requestId, requestedAt,
                actor, order, readTimeout, false);
        // ⚠ Die Schreibzahl gehört in SCHRITT 1: „heute bereits 2x geschrieben"
        // ist eine Information VOR dem Klick, kein Nachtrag im Beleg.
        return outcome(result, address, known, null, lane,
                journal.countWritesToday(siteId, device.id(), address));
    }

    /**
     * Schritt 2: der EINE Schreibvorgang. Er verlangt die Notiz, wo die Klasse
     * sie fordert (D5), baut die Bestätigung selbst (Protokoll-Sicherheit, kein
     * Tipp-Zwang - Captain: „ohne Hürden") und schreibt die Papier-Spur.
     */
    public Outcome write(UUID siteId, Command cmd, Actor actor) {
        requireEnabled();
        UUID tenantId = requireTenant();
        // Erst die FORM, dann das Ziel: dieselbe Reihenfolge wie bei der
        // Vorschau, damit ein Tippfehler nie als Geräte-Problem erscheint.
        int address = address(cmd.addressInput());
        String kind = registerKind(cmd.registerKind());
        String lane = lane(cmd);
        int value = RegisterKnowledge.parseValue(cmd.valueInput()).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Der Wert ist keine Registerzahl (0 bis 65535, dezimal oder 0x-hexadezimal)."));
        String note = trimToNull(cmd.note());
        DeviceDto device = resolveDevice(siteId, cmd.deviceId());
        RegisterKnowledge.Known known = knowledge.of(
                targets.familyFor(siteId, device.id(), lane, cmd.entityId()), address);
        // D5: die Notiz-PFLICHT hängt an der KLASSE, und die Klasse hängt an der
        // Familie - deshalb erst hier, wenn das Ziel aufgelöst ist.
        if (known.noteRequired() && note == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Dieses Register betrifft die Netz-Anmeldung der Anlage. Bitte tragen Sie "
                            + "den Grund ein (z. B. die Freigabe des Netzbetreibers).");
        }

        String requestId = newRequestId();
        Instant requestedAt = Instant.now();
        String confirm = RegisterKnowledge.confirmToken(address, value);
        String targetLabel = targetLabel(siteId, device, lane, cmd);
        RegisterWritePublisher.Order order = new RegisterWritePublisher.Order(
                RegisterWriteResult.MODE_WRITE, lane, cmd.entityId(), cmd.host(), cmd.port(),
                cmd.unitId(), kind, address, cmd.writeFc(), value, cmd.expectedBefore(),
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
                    RegisterWriteSilence.NOT_PUBLISHED);
        }
        // ERST veröffentlichen, DANN protokollieren - ab hier ist der Vorgang
        // aktenkundig, auch wenn diese api gleich abstürzt.
        journal.recordRequest(new RegisterWriteEventRepository.Request(
                requestId, RegisterWriteEventRepository.SOURCE_PORTAL, siteId, device.id(),
                device.externalRef(), lane, cmd.entityId(), targetLabel,
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
                    silenceMessage(device, writeTimeout, true));
            journal.recordOutcome(new RegisterWriteEventRepository.Receipt(requestId,
                    RegisterWriteEventRepository.EVENT_SILENT,
                    RegisterWriteEventRepository.SOURCE_PORTAL, siteId, device.id(), null, null,
                    null, RegisterWriteResult.OUTCOME_UNKNOWN, result.message(), targetLabel,
                    Instant.now()));
        }
        // Die Quittungs-Zeile schreibt der Zuhörer - unabhängig davon, ob hier
        // noch jemand wartet.
        return outcome(result, address, known, value, lane,
                journal.countWritesToday(siteId, device.id(), address));
    }

    /** Der Verlauf der Schreibvorgänge dieser Anlage (optional je Gerät). */
    public List<RegisterWriteEventRepository.Entry> history(UUID siteId, UUID deviceId,
            int limit) {
        return journal.recent(siteId, deviceId, Math.max(1, Math.min(limit, 200)));
    }

    private RegisterWriteResult exchange(UUID tenantId, UUID siteId, DeviceDto device,
            String requestId, Instant requestedAt, Actor actor, RegisterWritePublisher.Order order,
            Duration timeout, boolean write) {
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
                    RegisterWriteSilence.NOT_PUBLISHED);
        }
        try {
            RegisterWriteResult result = registry.await(future, timeout);
            return result != null
                    ? result
                    : RegisterWriteResult.silent(requestId, order.mode(),
                            silenceMessage(device, timeout, write));
        } finally {
            registry.forget(requestId);
        }
    }

    /**
     * WARUM nichts kam - die drei unterscheidbaren Fälle (siehe
     * {@link RegisterWriteSilence}). Der Grund wird erst NACH dem Timeout
     * gebildet, damit er die Lebendigkeit von JETZT nennt und eine verspätete
     * Quittung, die inzwischen eingetroffen ist, mitzählt.
     */
    private String silenceMessage(DeviceDto device, Duration budget, boolean write) {
        String reason = RegisterWriteSilence.message(write, device.lastSeenAt(), Instant.now(),
                budget, registry.lastLateAnswer(device.id()));
        log.warn("register write to device {} stayed silent for {}: {}",
                device.id(), budget, reason);
        return reason;
    }

    private Outcome outcome(RegisterWriteResult r, int address, RegisterKnowledge.Known known,
            Integer requestedValue, String lane, int writesToday) {
        return new Outcome(r.requestId(), r.mode(), r.ok(), r.outcome(), r.beforeRaw(),
                r.afterRaw(), known.scaled(r.beforeRaw()), known.scaled(r.afterRaw()),
                r.adopted(), r.errorCode(), r.message(), r.targetLabel(), address,
                RegisterKnowledge.hex(address), known.label(), known.clazz(),
                known.scaleNote(requestedValue == null ? r.beforeRaw() : requestedValue),
                known.note(), known.scaleUnit(), known.noteRequired(),
                requestedValue == null ? null
                        : RegisterKnowledge.confirmToken(address, requestedValue),
                writesToday, lane, Instant.now());
    }

    /**
     * Die gewählte Lane - ein unbekanntes Wort ist eine kaputte Anfrage, nie ein
     * stiller Rückfall auf die primäre (der würde einen Schreibvorgang auf ein
     * ANDERES Gerät umlenken, als der Mensch gewählt hat).
     */
    private static String lane(Command cmd) {
        String lane = cmd.laneOrDefault();
        if (!RegisterWriteTargets.LANE_PRIMARY.equals(lane)
                && !RegisterWriteTargets.LANE_ENTITY.equals(lane)
                && !RegisterWriteTargets.LANE_LAN.equals(lane)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unbekanntes Ziel.");
        }
        if (RegisterWriteTargets.LANE_ENTITY.equals(lane) && cmd.entityId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für die Komponente fehlt die Kennung.");
        }
        if (RegisterWriteTargets.LANE_LAN.equals(lane)
                && (cmd.host() == null || cmd.host().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für die freie Adresse fehlt der Host.");
        }
        return lane;
    }

    private RegisterWritePublisher requirePublisher() {
        RegisterWritePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Register-Schreibpfad ist derzeit nicht verfügbar.");
        }
        return pub;
    }

    /**
     * Der plattformweite NOT-AUS - die ERSTE Anweisung beider schreibender
     * Schritte, damit ein abgeschaltetes Feature weder ein Ziel auflöst noch
     * eine Runde zum Broker dreht noch eine Journal-Zeile hinterlässt.
     *
     * <p>503, nicht 404: ein 404 ist auf diesem Pfad die Antwort des
     * Mandanten-Zauns auf eine FREMDE Anlage, und die zwei Zustände dürfen nie
     * gleich aussehen. Der Satz sagt, dass es an der PLATTFORM liegt und nicht
     * an dieser Anlage - sonst sucht ein Kunde den Fehler bei sich.
     */
    private void requireEnabled() {
        if (!enabled) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Das Schreiben von Registern ist auf dieser Plattform vorübergehend "
                            + "abgeschaltet. Es liegt nicht an Ihrer Anlage.");
        }
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
    private String targetLabel(UUID siteId, DeviceDto device, String lane, Command cmd) {
        String name = device.name() == null || device.name().isBlank()
                ? device.externalRef() : device.name();
        if (RegisterWriteTargets.LANE_LAN.equals(lane)) {
            return "Freie Adresse · " + cmd.host().trim()
                    + (cmd.port() == null ? "" : ":" + cmd.port())
                    + (cmd.unitId() == null ? "" : " · Unit " + cmd.unitId());
        }
        if (RegisterWriteTargets.LANE_ENTITY.equals(lane)) {
            // Der Klartext-Name ist KOSMETIK - er darf einen Schreibvorgang nie
            // verhindern. Die Box echot ihr eigenes, genaueres Label ohnehin.
            try {
                return targets.forSite(siteId).stream()
                        .filter(t -> cmd.entityId().equals(t.entityId()))
                        .map(t -> "Komponente „" + t.label() + "\"")
                        .findFirst()
                        .orElse("Komponente · " + cmd.entityId());
            } catch (RuntimeException e) {
                log.warn("component label for {} could not be resolved: {}",
                        cmd.entityId(), e.getMessage());
                return "Komponente · " + cmd.entityId();
            }
        }
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
