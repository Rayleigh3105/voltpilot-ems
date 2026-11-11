package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.PushAnbindungen;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.DatenquelleAdresse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * UEMS EZ-21 „Box-Quelle der Anlagensteuerung“: damit die zuständige Box die Steuerung nach „Steuerung verbinden“
 * von allein liest, braucht ihre Komponente im Registry-Push zweierlei — einen Treiber mit dem Transport ihrer
 * Datenquelle (Modbus TCP host:port und die Geräte-ID der Steuerung, Lesetakt {@value #LESETAKT_S} s) und den Pin
 * {@code edge_source_id}, unter dem die Box diese Quelle führt. Die Box leitet daraus eine Quelle der Rolle
 * {@value #ROLLE} ab ({@code componentapply}, ohne Wechselrichter-Katalog), und die Palette bindet die Komponente
 * über den Pin daran (Vertrag {@code edge-entity.schema.json} {@code x-anlagensteuerung-driver-rule}).
 *
 * <p><b>Nur an eine Box, die es versteht.</b> Treiber und Pin entstehen erst beim Zusammensetzen des Pushs für
 * EINE Box ({@link #fuerBox}) und nur, wenn sie {@value #FAEHIGKEIT} meldet ({@link BoxFaehigkeiten#kann}): ein
 * älterer Applier sähe einen Treiber mit Verbindung und ohne Marke und verweigerte den GANZEN Push. Jede andere Box
 * bekommt die Steuerung Byte für Byte wie vorher. Weil beides aus der Datenquelle beim Push entsteht, folgt es von
 * selbst einer geänderten Adresse und einem Wechsel der zuständigen Box ({@code QuellenUebergabe}).
 *
 * <p><b>Der gespeicherte Pin.</b> Die Box meldet die Quelle im Herzschlag ({@code local_setup}); ohne Pin an der
 * Komponente stünde sie im Portal als „Neues Gerät gefunden“. Darum steht der Pin auch an der Komponente —
 * gesetzt beim Anlegen und im Takt des Abgleichs nachgeholt ({@link #nachholen}), sobald die zuständige Box das Wort
 * meldet; danach geht der Push an die Box. Meldet eine Box das Wort neu (nach ihrem Update), stößt
 * {@link #nachFaehigkeitsmeldung} denselben Weg sofort an.
 *
 * <p><b>Der Pin ist gerechnet, nicht geraten.</b> {@link #kennung} ist der Java-Zwilling von
 * {@code sources.DeterministicID} für genau diese Quelle (Rolle, Kommunikation, Adresse, Port, Geräte-ID); beide
 * prüfen dieselben Fälle in {@code anlagensteuerung-quelle-vectors.json}.
 */
@Service
public class AnlagensteuerungQuelle implements PushAnbindungen {

    private static final Logger log = LoggerFactory.getLogger(AnlagensteuerungQuelle.class);

    /** Das Fähigkeitswort der Box (edge-supports.md). */
    public static final String FAEHIGKEIT = "anlagensteuerung_quelle";
    /** Die Rolle der Quelle auf der Box ({@code sources.RolePlantController}). */
    public static final String ROLLE = "plant-controller";
    /** Die Kommunikation der Quelle — dieselbe wie das Protokoll der Datenquelle. */
    public static final String KOMMUNIKATION = "modbus_tcp";
    /** Der Lesetakt des Erzeuger-Bilds (EW-5 A). */
    public static final int LESETAKT_S = 5;

    private static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

    /** Wie die Box die Steuerung erreicht: die Werte der Datenquelle, unverändert. */
    public record Transport(String host, int port, int unitId) {}

    /** Eine Steuerung, deren gespeicherter Pin nicht der gerechnete ist (über die Verwaltungsverbindung gefunden). */
    record Kandidat(UUID tenantId, UUID siteId, UUID box) {}

    private final AnlagensteuerungRepository repo;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectProvider<EntityRegistryService> registry;
    private final JdbcTemplate adminJdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    /** Beendete Kundenbereiche lässt das Nachholen aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    public AnlagensteuerungQuelle(AnlagensteuerungRepository repo, BoxFaehigkeiten faehigkeiten,
            ObjectProvider<EntityRegistryService> registry, @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            PlatformTransactionManager transaktionen, ObjectMapper json) {
        this.repo = repo;
        this.faehigkeiten = faehigkeiten;
        this.registry = registry;
        this.adminJdbc = adminJdbc;
        // Eigene Transaktion: das Nachholen läuft auch nach dem Commit einer Fähigkeitsmeldung, deren
        // Ressourcen dann noch gebunden sind - mit REQUIRED schriebe es in eine schon beendete Transaktion.
        this.tx = new TransactionTemplate(transaktionen);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.json = json;
    }

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    // ------------------------------------------------------------ die Regel

    /**
     * Der Transport einer Steuerung aus ihrer Datenquelle — leer, wenn die Box sie so nicht lesen kann: kein
     * Modbus TCP, keine lesbare Adresse oder eine Geräte-ID außerhalb 0 … 255.
     */
    public static Optional<Transport> transport(String protokoll, String adresse, Integer unitId) {
        if (!KOMMUNIKATION.equals(protokoll) || adresse == null || unitId == null || unitId < 0 || unitId > 255) {
            return Optional.empty();
        }
        try {
            DatenquelleAdresse.HostPort hp = DatenquelleAdresse.hostPort(adresse);
            if (hp.host().isBlank() || hp.port() < 1 || hp.port() > 65_535) return Optional.empty();
            return Optional.of(new Transport(hp.host(), hp.port(), unitId));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    /**
     * Die Kennung, unter der die Box diese Quelle führt — der Zwilling von {@code sources.DeterministicID}:
     * sha256 über Rolle, Kommunikation, Adresse, Port und Geräte-ID (je durch einen Zeilenumbruch getrennt), die
     * ersten acht Bytes je modulo 31 in das Alphabet ohne 0/O/1/l/i.
     */
    public static String kennung(Transport t) {
        String identitaet = String.join("\n", ROLLE, KOMMUNIKATION, t.host().strip(), Integer.toString(t.port()),
                Integer.toString(t.unitId()));
        byte[] summe;
        try {
            summe = MessageDigest.getInstance("SHA-256").digest(identitaet.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        StringBuilder id = new StringBuilder("src-");
        for (int i = 0; i < 8; i++) {
            id.append(ALPHABET.charAt((summe[i] & 0xff) % ALPHABET.length()));
        }
        return id.toString();
    }

    /** Der Treiber im Push ({@code $defs/anlagensteuerung_driver}): keine Marke, kein Modell, keine Rolle. */
    public static ObjectNode treiber(ObjectMapper json, Transport t, String kennzeichen) {
        ObjectNode d = json.createObjectNode();
        d.put("communication", KOMMUNIKATION);
        d.put("interval_s", LESETAKT_S);
        ObjectNode c = d.putObject("connection");
        c.put("ip", t.host());
        c.put("port", t.port());
        c.put("unit_id", t.unitId());
        if (kennzeichen != null) {
            d.put("data_source_id", kennzeichen);
        }
        return d;
    }

    // ------------------------------------------------------------ der Push

    /**
     * Treiber und Pin jeder Steuerung der Anlage für diese Box — oder {@link Anbindung#keine()} je Steuerung, wenn
     * die Box {@value #FAEHIGKEIT} nicht meldet (der Push bleibt dann, wie er vor EZ-21 war). Welche Steuerung
     * überhaupt an diese Box geht, entscheidet weiter {@code PushJeBox}. Im Kontext des Aufrufers (Mandant gesetzt).
     */
    @Override
    public Map<UUID, Anbindung> fuerBox(UUID siteId, UUID box) {
        List<AnlagensteuerungRepository.Transport> steuerungen = repo.transporte(siteId);
        if (steuerungen.isEmpty()) return Map.of();
        boolean kann = box != null && faehigkeiten.kann(box, FAEHIGKEIT);
        Map<UUID, Anbindung> out = new LinkedHashMap<>();
        for (AnlagensteuerungRepository.Transport s : steuerungen) {
            Optional<Transport> t = kann ? transport(s.protokoll(), s.adresse(), s.unitId()) : Optional.empty();
            if (kann && t.isEmpty()) {
                log.warn("Anlagensteuerung {}: Datenquelle {} ({} {}, Geräte-ID {}) ist für die Box nicht lesbar — "
                        + "kein Treiber im Push", s.entityId(), s.kennzeichen(), s.protokoll(), s.adresse(),
                        s.unitId());
            }
            out.put(s.entityId(), t.map(x -> new Anbindung(kennung(x), treiber(json, x, s.kennzeichen())))
                    .orElseGet(Anbindung::keine));
        }
        return out;
    }

    // ------------------------------------------------------------ der Pin

    /**
     * Speichert den Pin jeder Steuerung der Anlage, die {@code box} liest, wenn sie {@value #FAEHIGKEIT} meldet — im Kontext
     * des Aufrufers (Mandant gesetzt, seine Transaktion). {@code true}, wenn sich ein Pin geändert hat; der Aufrufer
     * stellt dann den Push zu.
     */
    public boolean pinsSetzen(UUID siteId, UUID box) {
        if (box == null || !faehigkeiten.kann(box, FAEHIGKEIT)) return false;
        boolean geaendert = false;
        for (AnlagensteuerungRepository.Transport s : repo.transporte(siteId)) {
            if (!box.equals(s.box())) continue; // eine andere Box liest sie: ihr Wort entscheidet
            Optional<Transport> t = transport(s.protokoll(), s.adresse(), s.unitId());
            if (t.isPresent() && repo.pinSetzen(s.entityId(), kennung(t.get()))) {
                log.info("Anlagensteuerung {}: Pin {} für Box {} gesetzt", s.entityId(), kennung(t.get()), box);
                geaendert = true;
            }
        }
        return geaendert;
    }

    /**
     * Stellt den Registry-Push der Anlage zu (Bestzustellung, nie eine Ausnahme — die Steuerung ist angelegt; der
     * nächste Abgleich holt nach).
     */
    public void zustellen(UUID siteId) {
        EntityRegistryService r = registry.getIfAvailable();
        if (r == null) return;
        try {
            r.pushRegistryBestEffort(siteId);
        } catch (RuntimeException e) {
            log.warn("Registry-Push der Anlage {} nach der Anlagensteuerung nicht zugestellt: {}", siteId,
                    e.getMessage());
        }
    }

    /**
     * Holt den Pin für jede Steuerung nach, deren zuständige Box {@value #FAEHIGKEIT} meldet und deren gespeicherter
     * Pin nicht der gerechnete ist — Gore und jede andere vor EZ-21 angelegte Steuerung, nach einer geänderten
     * Adresse auch eine spätere —, und stellt der Anlage danach den Push zu. Eine Transaktion je Anlage unter ihrem
     * Mandanten. Idempotent: eine versorgte Steuerung findet die Abfrage nicht mehr.
     *
     * @return die Anlagen, deren Push neu zugestellt wurde
     */
    public List<UUID> nachholen() {
        return nachholen(null);
    }

    private List<UUID> nachholen(UUID nurBox) {
        List<UUID> anlagen = new ArrayList<>();
        UUID vorher = TenantContext.get();
        try {
            for (Kandidat k : kandidaten(nurBox)) {
                if (beendete.beendet(k.tenantId())) continue; // Kundenbereich beendet: das Nachholen lässt ihn aus
                TenantContext.set(k.tenantId());
                try {
                    // Pin und Push in EINER Transaktion: der Push zeichnet das Soll der Box auf
                    // (registry state), das gehört zum selben Commit wie der Pin.
                    Boolean zugestellt = tx.execute(status -> {
                        boolean geaendert = pinsSetzen(k.siteId(), k.box());
                        if (geaendert || nurBox != null) zustellen(k.siteId());
                        return geaendert || nurBox != null;
                    });
                    if (Boolean.TRUE.equals(zugestellt)) anlagen.add(k.siteId());
                } catch (RuntimeException e) {
                    log.warn("Pin der Anlagensteuerung an Anlage {} konnte nicht nachgeholt werden: {}", k.siteId(),
                            e.getMessage());
                }
            }
        } finally {
            if (vorher == null) TenantContext.clear();
            else TenantContext.set(vorher);
        }
        return anlagen;
    }

    /**
     * Meldet eine Box {@value #FAEHIGKEIT} neu — nach ihrem Update —, bekommt sie Treiber und Pin sofort: der Push,
     * den sie hat, entstand noch ohne. Nach dem Commit der Meldung; ein Fehler hier nimmt der Box nie ihre
     * Fähigkeiten, und ein verlorener Anstoß holt der Abgleich nach.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void nachFaehigkeitsmeldung(BoxFaehigkeiten.Gemeldet meldung) {
        if (meldet(meldung.vorher()) || !meldet(meldung.nachher())) return;
        try {
            List<UUID> anlagen = nachholen(meldung.deviceId());
            if (!anlagen.isEmpty()) {
                log.info("Box {} meldet {}: Registry-Push mit Anlagensteuerung an {} zugestellt", meldung.deviceId(),
                        FAEHIGKEIT, anlagen);
            }
        } catch (RuntimeException e) {
            log.warn("Anstoß der Anlagensteuerung für Box {} fehlgeschlagen: {}", meldung.deviceId(), e.getMessage());
        }
    }

    static boolean meldet(List<String> supports) {
        return supports != null && supports.contains(FAEHIGKEIT);
    }

    /**
     * Je Anlage und zuständiger Box mit dem Wort: die Steuerungen, deren gespeicherter Pin nicht der gerechnete ist
     * — oder, mit {@code nurBox}, jede Steuerung dieser Box. Über alle Mandanten (Verwaltungsverbindung, nur
     * Adressen); entschieden wird danach unter RLS mit {@link BoxFaehigkeiten#kann}.
     */
    List<Kandidat> kandidaten(UUID nurBox) {
        record Zeile(UUID tenantId, UUID siteId, UUID box, String pin, String protokoll, String adresse,
                Integer unitId) {}
        List<Zeile> zeilen = adminJdbc.query("""
                SELECT m.tenant_id, m.site_id, a.device_id, m.edge_source_id, q.protokoll, q.adresse, g.geraete_id
                  FROM measurement_point m
                  JOIN geraet_komponente v ON v.entity_id = m.id AND v.gueltig_ab <= now()
                       AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now())
                  JOIN geraet g ON g.id = v.geraet_id AND g.geraeteart = 'controller' AND g.ausgebaut_am IS NULL
                  JOIN data_source q ON q.id = g.data_source_id AND q.archiviert_am IS NULL
                  JOIN data_source_assignment a ON a.data_source_id = q.id
                       AND a.zurueckgenommen_am IS NULL AND a.effective_from <= now()
                       AND (a.effective_to IS NULL OR a.effective_to > now())
                  JOIN device d ON d.id = a.device_id AND d.ausgebaut_am IS NULL
                       AND d.supports @> to_jsonb(ARRAY[?::text])
                 WHERE m.entity_type = ?
                 ORDER BY m.tenant_id, m.site_id, m.id
                """, (rs, n) -> new Zeile(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class), rs.getString(4), rs.getString(5), rs.getString(6),
                        (Integer) rs.getObject(7)),
                FAEHIGKEIT, AnlagensteuerungRepository.ENTITY_TYPE);
        Set<Kandidat> out = new LinkedHashSet<>();
        for (Zeile z : zeilen) {
            if (nurBox != null && !nurBox.equals(z.box())) continue;
            boolean veraltet = transport(z.protokoll(), z.adresse(), z.unitId())
                    .map(t -> !kennung(t).equals(z.pin())).orElse(false);
            if (nurBox != null || veraltet) out.add(new Kandidat(z.tenantId(), z.siteId(), z.box()));
        }
        return List.copyOf(out);
    }
}
