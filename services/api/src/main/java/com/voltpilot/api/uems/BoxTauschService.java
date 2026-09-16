package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** AP-06 E7: ein atomarer Nachfolger, keine neue physische Geräte-/Quellenidentität. */
@Service
public class BoxTauschService {
    private final JdbcTemplate jdbc;
    private final DeviceRepository devices;
    private final Geltungsbereich scope;
    private final RechtPruefung rechte;
    private final ZustaendigkeitRepository assignments;
    private final DatenquelleAenderungRepository journal;
    private final ObjectMapper json;
    private final Clock clock;
    private final com.voltpilot.api.repo.CommandLogRepository commands;

    public BoxTauschService(JdbcTemplate jdbc, DeviceRepository devices, Geltungsbereich scope,
            RechtPruefung rechte, ZustaendigkeitRepository assignments,
            DatenquelleAenderungRepository journal, ObjectMapper json, ObjectProvider<Clock> clock,
            com.voltpilot.api.repo.CommandLogRepository commands) {
        this.jdbc = jdbc;
        this.devices = devices;
        this.scope = scope;
        this.rechte = rechte;
        this.assignments = assignments;
        this.journal = journal;
        this.json = json;
        this.clock = clock.getIfAvailable(Clock::systemUTC);
        this.commands = commands;
    }

    public record Ergebnis(UUID oldDeviceId, UUID newDeviceId, UUID siteId, Instant effectiveAt,
            Map<String, Integer> transferred) {}

