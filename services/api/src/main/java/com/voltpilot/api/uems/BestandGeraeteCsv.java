package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.TeilansichtDienst;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import java.sql.Date;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der Bestand-Geräte-CSV (AP-07 IP-14) unter dem Recht {@code export.standort} und mit seinen neun Kopfzeilen (UEMS AP-12
 * IP-10, E11 DA4, E12 G1) — die EINE sichtbare Bestandsänderung von AP-12: wer das Recht nicht hat (heute die
 * VoltPilot-Unterstützung, Plattform-Admin über den Mandanten-Umschalter), bekommt 403 statt der Datei. Wer es hat, bekommt
 * dieselben Spalten und Zeilen wie vorher.
 *
 * <p>Das Urteil spricht {@link RechteAbleitung#darf} über {@link BerichtRechte#MATRIX} — dieselbe Zeile wie am Berichts-CSV —,
 * der Aufrufer kommt aus {@link KennzahlAufrufer} (die EINE Naht für AP-03). Ziel ist der Standort der Anlage heute; eine
 * Anlage ohne Standort ist das Unternehmen, dann dürfen nur unternehmensweite Rollen. Die Standorte des Kundenbereichs sind
 * alle seine Standort-IDs, archivierte eingeschlossen: ein archivierter Standort nimmt niemandem den Export.
 *
 * <p>Die Kopfzeilen {@code standort} („ST-1 Werk Ahrenberg“) und {@code unternehmen} nennen, was zum Zeitpunkt der Erzeugung
 * gilt; ohne Standort-Objekt bleibt {@code standort} leer, ohne Unternehmen {@code unternehmen} — nie geraten.
 */
@Component
public class BestandGeraeteCsv {

    private record Ort(UUID id, String kurzzeichen, String name, String unternehmen) {}

    private final JdbcTemplate jdbc;
    private final KennzahlAufrufer aufrufer;
    private final Clock uhr;
    private final TeilansichtDienst teilansicht;

    @Autowired
    public BestandGeraeteCsv(JdbcTemplate jdbc, KennzahlAufrufer aufrufer, TeilansichtDienst teilansicht) {
        this(jdbc, aufrufer, teilansicht, Clock.systemUTC());
    }

    public BestandGeraeteCsv(JdbcTemplate jdbc, KennzahlAufrufer aufrufer, TeilansichtDienst teilansicht, Clock uhr) {
        this.jdbc = jdbc;
        this.aufrufer = aufrufer;
        this.uhr = uhr;
        this.teilansicht = teilansicht;
    }

    /**
     * Darf {@code wer} den Verlauf dieser Anlage exportieren? Ja → wer, wann und wo für die Kopfzeilen; nein → 403 mit dem
     * Satz der Rechte-Ableitung (außerhalb des Geltungsbereichs 404, wie ein fremdes Gerät). Die Sichtbarkeit von Gerät und
     * Anlage hat der Verlauf vorher schon geprüft.
     */
    public MeasurementHistoryService.Erzeugung erzeugung(ProtokollAkteur wer, UUID site) {
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant().truncatedTo(ChronoUnit.SECONDS);
        LocalDate heute = TagRegeln.tag(jetzt, ZoneId.of(TagRegeln.VORGABE_ZONE));
        Optional<Ort> ort = jdbc.query("""
                SELECT st.id, st.kurzzeichen, st.name, un.name AS unternehmen FROM anlage_standort a
                  JOIN standort st ON st.id = a.standort_id AND st.tenant_id = a.tenant_id
                  LEFT JOIN unternehmen un ON un.id = st.unternehmen_id AND un.tenant_id = st.tenant_id
                 WHERE a.tenant_id = ? AND a.site_id = ? AND a.aufgehoben_am IS NULL
                   AND a.gueltig_ab <= ? AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= ?)
                 ORDER BY a.gueltig_ab DESC LIMIT 1
                """, (rs, i) -> new Ort(rs.getObject("id", UUID.class), rs.getString("kurzzeichen"), rs.getString("name"),
                rs.getString("unternehmen")), tenant, site, Date.valueOf(heute), Date.valueOf(heute)).stream().findFirst();

        List<RechteAbleitung.Standort> standorte = jdbc.query("SELECT id, name FROM standort WHERE tenant_id = ? "
                + "ORDER BY name, id", (rs, i) -> new RechteAbleitung.Standort(rs.getString("id"), rs.getString("name")), tenant);
        var benutzer = aufrufer.benutzer(wer);
        var kundenbereich = new Kundenbereich("Kundenbereich", standorte, List.of());
        Geltungsbereich.requireScope(benutzer, kundenbereich,
                ort.isPresent() ? BerichtRechte.EXPORT_STANDORT : BerichtRechte.EXPORT_UNTERNEHMEN,
                ort.map(o -> o.id().toString()).orElse(null), jetzt);
        String unternehmen = ort.map(Ort::unternehmen).orElseGet(() -> jdbc.query("SELECT name FROM unternehmen "
                + "WHERE tenant_id = ? ORDER BY created_at, id LIMIT 1", (rs, i) -> rs.getString(1), tenant)
                .stream().findFirst().orElse(null));
        return new MeasurementHistoryService.Erzeugung(jetzt, wer.name(),
                ort.map(o -> o.kurzzeichen() + " " + o.name()).orElse(null), unternehmen,
                teilansicht.exportKopf(benutzer, kundenbereich, jetzt));
    }
}
