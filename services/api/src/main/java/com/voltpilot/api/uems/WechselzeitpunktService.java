package com.voltpilot.api.uems;

import com.voltpilot.api.components.ComponentDefinitionRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ZaehlerwechselDto;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** A3: Berichtigung der angekündigten Grenze, ohne eine Historie zu löschen. */
@Service
public class WechselzeitpunktService {
    private final JdbcTemplate jdbc;
    private final GeraetRepository geraete;
    private final ComponentDefinitionRepository definitionen;
    private final TransactionTemplate tx;
    private Clock uhr = Clock.systemUTC();
    private Runnable letzterSchritt = () -> { };

    public WechselzeitpunktService(JdbcTemplate jdbc, GeraetRepository geraete,
            ComponentDefinitionRepository definitionen, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.geraete = geraete;
        this.definitionen = definitionen;
        this.tx = new TransactionTemplate(manager);
    }

    void uhrStellen(Clock clock) { uhr = clock; }
    void letzterSchritt(Runnable schritt) { letzterSchritt = schritt; }

    public ZaehlerwechselDto.Berichtigt berichtigen(UUID id, ZaehlerwechselDto.Berichtigung b, ProtokollAkteur wer) {
        try {
            return tx.execute(status -> {
                if (!geraete.sperre(id)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
                var alt = geraete.eines(id).orElseThrow();
                if (b == null || b.zeitpunkt() == null || b.bisher() == null
                        || !b.zeitpunkt().toInstant().equals(b.zeitpunkt().toInstant().truncatedTo(ChronoUnit.MINUTES)))
                    throw MessstelleAbgelehnt.anfrage("zeitpunkt", "Geben Sie den bisherigen und den neuen Zeitpunkt auf die Minute an.");
                Instant vorher = alt.ausgebautAm(), nachher = b.zeitpunkt().toInstant();
                if (vorher == null || !vorher.equals(b.bisher().toInstant()))
                    throw konflikt("wechsel_veraendert", "Der angekündigte Wechsel hat sich geändert. Laden Sie die Angaben erneut.");
                if (!vorher.isAfter(uhr.instant()) || !nachher.isAfter(uhr.instant()))
                    throw konflikt("wechsel_bereits_wirksam", "Ein wirksamer Wechsel kann hier nicht berichtigt werden. Nutzen Sie den Korrekturweg.");
                if (vorher.equals(nachher)) throw MessstelleAbgelehnt.anfrage("zeitpunkt", "Der Zeitpunkt ist unverändert.");
                UUID neuId = jdbc.queryForObject("SELECT uems_wechsel_partner(?, false)", UUID.class, id);
                if (neuId == null || !geraete.sperre(neuId))
                    throw konflikt("kein_angekuendigter_wechsel", "Es gibt keinen angekündigten Wechsel zu diesem Gerät.");
                var neu = geraete.eines(neuId).orElseThrow();
                if (!vorher.equals(neu.eingebautAm()) || neu.ausgebautAm() != null)
                    throw konflikt("wechsel_veraendert", "Der Nachfolger wurde bereits verändert. Laden Sie die Angaben erneut.");
                List<UUID> komponenten = jdbc.queryForList(
                        "SELECT entity_id FROM geraet_komponente WHERE geraet_id=? AND gueltig_ab=? FOR UPDATE",
                        UUID.class, neuId, ts(vorher));
                // Verhindert zwischen Prüfung und Commit eintreffende Messwerte.
                jdbc.execute("LOCK TABLE device_measurement_sample, telemetry_v2 IN SHARE MODE");
                for (UUID entity : komponenten) {
                    Instant von = vorher.isBefore(nachher) ? vorher : nachher;
                    Instant bis = vorher.isBefore(nachher) ? nachher : vorher;
                    Boolean werte = jdbc.queryForObject("""
                        SELECT EXISTS (SELECT 1 FROM device_measurement_sample m JOIN site s ON s.id=m.site_id AND s.tenant_id=m.tenant_id
                          WHERE m.site_id=? AND (m.entity_id=? OR m.entity_id IS NULL) AND m.time>=? AND m.time<?)
                        OR EXISTS (SELECT 1 FROM telemetry_v2 m JOIN site s ON s.id=m.site_id AND s.tenant_id=m.tenant_id
                          WHERE m.site_id=? AND m.entity_id=? AND m.time>=? AND m.time<?)
                        """, Boolean.class, alt.siteId(), entity, ts(von), ts(bis), alt.siteId(), entity.toString(), ts(von), ts(bis));
                    if (Boolean.TRUE.equals(werte))
                        throw konflikt("messwerte_im_zeitraum", "Zwischen den Zeitpunkten liegen Messwerte. Nutzen Sie den Korrekturweg.");
                }
                // Die verkürzende Hälfte zuerst, damit die nicht aufschiebbaren Exklusionen halten.
                if (nachher.isAfter(vorher)) {
                    anfang(neuId, vorher, nachher);
                    ende(id, vorher, nachher);
                } else {
                    ende(id, vorher, nachher);
                    anfang(neuId, vorher, nachher);
                }
                var format = java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm").withZone(MessstelleService.ZEITZONE);
                String satz = "Zeitpunkt berichtigt: " + format.format(vorher) + " → " + format.format(nachher);
                jdbc.update("""
                    INSERT INTO messstelle_aenderung
                      (tenant_id,messstelle_id,art,alt,neu,gilt_ab,rueckwirkend,grund,actor_sub,actor_name,actor_rolle,actor_art)
                    SELECT DISTINCT tenant_id,messstelle_id,'zaehler_gewechselt',
                      jsonb_build_object('zeitpunkt',?::text),
                      jsonb_build_object('anlass','zeitpunkt_berichtigt','vorgaenger',?::text,'einbau',?::text,
                        'zeitpunkt',?::text,'bisher',?::text,'satz',?::text),
                      ?::timestamptz,false,?,?,?,?,?
                    FROM messstelle_quelle WHERE geraet_id=? AND gueltig_ab=?
                    """, vorher.toString(), alt.einbauKennzeichen(), neu.einbauKennzeichen(), nachher.toString(),
                    vorher.toString(), satz, ts(nachher), b.grund(), wer.sub(), wer.name(), wer.rolle(), wer.art(), neuId, ts(nachher));
                for (UUID entity : komponenten) {
                    Integer revision = definitionen.definitionVersion(alt.siteId(), entity);
                    definitionen.recordEvent(TenantContext.get(), alt.siteId(), entity, revision == null ? 1 : revision,
                            "edited", nachher, vorher.toString(), nachher.toString(), wer.sub(),
                            satz + " (" + alt.einbauKennzeichen() + " → " + neu.einbauKennzeichen() + ")");
                }
                jdbc.execute("SET CONSTRAINTS uems_wechsel_grenze_konsistent IMMEDIATE");
                letzterSchritt.run();
                return new ZaehlerwechselDto.Berichtigt(id, neuId, vorher.atOffset(ZoneOffset.UTC),
                        nachher.atOffset(ZoneOffset.UTC), satz);
            });
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            throw konflikt("zeitachsen_veraendert", "Der Zeitpunkt passt nicht mehr zu den Zeiträumen. Laden Sie die Angaben erneut.");
        }
    }

    private void anfang(UUID id, Instant alt, Instant neu) {
        jdbc.update("UPDATE geraet_teil SET eingebaut_am=? WHERE geraet_id=? AND eingebaut_am=?", ts(neu), id, ts(alt));
        for (String t : List.of("geraet_komponente", "messstelle_quelle", "quelle_einstellung"))
            jdbc.update("UPDATE " + t + " SET gueltig_ab=? WHERE geraet_id=? AND gueltig_ab=?", ts(neu), id, ts(alt));
        jdbc.update("UPDATE geraet SET eingebaut_am=? WHERE id=? AND eingebaut_am=?", ts(neu), id, ts(alt));
    }

    private void ende(UUID id, Instant alt, Instant neu) {
        jdbc.update("UPDATE geraet_teil SET ausgebaut_am=? WHERE geraet_id=? AND ausgebaut_am=?", ts(neu), id, ts(alt));
        for (String t : List.of("geraet_komponente", "messstelle_quelle"))
            jdbc.update("UPDATE " + t + " SET gueltig_bis=? WHERE geraet_id=? AND gueltig_bis=?", ts(neu), id, ts(alt));
        jdbc.update("UPDATE geraet SET ausgebaut_am=? WHERE id=? AND ausgebaut_am=?", ts(neu), id, ts(alt));
    }

    private static Timestamp ts(Instant t) { return Timestamp.from(t); }
    private static MessstelleAbgelehnt konflikt(String grund, String satz) {
        return MessstelleAbgelehnt.schnittstelle(MessstelleAbgelehnt.Schnittstelle.ZUSTAND_PASST_NICHT,
                satz, Map.of("grund", grund, "satz", satz));
    }
}
