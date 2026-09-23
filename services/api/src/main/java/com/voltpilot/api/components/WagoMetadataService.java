package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular;
import com.voltpilot.api.uems.MessreiheEreignisRepository;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Dokumentierte Kartenfakten. Wandler/Skalierung nutzt weiter QuelleEinstellungService. */
@Service
public class WagoMetadataService {
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * {@code kartenwechsel} ist der Zeitpunkt der JÜNGSTEN gespeicherten Gerätegrenze mit Anlass
     * {@code kartenwechsel} an dieser Komponente — ein Beleg, keine Vermutung. Er trägt zusammen
     * mit einer FEHLENDEN {@code anwenderskalierung} den Hebel „Wandler/Anwenderskalierung
     * prüfen“ im Portal; ohne Wechsel gibt es keinen Hebel (kein Dauerhinweis).
     */
    /**
     * {@code variante}/{@code controllerKennung}: das aus der Steuerung GELESENE Soll der Karte und
     * ihres Controllers ({@link WagoSollLesung}) — {@code null} = noch nicht gelesen, nie 0.
     */
    public record Karte(Integer slot, Boolean anwenderskalierung, Integer register35, int version,
            Instant kartenwechsel, Integer variante, Long controllerKennung) {}
    public record KartenEintrag(@NotNull @Positive Integer expectedRevision,
            Boolean anwenderskalierung, @Min(0) @Max(65535) Integer register35) {}

    /**
     * Der Dialog „Karte getauscht“ (AP-05 E6): ein Zeitpunkt, wahlweise der Endstand der alten
     * Karte, und die Prüfaufgabe für die Einstellungen der NEUEN Karte. Kein Gerätewechsel —
     * Gerät, Komponente und Messstelle bleiben.
     */
    public record Kartenwechsel(@NotNull Instant zeitpunkt,
            @DecimalMin("0") BigDecimal endstand, @Size(max = 32) String einheit,
            boolean einstellungenPruefen) {}
    /** {@code controllerKennung}/{@code karten}: das gelesene Soll ({@link WagoSollLesung}), nur lesend. */
    public record Geraet(String seriennummer, String firmware, String anwendung, Long controllerKennung,
            List<WagoSollLesung.SollKarte> karten) {}
    public record GeraetEintrag(@Size(max = 200) String seriennummer,
            @Size(max = 200) String firmware, @Size(max = 200) String anwendung) {}
    private final JdbcTemplate jdbc;
    private final ComponentDefinitionRepository definitions;
    private final ComponentActivationOutboxService activation;
    private final MessreiheEreignisRepository ereignisse;
    private final WagoSollLesung soll;

    public WagoMetadataService(JdbcTemplate jdbc, ComponentDefinitionRepository definitions,
            ComponentActivationOutboxService activation, MessreiheEreignisRepository ereignisse,
            WagoSollLesung soll) {
        this.jdbc = jdbc;
        this.definitions = definitions;
        this.activation = activation;
        this.ereignisse = ereignisse;
        this.soll = soll;
    }

    public Karte karte(UUID site, UUID entity) {
        return jdbc.query("SELECT m.slot, m.wago_anwenderskalierung, m.wago_register_35, "
                + "m.definition_version, (SELECT max(e.zeit) FROM messreihe_ereignis e "
                + "WHERE e.tenant_id=m.tenant_id AND e.entity_id=m.id AND NOT e.aus_bestand "
                + "AND e.art='device_boundary' AND e.nutzlast->>'anlass'='kartenwechsel') wechsel, "
                + "t.variante, g.controller_kennung "
                + "FROM measurement_point m JOIN site s ON s.id=m.site_id "
                // Die HEUTE zugeordnete Karte (höchstens eine je Komponente, E4) und ihr Controller.
                + "LEFT JOIN geraet_komponente k ON k.entity_id=m.id AND k.tenant_id=m.tenant_id "
                + "AND k.gueltig_ab<=now() AND (k.gueltig_bis IS NULL OR k.gueltig_bis>now()) "
                + "LEFT JOIN geraet_teil t ON t.id=k.teil_id AND t.tenant_id=k.tenant_id "
                + "LEFT JOIN geraet g ON g.id=k.geraet_id AND g.tenant_id=k.tenant_id "
                + "WHERE m.site_id=? AND m.id=? AND lower(m.brand)='wago'",
                (rs, n) -> new Karte((Integer) rs.getObject(1), (Boolean) rs.getObject(2),
                        (Integer) rs.getObject(3), rs.getInt(4),
                        rs.getTimestamp(5) == null ? null : rs.getTimestamp(5).toInstant(),
                        (Integer) rs.getObject(6), (Long) rs.getObject(7)),
                site, entity).stream()
                .findFirst().orElseThrow(WagoMetadataService::nichtGefunden);
    }

