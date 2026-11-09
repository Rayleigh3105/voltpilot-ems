package com.voltpilot.api.entities;

import com.voltpilot.api.components.ComponentDefinitionRepository;
import com.voltpilot.api.entities.WechselrichterUntergrenze.Ergebnis;
import com.voltpilot.api.entities.WechselrichterUntergrenze.Lesung;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Übernimmt die am Wechselrichter eingestellte Entladegrenze je Anlage ({@link WechselrichterUntergrenze}).
 *
 * <p>Je Anlage mit GENAU EINER Speicher-Komponente, die ein Deye-Hybrid (1P/3P) an einer eingebauten Box ist:
 * <ol>
 *   <li>legt den Messpunkt „Battery Low SOC“ in den Messplan der Box (Takt des Katalogs, 300 s), einmal - eine
 *       Abwahl von Hand bleibt stehen ({@link MeasurementSelectionService#punktErgaenzen});</li>
 *   <li>gleicht die jüngsten Lesungen der Box mit dem übernommenen Stand ab und schreibt ihn;</li>
 *   <li>bei einem geänderten Wert: ein Eintrag im Änderungsprotokoll der Komponente
 *       ({@code component_change_event}, Typ {@code wr_untergrenze_gelesen}) und die Schutzgrenze der Box wird
 *       nachgezogen ({@link EntityRegistryService#untergrenzeNachziehen}).</li>
 * </ol>
 * Den Plan erreicht ein neuer Wert mit dem nächsten 15-Minuten-Lauf: der Optimierer liest die Tabelle selbst.
 * VoltPilot schreibt diesen Wert nie an den Wechselrichter. Andere Hersteller: noch nicht (Folgeauftrag).
 */
@Service
public class WechselrichterUntergrenzeAbgleich {

    private static final Logger log = LoggerFactory.getLogger(WechselrichterUntergrenzeAbgleich.class);

    /** Wie weit der Abgleich in die gespeicherten Lesungen zurückschaut, und wie viele er höchstens liest. */
    static final Duration RUECKBLICK = Duration.ofDays(2);
    static final int LESUNGEN = 12;

    /** Eine Anlage, deren Entladegrenze am Wechselrichter gelesen wird. */
    public record Kandidat(UUID tenantId, UUID siteId, UUID entityId, UUID deviceId, String familie) {}

    private final JdbcTemplate adminJdbc;
    private final WechselrichterUntergrenzeRepository untergrenzen;
    private final EntityRegistryRepository registry;
    private final EntityRegistryService registryService;
    private final MeasurementSelectionService selections;
    private final ComponentDefinitionRepository komponenten;

    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public WechselrichterUntergrenzeAbgleich(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            WechselrichterUntergrenzeRepository untergrenzen, EntityRegistryRepository registry,
            EntityRegistryService registryService, MeasurementSelectionService selections,
            ComponentDefinitionRepository komponenten) {
        this.adminJdbc = adminJdbc;
        this.untergrenzen = untergrenzen;
        this.registry = registry;
        this.registryService = registryService;
        this.selections = selections;
        this.komponenten = komponenten;
    }

    /** Ein Lauf über alle Anlagen. Wirft nie: eine Anlage, die scheitert, hält die übrigen nicht auf. */
    public void lauf(Instant jetzt) {
        for (Kandidat k : kandidaten()) {
            if (beendete.beendet(k.tenantId())) {
                continue;
            }
            TenantContext.set(k.tenantId());
            try {
                abgleichen(k, jetzt);
            } catch (RuntimeException e) {
                log.warn("Entladegrenze des Wechselrichters nicht abgeglichen: site={} {}", k.siteId(), e.toString());
            } finally {
                TenantContext.clear();
            }
        }
    }

    /** Alle Anlagen mit genau einer Speicher-Komponente, die ein Deye-Hybrid an einer eingebauten Box ist. */
    public List<Kandidat> kandidaten() {
        return adminJdbc.query("""
                SELECT b.tenant_id, b.site_id, b.id, b.device_id, b.family
                  FROM measurement_point b
                  JOIN device d ON d.id = b.device_id AND d.ausgebaut_am IS NULL
                 WHERE b.entity_type = 'battery-hybrid'
                   AND lower(b.brand) = 'deye'
                   AND b.family IN ('hybrid_1p', 'hybrid_3p')
                   AND (SELECT count(*) FROM measurement_point o
                         WHERE o.site_id = b.site_id AND o.entity_type = 'battery-hybrid') = 1
                 ORDER BY b.site_id
                """, (rs, n) -> new Kandidat(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                rs.getObject(3, UUID.class), rs.getObject(4, UUID.class), rs.getString(5)));
    }

    /** Eine Anlage, unter ihrem gesetzten Mandanten. */
    public Ergebnis abgleichen(Kandidat k, Instant jetzt) {
        String punkt = WechselrichterUntergrenze.PUNKT_JE_FAMILIE.get(k.familie());
        if (punkt == null) {
            return null;
        }
        selections.punktErgaenzen(k.deviceId(), k.entityId(), punkt, MeasurementSelectionService.UNTERGRENZE_AKTEUR);

        WechselrichterUntergrenzeRepository.Eintrag alt = untergrenzen.eintrag(k.siteId());
        List<Lesung> lesungen = untergrenzen.juengsteLesungen(k.tenantId(), k.deviceId(), k.entityId(), punkt,
                jetzt.minus(RUECKBLICK), LESUNGEN);
        if (lesungen.isEmpty()) {
            return null; // nichts Neues - der letzte Stand gilt mit seinem Zeitpunkt weiter
        }
        EntityRegistryRepository.BatteryAsset speicher = registry.batteryAsset(k.siteId());
        BigDecimal obergrenze = speicher == null ? null : speicher.socMaxPct();
        Ergebnis e = WechselrichterUntergrenze.abgleichen(alt == null ? null : alt.stand(), lesungen, obergrenze,
                jetzt);
        if (e.stand() == null) {
            return e; // nie etwas übernommen: keine Zeile, alles bleibt wie vorher
        }
        if (alt != null && alt.stand().equals(e.stand()) && Objects.equals(alt.entityId(), k.entityId())
                && Objects.equals(alt.deviceId(), k.deviceId())
                && Objects.equals(alt.letzteLesungAm(), e.juengste() == null ? null : e.juengste().zeit())
                && Objects.equals(alt.letzteLesungVerworfen(), e.verworfen())) {
            return e; // unverändert - kein Schreiben je Takt
        }
        untergrenzen.speichern(k.tenantId(), k.siteId(), k.entityId(), k.deviceId(), punkt, e.stand(), e.juengste(),
                e.verworfen());
        if (e.wertGeaendert()) {
            Integer revision = komponenten.definitionVersion(k.siteId(), k.entityId());
            komponenten.recordEvent(k.tenantId(), k.siteId(), k.entityId(),
                    revision == null || revision < 1 ? 1 : revision, "wr_untergrenze_gelesen", e.stand().seit(),
                    e.vorher() == null ? null : e.vorher().stripTrailingZeros().toPlainString(),
                    e.stand().socMinPct().stripTrailingZeros().toPlainString(),
                    MeasurementSelectionService.UNTERGRENZE_AKTEUR,
                    "Entladegrenze am Wechselrichter gelesen (" + punkt + ")");
            registryService.untergrenzeNachziehen(k.siteId());
        }
        return e;
    }
}
