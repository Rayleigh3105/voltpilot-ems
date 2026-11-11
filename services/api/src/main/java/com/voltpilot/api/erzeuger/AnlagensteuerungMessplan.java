package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.MeasurementSelectionService.Automatik;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.DatenquelleAenderungRepository;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS EZ-18 „Messplan automatisch“: nach „Steuerung verbinden“ liest die zuständige Box die Steuerung von allein —
 * niemand muss im Portal Messwerte anhaken. Der Plan, den {@link MeasurementConfigPublisher} an die Box schickt,
 * entsteht nur aus der Mess-Auswahl; darum wählt die Cloud hier ALLE Punkte des Erzeuger-Registerbilds der
 * Steuerung ({@link ErzeugerRegisterbild#punkte}) für die Box aus, die die Komponente ausführt
 * ({@link EinmalAuftragZiel#komponente} — dieselbe Box, für die {@code forPublishing} die Punkte durchlässt), mit
 * dem Takt des Katalogs, gegen dasselbe Budget wie die Handauswahl ({@link MeasurementSelectionService#automatischAuswaehlen}).
 *
 * <p><b>Zwei Wege, eine Regel.</b> {@link #auswaehlen} läuft beim Anlegen in dessen Transaktion; {@link #nachholen}
 * läuft im Takt des Mess-Abgleichs ({@code MeasurementConfigReconciler}, beim Start und alle 30 s) für jede
 * Steuerung, deren zuständige Box für sie noch keine Auswahl hat — so liefern schon angelegte Steuerungen nach dem
 * Deploy, und nach einem Wechsel der zuständigen Box bekommt die neue Box den Plan. Ausgewählt wird nur, wenn die
 * Box für die Komponente GAR KEINE Auswahlzeile hat: eine Abwahl von Hand bleibt stehen. Je Box und Steuerung
 * genau einmal: der Eintrag {@value #PROTOKOLL_ART} im Protokoll der Datenquelle nennt das Ergebnis — auch, welche
 * Punkte das Budget nicht mehr trug (nie still nichts) — und hält das Nachholen für diese Box an.
 *
 * <p>Eine Box ohne {@value ErzeugerRegisterbild#FAEHIGKEIT} bekommt nichts (sie wiese den Plan ab); eine Quelle ohne
 * ausführende Box (offene Übergabe) wartet auf den nächsten Takt.
 */
@Service
public class AnlagensteuerungMessplan {

    private static final Logger log = LoggerFactory.getLogger(AnlagensteuerungMessplan.class);

    /** Die Art des Eintrags im Protokoll der Datenquelle (V20261022160000). */
    public static final String PROTOKOLL_ART = "messwerte_ausgewaehlt";

    /** Eine Steuerung, für deren zuständige Box die Auswahl fehlt (gefunden über die Verwaltungsverbindung). */
    record Kandidat(UUID tenantId, UUID siteId, UUID entityId, UUID dataSourceId, int teAnzahl) {}

    /** Was beim Auswählen geschah: die Box und das Ergebnis der Auswahl. */
    public record Ergebnis(UUID box, Automatik automatik) {}

    private final MeasurementSelectionService selections;
    private final EinmalAuftragZiel ziel;
    private final BoxFaehigkeiten faehigkeiten;
    private final DatenquelleAenderungRepository protokoll;
    private final JdbcTemplate jdbc;
    private final JdbcTemplate adminJdbc;
    private final TransactionTemplate tx;
    private final ObjectProvider<MeasurementConfigPublisher> publisher;
    private final ObjectMapper json;

    /** Beendete Kundenbereiche lässt das Nachholen aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    public AnlagensteuerungMessplan(MeasurementSelectionService selections, EinmalAuftragZiel ziel,
            BoxFaehigkeiten faehigkeiten, DatenquelleAenderungRepository protokoll, JdbcTemplate jdbc,
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, PlatformTransactionManager transaktionen,
            ObjectProvider<MeasurementConfigPublisher> publisher, ObjectMapper json) {
        this.selections = selections;
        this.ziel = ziel;
        this.faehigkeiten = faehigkeiten;
        this.protokoll = protokoll;
        this.jdbc = jdbc;
        this.adminJdbc = adminJdbc;
        this.tx = new TransactionTemplate(transaktionen);
        this.publisher = publisher;
        this.json = json;
    }

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    /**
     * Wählt die Punkte des Bilds für die Box aus, die die Komponente jetzt ausführt — im Kontext des Aufrufers
     * (Mandant gesetzt, seine Transaktion). Leer, wenn nichts geschah: keine ausführende Box, Box ohne Fähigkeit,
     * für diese Box schon einmal ausgewählt, oder die Box hat für die Komponente schon eine Auswahl. Wirft für
     * keinen dieser Fälle — beim Anlegen risse eine Ausnahme die ganze Steuerung mit.
     *
     * @param anlass {@code anlegen} oder {@code nachholen} (steht im Protokoll)
     */
    public Optional<Ergebnis> auswaehlen(UUID siteId, UUID entityId, UUID dataSourceId, int teAnzahl,
            String anlass) {
        UUID box;
        try {
            box = ziel.komponente(siteId, entityId).id();
        } catch (ResponseStatusException e) {
            // Keine ausführende Box (etwa eine offene Übergabe): der nächste Abgleich holt nach.
            return Optional.empty();
        }
        if (!faehigkeiten.kann(box, ErzeugerRegisterbild.FAEHIGKEIT) || schonAusgewaehlt(dataSourceId, box, entityId)) {
            return Optional.empty();
        }
        List<String> punkte = ErzeugerRegisterbild.punkte(teAnzahl);
        Automatik a = selections.automatischAuswaehlen(box, entityId, punkte);
        if (!a.ausgefuehrt()) {
            return Optional.empty();
        }
        protokoll.eintragen(new DatenquelleAenderungRepository.NeuerEintrag(TenantContext.get(), dataSourceId,
                PROTOKOLL_ART, box, null, null, neu(entityId, anlass, punkte.size(), a),
                Instant.now().truncatedTo(ChronoUnit.MINUTES), ProtokollAkteur.messplan()));
        if (a.ausgelassen().isEmpty()) {
            log.info("Anlagensteuerung {}: {} Messpunkte für Box {} ausgewählt ({}), bis Revision {}", entityId,
                    a.gewaehlt().size(), box, anlass, a.revision());
        } else {
            log.warn("Anlagensteuerung {}: {} von {} Messpunkten für Box {} ausgewählt ({}), ausgelassen: {}", entityId,
                    a.gewaehlt().size(), punkte.size(), box, anlass, a.ausgelassen());
        }
        return Optional.of(new Ergebnis(box, a));
    }

    /**
     * Holt die Auswahl für jede Steuerung nach, deren zuständige Box für sie noch keine hat — eine Transaktion je
     * Steuerung unter ihrem Mandanten. Idempotent: eine versorgte Steuerung findet die Abfrage nicht mehr.
     *
     * @return die Boxen, die eine neue Auswahl bekommen haben (der Abgleich liefert sie im selben Durchlauf aus)
     */
    public List<UUID> nachholen() {
        List<UUID> boxen = new ArrayList<>();
        for (Kandidat k : kandidaten()) {
            if (beendete.beendet(k.tenantId())) continue; // Kundenbereich beendet: das Nachholen lässt ihn aus
            TenantContext.set(k.tenantId());
            try {
                tx.execute(status -> auswaehlen(k.siteId(), k.entityId(), k.dataSourceId(), k.teAnzahl(),
                        "nachholen")).ifPresent(e -> boxen.add(e.box()));
            } catch (RuntimeException e) {
                log.warn("Messplan der Anlagensteuerung {} konnte nicht nachgeholt werden: {}", k.entityId(),
                        e.getMessage());
            } finally {
                TenantContext.clear();
            }
        }
        return boxen;
    }

    /**
     * Stößt die Zustellung an die Box sofort an, wie die Handauswahl ({@code DeviceMeasurementSelectionController}):
     * Bestzustellung, der Abgleich liefert sonst binnen 30 s. Nie eine Ausnahme — die Steuerung ist angelegt.
     */
    public void zustellen(UUID siteId, UUID entityId) {
        MeasurementConfigPublisher p = publisher.getIfAvailable();
        if (p == null) return;
        try {
            UUID box = ziel.komponente(siteId, entityId).id();
            p.publish(selections.requireDevice(box), selections.forPublishing(box));
        } catch (RuntimeException e) {
            log.warn("Messplan der Anlagensteuerung {} nicht sofort zugestellt (der Abgleich holt nach): {}", entityId,
                    e.getMessage());
        }
    }

    /**
     * Die Steuerungen mit laufender Fassung, deren gerade zuständige Box für ihre Komponente weder eine Auswahlzeile
     * noch einen Eintrag {@value #PROTOKOLL_ART} hat — über alle Mandanten (Verwaltungsverbindung, nur Adressen;
     * gewählt wird danach unter RLS).
     */
    List<Kandidat> kandidaten() {
        return adminJdbc.query("""
                SELECT m.tenant_id, m.site_id, m.id, m.data_source_id, f.te_anzahl
                  FROM measurement_point m
                  JOIN geraet_komponente v ON v.entity_id = m.id AND v.gueltig_ab <= now()
                       AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now())
                  JOIN geraet g ON g.id = v.geraet_id AND g.ausgebaut_am IS NULL
                  JOIN registerbild_fassung f ON f.geraet_id = g.id AND f.bildart = ? AND f.gueltig_ab <= now()
                       AND (f.gueltig_bis IS NULL OR f.gueltig_bis > now())
                  JOIN data_source_assignment a ON a.data_source_id = m.data_source_id
                       AND a.zurueckgenommen_am IS NULL AND a.effective_from <= now()
                       AND (a.effective_to IS NULL OR a.effective_to > now())
                  JOIN device d ON d.id = a.device_id AND d.ausgebaut_am IS NULL
                 WHERE m.entity_type = ?
                   AND NOT EXISTS (SELECT 1 FROM device_measurement_selection s
                                    WHERE s.device_id = a.device_id AND s.entity_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM data_source_aenderung p
                                    WHERE p.data_source_id = m.data_source_id AND p.art = ?
                                      AND p.device_id = a.device_id AND p.neu ->> 'entity_id' = m.id::text)
                 ORDER BY m.tenant_id, m.id
                """, (rs, n) -> new Kandidat(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class), rs.getObject(4, UUID.class), rs.getInt(5)),
                ErzeugerRegisterbild.BILDART, AnlagensteuerungRepository.ENTITY_TYPE, PROTOKOLL_ART);
    }

    /** Hat die Cloud für diese Box und Steuerung schon einmal ausgewählt? Dann nie wieder von allein. */
    private boolean schonAusgewaehlt(UUID dataSourceId, UUID box, UUID entityId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM data_source_aenderung "
                + "WHERE data_source_id = ? AND art = ? AND device_id = ? AND neu ->> 'entity_id' = ?)",
                Boolean.class, dataSourceId, PROTOKOLL_ART, box, entityId.toString()));
    }

    private String neu(UUID entityId, String anlass, int angefragt, Automatik a) {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("entity_id", entityId.toString());
        neu.put("anlass", anlass);
        neu.put("angefragt", angefragt);
        neu.put("gewaehlt", a.gewaehlt().size());
        neu.put("revision", a.revision());
        neu.put("ausgelassen", a.ausgelassen().stream()
                .map(x -> Map.of("point_key", x.pointKey(), "grund", x.grund())).toList());
        try {
            return json.writeValueAsString(neu);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