    @Transactional
    public Karte eintragen(UUID site, UUID entity, KartenEintrag in, String actor) {
        karte(site, entity); // Sichtbarkeit vor fachlichen Fehlern, fremde Anlage = 404.
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(site))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Komponenten dieser Anlage werden noch auf der Box verwaltet.");
        }
        // E4: Der Steckplatz kommt aus der ausdrücklichen Geräte-/Kartenzuordnung.
        // Eine Modbus-Adresse oder gleiche Verbindung erzeugt keine physische Identität.
        List<Integer> slots = jdbc.query("SELECT t.steckplatz FROM geraet_komponente k "
                + "JOIN geraet_teil t ON t.id=k.teil_id AND t.tenant_id=k.tenant_id "
                + "JOIN measurement_point m ON m.id=k.entity_id JOIN site s ON s.id=m.site_id "
                + "WHERE m.id=? AND m.site_id=? AND k.gueltig_ab<=now() "
                + "AND (k.gueltig_bis IS NULL OR k.gueltig_bis>now()) FOR UPDATE OF m, k, t",
                (rs, n) -> (Integer) rs.getObject(1), entity, site);
        if (slots.size() != 1 || slots.getFirst() == null
                || slots.getFirst() < 1 || slots.getFirst() > 65535) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Zuerst die Energiekarte mit ihrem Steckplatz zuordnen.");
        }
        int changed = jdbc.update("UPDATE measurement_point SET slot=?, wago_anwenderskalierung=?, "
                + "wago_register_35=?, definition_version=definition_version+1 "
                + "WHERE id=? AND site_id=? AND definition_version=?", slots.getFirst(),
                in.anwenderskalierung(), in.register35(), entity, site, in.expectedRevision());
        if (changed != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Komponente hat inzwischen eine andere Fassung.");
        }
        definitions.recordStoredVersion(TenantContext.get(), site, entity, in.expectedRevision() + 1,
                actor, "WAGO-Kartenangaben dokumentiert");
        // Die vorhandene Revision bleibt mit der Registry synchron. Keine neuen
        // Kartenfelder gehen an die Box; die Verbindung bleibt unverändert.
        activation.enqueue(TenantContext.get(), site, entity, in.expectedRevision() + 1, "component_edit");
        return karte(site, entity);
    }

    /**
     * „Karte getauscht“ (AP-05 E6, Abnahme A10): eine GERÄTEGRENZE OHNE GERÄTEWECHSEL. Das Gerät,
     * die Komponente und die Messstelle bleiben; nichts wird gelöscht, die Geschichte der alten
     * Karte bleibt vollständig lesbar. Der Zählerstand-Bruch an dieser Grenze ist danach KEIN
     * fiktiver Verbrauch — das erledigt der bestehende Verbrauchs-Leser, der jede
     * {@code device_boundary} an der Komponente als Bruch kennt ({@code ViertelstundenTeile}).
     *
     * <p>Zwei Wirkungen, in einer Transaktion:
     * <ol>
     *   <li><b>Prüfaufgabe.</b> Ist sie angehakt, verliert die Komponente ihre dokumentierten
     *       Kartenangaben ({@code anwenderskalierung}, {@code register35}) — die neue Karte ist
     *       eine andere Karte, und was für die alte erhoben war, gilt für sie nicht. Nichts wird
     *       behauptet, nichts auf einen Ersatzwert gesetzt; es ist wieder offen. Genau diese
     *       Lücke NEBEN dem gespeicherten Wechsel trägt im Portal den Hebel
     *       „Wandler/Anwenderskalierung prüfen“.
     *   <li><b>Beleg.</b> Die Gerätegrenze selbst, mit demselben Einbau auf beiden Seiten
     *       (Vertragsregel für {@code kartenwechsel}) und wahlweise dem Endstand der alten Karte.
     * </ol>
     */
    @Transactional
    public Karte kartenwechsel(UUID site, UUID entity, Kartenwechsel in, String actor) {
        Karte vorher = karte(site, entity); // Sichtbarkeit vor fachlichen Fehlern, fremde Anlage = 404.
        // Auf die SEKUNDE: der Ereignis-Vertrag schreibt `YYYY-MM-DDTHH:MM:SSZ` vor. Ein
        // `Instant.now()` mit Millisekunden fällt als `schema_verletzt` durch.
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Instant zeitpunkt = in.zeitpunkt().truncatedTo(ChronoUnit.MINUTES);
        if (zeitpunkt.isAfter(jetzt)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ein Kartenwechsel wird nicht im Voraus eingetragen.");
        }
        if ((in.endstand() == null) != (text(in.einheit()) == null)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ein Endstand braucht seine Einheit; ohne Endstand bleibt auch die Einheit leer.");
        }
        String einbau = einbau(site, entity, zeitpunkt);
        if (einbau == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Zu diesem Zeitpunkt ist der Komponente kein Gerät zugeordnet.");
        }
        if (in.einstellungenPruefen()) {
            eintragen(site, entity, new KartenEintrag(vorher.version(), null, null), actor);
        }
        ObjectNode e = JSON.createObjectNode()
                .put("ereignis_id", UUID.randomUUID().toString())
                .put("art", "device_boundary")
                .put("zeitpunkt", zeitpunkt.toString())
                .put("komponente", entity.toString())
                .put("anlass", "kartenwechsel")
                // E6: derselbe Einbau auf beiden Seiten — die Karte wechselt, das Gerät nicht.
                .put("einbau_alt", einbau)
                .put("einbau_neu", einbau)
                .put("eingetragen_am", jetzt.toString());
        if (in.endstand() != null) {
            e.put("endstand", in.endstand()).put("einheit", text(in.einheit()));
        }
        MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(TenantContext.get(), site,
                EreignisVokabular.Urheber.KUNDE, e, null, jetzt);
        if (r.ausgang() == MessreiheEreignisRepository.Ausgang.VERWORFEN) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Der Kartenwechsel konnte nicht vermerkt werden: " + r.grund());
        }
        return karte(site, entity);
    }

    /** Der Einbau, der die Komponente zum Zeitpunkt speist — die Zeitgültigkeit, nie „heute“. */
    private String einbau(UUID site, UUID entity, Instant zeitpunkt) {
        return jdbc.query("SELECT g.einbau_kennzeichen FROM geraet_komponente k "
                + "JOIN geraet g ON g.id=k.geraet_id AND g.tenant_id=k.tenant_id "
                + "JOIN measurement_point m ON m.id=k.entity_id "
                + "WHERE k.entity_id=? AND m.site_id=? AND k.gueltig_ab<=? "
                + "AND (k.gueltig_bis IS NULL OR k.gueltig_bis>?) ORDER BY k.gueltig_ab DESC",
                (rs, n) -> rs.getString(1), entity, site,
                java.sql.Timestamp.from(zeitpunkt), java.sql.Timestamp.from(zeitpunkt))
                .stream().findFirst().orElse(null);
    }

    public Geraet geraet(UUID id) {
        return jdbc.query("SELECT g.seriennummer, g.firmware, g.anwendung FROM geraet g "
                + "JOIN site s ON s.id=g.site_id WHERE g.id=? AND lower(g.hersteller)='wago'",
                (rs, n) -> new Geraet(rs.getString(1), rs.getString(2), rs.getString(3), null, null), id)
                .stream().findFirst()
                .map(g -> {
                    WagoSollLesung.Soll s = soll.soll(id);
                    return new Geraet(g.seriennummer(), g.firmware(), g.anwendung(), s.controllerKennung(),
                            s.karten());
                })
                .orElseThrow(WagoMetadataService::nichtGefunden);
    }

    @Transactional
    public Geraet eintragen(UUID id, GeraetEintrag in) {
        geraet(id);
        jdbc.update("UPDATE geraet SET seriennummer=?, firmware=?, anwendung=? WHERE id=?",
                text(in.seriennummer()), text(in.firmware()), text(in.anwendung()), id);
        return geraet(id);
    }

    private static String text(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
    private static ResponseStatusException nichtGefunden() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "WAGO-Gerät oder Komponente nicht gefunden.");
    }
}