    @Transactional
    public Ergebnis tauschen(UUID newId, UUID oldId, ProtokollAkteur actor) {
        // Sichtbarkeit beider Boxen VOR einer Konfliktauskunft; kein Fremdobjekt verraten.
        DeviceDto old = box(oldId);
        DeviceDto replacement = box(newId);
        scope.requireSite(old.siteId());
        scope.requireSite(replacement.siteId());
        rechte.pruefen("datenquelle.zustaendigkeit", RechtZiel.DEVICE, oldId, BoxTauschService::nichtGefunden);
        rechte.pruefen("datenquelle.zustaendigkeit", RechtZiel.DEVICE, newId, BoxTauschService::nichtGefunden);
        if (newId.equals(oldId)) throw konflikt("dieselbe_box", "Bitte eine andere Box als Nachfolger wählen.");
        if (!old.siteId().equals(replacement.siteId())) throw konflikt("nachfolger_andere_heimat",
                "Ein Box-Tausch über Anlagen hinweg ist noch nicht möglich. Bitte die neue Box an derselben Anlage anmelden.");
        // Gemeinsamer Topologie-Zaun mit Claim/Komponenten-Konfiguration; feste Reihenfolge.
        List<UUID> sites = java.util.stream.Stream.of(old.siteId(), replacement.siteId()).distinct().sorted().toList();
        for (UUID site : sites) devices.lockTopology(site);
        jdbc.queryForList("SELECT id FROM device WHERE id IN (?,?) ORDER BY id FOR UPDATE", UUID.class, oldId, newId);
        old = box(oldId);
        replacement = box(newId);
        if (!old.siteId().equals(replacement.siteId())) throw konflikt("nachfolger_andere_heimat",
                "Ein Box-Tausch über Anlagen hinweg ist noch nicht möglich.");
        Instant at = clock.instant().truncatedTo(ChronoUnit.MINUTES);
        UUID tenant = TenantContext.get();
        var active = assignments.alle().stream().filter(a -> a.deviceId().equals(oldId)
                && (a.effectiveTo() == null || a.effectiveTo().isAfter(at))).toList();
        for (var a : active) {
            UUID sourceSite = jdbc.queryForObject("SELECT site_id FROM data_source WHERE id=? FOR UPDATE",
                    UUID.class, a.dataSourceId());
            scope.requireSite(sourceSite);
            if (!sourceSite.equals(old.siteId())) throw konflikt("anlagenfremde_quelle",
                    "Die anlagenübergreifende Quellenübergabe ist noch nicht verfügbar.");
            if (!assignments.fuerQuelle(a.dataSourceId()).contains(a)) throw konflikt("gleichzeitig_geaendert",
                    "Die Zuständigkeit wurde inzwischen geändert.");
            if (!a.effectiveFrom().isBefore(at) || assignments.fuerQuelle(a.dataSourceId()).stream()
                    .anyMatch(z -> z.effectiveFrom().isAfter(at))) {
                throw konflikt("geplanter_wechsel", "Für diese Box ist bereits ein Zuständigkeitswechsel vorbereitet.");
            }
        }
        // Eine bereits eingesetzte Nachfolger-Box wird niemals still überschrieben.
        if (exists("SELECT EXISTS (SELECT 1 FROM data_source_assignment WHERE device_id=? "
                + "AND zurueckgenommen_am IS NULL AND (effective_to IS NULL OR effective_to>?))", newId, Timestamp.from(at))
                || exists("SELECT EXISTS (SELECT 1 FROM measurement_point WHERE device_id=?)", newId)
                || exists("SELECT EXISTS (SELECT 1 FROM asset WHERE device_id=?)", newId)
                || exists("SELECT EXISTS (SELECT 1 FROM site WHERE lead_device_id=?)", newId)
                || exists("SELECT EXISTS (SELECT 1 FROM device_measurement_selection WHERE device_id=?)", newId)
                || exists("SELECT EXISTS (SELECT 1 FROM device_control_activation WHERE device_id=?)", newId)
                || exists("SELECT EXISTS (SELECT 1 FROM device_update_target WHERE device_id=?)", newId)) {
            throw konflikt("nachfolger_belegt", "Die neue Box hat bereits eigene Aufgaben oder Einstellungen.");
        }
        if (exists("SELECT EXISTS (SELECT 1 FROM device_succession WHERE tenant_id=? "
                + "AND (old_device_id IN (?,?) OR new_device_id=?) AND delivered_at IS NULL)", tenant, oldId, newId, oldId)) {
            throw konflikt("tausch_ausstehend", "Der vorige Box-Tausch ist noch nicht zugestellt.");
        }
        // Laufende Einmal-Aufträge werden nicht auf andere Hardware umgedeutet.
        // Die Auftragshistorie und Rückmeldungen bleiben an ihrer ursprünglichen Box.
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (var a : active) {
            if (!assignments.beenden(a.id(), at)) throw konflikt("gleichzeitig_geaendert", "Die Zuständigkeit wurde inzwischen geändert.");
            UUID next = assignments.eintragen(tenant, a.dataSourceId(), newId, at, a.effectiveTo(), actor.sub()).orElseThrow();
            journal.eintragen(new DatenquelleAenderungRepository.NeuerEintrag(tenant, a.dataSourceId(),
                    "zustaendigkeit_gewechselt", newId, null, encode(Map.of("device_id", oldId)),
                    encode(Map.of("device_id", newId, "anlass", "box_tausch")), at, actor));
            // QuellenUebergabe hält die neue Box zurück, bis die Zustellung den ACL-Entzug
            // bestätigt. Eine defekte Box kann die alte Registry nicht mehr quittieren.
            jdbc.update("INSERT INTO data_source_handover (tenant_id,data_source_id,site_id,assignment_id,reader_id,target_id,phase,due_at,event_id) "
                    + "VALUES (?,?,?,?,?,?,'pending',?,?) ON CONFLICT (tenant_id,data_source_id) DO UPDATE SET "
                    + "assignment_id=EXCLUDED.assignment_id,reader_id=EXCLUDED.reader_id,target_id=EXCLUDED.target_id,"
                    + "phase='pending',due_at=EXCLUDED.due_at,started_at=NULL,sent_revision=NULL,written_xid=pg_current_xact_id()",
                    tenant, a.dataSourceId(), old.siteId(), next, oldId, newId, Timestamp.from(at), UUID.randomUUID());
        }
        counts.put("zustaendigkeiten", active.size());
        counts.put("komponenten", jdbc.update("UPDATE measurement_point SET device_id=? WHERE device_id=?", newId, oldId));
        counts.put("anlagenobjekte", jdbc.update("UPDATE asset SET device_id=? WHERE device_id=?", newId, oldId));
        counts.put("fuehrende_rolle", jdbc.update("UPDATE site SET lead_device_id=? WHERE lead_device_id=?", newId, oldId));
        long revision = jdbc.queryForObject("SELECT coalesce(max(desired_revision),0) FROM device_measurement_selection_event WHERE device_id=?", Long.class, newId);
        counts.put("mess_selektionen", jdbc.update("UPDATE device_measurement_selection SET device_id=?, desired_revision=desired_revision+?, "
                + "apply_status='pending_edge',apply_reason=NULL,applied_at=NULL WHERE device_id=?", newId, revision, oldId));
        // Historische Auswahl-Ereignisse bleiben bei der alten Hardware. Neue Anforderungen
        // erzeugen die eigene Revisionsfolge der Nachfolger-Box, ohne eine Quittung zu erfinden.
        jdbc.update("""
                INSERT INTO device_measurement_selection_event (tenant_id,site_id,device_id,entity_id,point_key,
                    desired_revision,event_kind,requested_enabled,requested_cadence_s,enabled_at,disabled_at,
                    catalog_version,actor,actor_name,apply_status,custom_definition,retention_class,
                    raw_retention_days,long_term_cadence_s,long_term_strategy,idempotency_key)
                SELECT tenant_id,site_id,device_id,entity_id,point_key,desired_revision,'selection_requested',
                    enabled,cadence_s,enabled_at,disabled_at,catalog_version,?,?,'pending_edge',custom_definition,
                    retention_class,raw_retention_days,long_term_cadence_s,long_term_strategy,gen_random_uuid()
                FROM device_measurement_selection WHERE device_id=?
                """, actor.sub() == null ? "box_tausch" : actor.sub(), actor.name(), newId);
        counts.put("freigaben", jdbc.update("UPDATE device_control_activation SET device_id=? WHERE device_id=?", newId, oldId));
        counts.put("ota_zuordnungen", jdbc.update("UPDATE device_update_target SET device_id=?,published_at=NULL WHERE device_id=?", newId, oldId));
        jdbc.update("UPDATE device SET status='retired',ausgebaut_am=? WHERE id=?", Timestamp.from(at), oldId);
        commands.beimAusbauBeenden(oldId);
        jdbc.update("""
                INSERT INTO device_succession (tenant_id,old_device_id,new_device_id,site_id,previous_site_id,
                    effective_at,actor_sub,actor_name,actor_rolle,actor_art,transferred)
                VALUES (?,?,?,?,?,?,?,?,?,?,?::jsonb)
                """, tenant, oldId, newId, old.siteId(), replacement.siteId(), Timestamp.from(at),
                actor.sub(), actor.name(), actor.rolle(), actor.art(), encode(counts));
        return new Ergebnis(oldId, newId, old.siteId(), at, Map.copyOf(counts));
    }

    private boolean exists(String sql, Object... args) { return Boolean.TRUE.equals(jdbc.queryForObject(sql, Boolean.class, args)); }
    private DeviceDto box(UUID id) { return devices.findById(id).orElseThrow(BoxTauschService::nichtGefunden); }
    private String encode(Object value) {
        try { return json.writeValueAsString(value); }
        catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }
    private static ResponseStatusException nichtGefunden() { return new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden"); }
    private static ResponseStatusException konflikt(String reason, String text) {
        return new BoxKonflikt(reason, text);
    }
}
