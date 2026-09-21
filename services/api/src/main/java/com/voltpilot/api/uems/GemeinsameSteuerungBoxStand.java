package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.GemeinsameSteuerungHerzschlag;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.DokumentZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Stand;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der Stand je Box der Gemeinsamen Steuerung (UEMS AP-15 IP-24, §5.3/§5.4): Rolle, Fähigkeit, Messpunkt und sein
 * Alter, Wächter-Stufe je Richtung, {@code plan_id} veröffentlicht/angenommen, Anteils-Revision gesendet/quittiert und
 * die WIRKSAMEN Anteile, dazu der Zweischritt und die Sprungprobe-Protokolle. EINE Ableitung — das Betreiber-Blatt
 * liest sie heute über {@code GET /api/v1/admin/…/gemeinsame-steuerung}; die Kundenroute kann sie später mitbenutzen
 * (IP-23 fand dort keine wirksamen Anteile und keine Erreichbarkeit je Mitglied).
 *
 * <p>Unbekannt ist nie eine Null: ohne Herzschlag-Block (alte Box, oder seit dem Start der api noch keiner) sind
 * {@code waechter} und {@code wirksam_kw} leer, ohne Meldung der Box ist der Messpunkt {@code nicht_gemeldet}. Liest
 * auf dem RLS-Pfad — eine fremde Anlage ist 404.
 */
@Service
public class GemeinsameSteuerungBoxStand {

    public static final String NICHT_GEMELDET = "nicht_gemeldet";

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository anteile;
    private final PlanZustellungRepository plaene;
    private final DeviceDataSourceStatusRepository quellen;
    private final BoxFaehigkeiten faehigkeiten;
    private final WirksameAnteileQuelle wirksam;
    private final SprungprobeDienst sprungproben;
    private final ObjectProvider<GemeinsameSteuerungHerzschlag> herzschlag;
    private final JdbcTemplate jdbc;
    private Clock uhr = Clock.systemUTC();

    public GemeinsameSteuerungBoxStand(SteuerungsverbundRepository verbuende, SteuerungsverbundAnteilRepository anteile,
            PlanZustellungRepository plaene, DeviceDataSourceStatusRepository quellen, BoxFaehigkeiten faehigkeiten,
            WirksameAnteileQuelle wirksam, SprungprobeDienst sprungproben,
            ObjectProvider<GemeinsameSteuerungHerzschlag> herzschlag, JdbcTemplate jdbc) {
        this.verbuende = verbuende;
        this.anteile = anteile;
        this.plaene = plaene;
        this.quellen = quellen;
        this.faehigkeiten = faehigkeiten;
        this.wirksam = wirksam;
        this.sprungproben = sprungproben;
        this.herzschlag = herzschlag;
        this.jdbc = jdbc;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    /** Das Blatt der Anlage; ohne Gemeinsame Steuerung leer (I6), eine fremde Anlage 404. */
    @Transactional(readOnly = true)
    public GemeinsameSteuerungDto.Betreiberblatt blatt(UUID siteId) {
        if (!verbuende.anlageSichtbar(siteId)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
        Optional<VerbundZeile> v = verbuende.derAnlage(siteId);
        if (v.isEmpty()) {
            return new GemeinsameSteuerungDto.Betreiberblatt(List.of(), null, List.of());
        }
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(v.get().id(), uhr.instant());
        GemeinsameSteuerungHerzschlag bloecke = herzschlag.getIfAvailable();
        List<GemeinsameSteuerungDto.BoxStand> boxen = new ArrayList<>();
        for (MitgliedZeile m : mitglieder) {
            boxen.add(box(siteId, m, bloecke));
        }
        return new GemeinsameSteuerungDto.Betreiberblatt(List.copyOf(boxen), zweischritt(v.get(), mitglieder),
                sprungproben.protokoll(v.get().id(), mitglieder));
    }

    /**
     * Für die Kundenroute ({@code GET …/gemeinsame-steuerung}, IP-23-Folge): je Mitglied die WIRKSAMEN Anteile und
     * wann die Box zuletzt gehört wurde — ohne Betreiber-Interna (keine Wächter-Stufe, keine {@code plan_id}, keine
     * Revision). Wirksam ist, was der Box zugestellt UND von ihr quittiert ist: der Stand ihres jüngsten quittierten
     * Anteils-Dokuments (im Übergangsstand also der Übergangswert). Das ist die gespeicherte Wahrheit, nicht der
     * flüchtige Herzschlag — sie übersteht einen Neustart der api. Nichts quittiert: {@code anteile} leer, nie 0.
     */
    public Map<UUID, Kunde> fuerKunden(UUID verbundId, List<MitgliedZeile> mitglieder) {
        Map<Stand, DokumentZeile> jeStand = new HashMap<>();
        if (mitglieder.stream().anyMatch(m -> m.quittiertEpoche() != null)) {
            anteile.dokumente(verbundId).forEach(d -> jeStand.put(d.stand(), d));
        }
        Map<UUID, Kunde> je = new LinkedHashMap<>();
        for (MitgliedZeile m : mitglieder) {
            GemeinsameSteuerungDto.WirksameAnteile wirksamKw = null;
            if (m.quittiertEpoche() != null && m.quittiertRevision() != null) {
                DokumentZeile d = jeStand.get(new Stand(m.quittiertEpoche(), m.quittiertRevision()));
                if (d != null) {
                    String box = m.deviceId().toString();
                    BigDecimal ein = d.tabelle().anteile().getOrDefault(Grenzart.EINSPEISUNG, Map.of()).get(box);
                    BigDecimal bez = d.tabelle().anteile().getOrDefault(Grenzart.BEZUG, Map.of()).get(box);
                    if (ein != null || bez != null) {
                        wirksamKw = new GemeinsameSteuerungDto.WirksameAnteile(ein, bez);
                    }
                }
            }
            je.put(m.deviceId(), new Kunde(wirksamKw, zuletztGesehen(m.deviceId())));
        }
        return je;
    }

    /** Was die Kundenroute je Mitglied aus diesem Dienst liest. */
    public record Kunde(GemeinsameSteuerungDto.WirksameAnteile wirksameAnteile, OffsetDateTime zuletztGehoert) {}

    private GemeinsameSteuerungDto.BoxStand box(UUID siteId, MitgliedZeile m, GemeinsameSteuerungHerzschlag bloecke) {
        UUID box = m.deviceId();
        GemeinsameSteuerungDto.Faehigkeit faehigkeit = new GemeinsameSteuerungDto.Faehigkeit(
                faehigkeiten.herkunft(box, SteuerungsverbundNachweise.FAEHIGKEIT),
                faehigkeiten.herkunft(box, SprungprobeRegel.FAEHIGKEIT));
        GemeinsameSteuerungDto.Messpunkt messpunkt = null;
        if (m.dataSourceId() != null) {
            DeviceDataSourceStatusRepository.Status s = quellen.find(box, m.dataSourceId());
            messpunkt = new GemeinsameSteuerungDto.Messpunkt(m.dataSourceId(), s == null ? NICHT_GEMELDET : s.health(),
                    s == null ? null : utc(s.readAt()));
        }
        GemeinsameSteuerungHerzschlag.Block block = bloecke == null ? null : bloecke.block(box);
        GemeinsameSteuerungDto.Waechter waechter = block == null ? null
                : new GemeinsameSteuerungDto.Waechter(block.waechter().get(Grenzart.EINSPEISUNG.code()),
                        block.waechter().get(Grenzart.BEZUG.code()));
        PlanZustellungRepository.Stand plan = plaene.stand(box);
        Map<String, BigDecimal> wirksamKw = wirksam.wirksam(siteId, box).map(a -> {
            Map<String, BigDecimal> kw = new LinkedHashMap<>();
            a.forEach((r, w) -> kw.put(r.code(), w));
            return Map.copyOf(kw);
        }).orElse(null);
        return new GemeinsameSteuerungDto.BoxStand(box, m.rolle().code(), zuletztGesehen(box), faehigkeit, messpunkt,
                waechter, new GemeinsameSteuerungDto.PlanStand(plan(plan.veroeffentlicht(), true),
                        plan(plan.angenommen(), false)),
                new GemeinsameSteuerungDto.AnteilStand(
                        revision(m.gesendetEpoche(), m.gesendetRevision(), m.gesendetAm()),
                        revision(m.quittiertEpoche(), m.quittiertRevision(), m.quittiertAm()), wirksamKw));
    }

    /**
     * Das jüngste Anteils-Dokument: wer seinen Stand quittiert hat und auf wen gewartet wird. Der Zielstand wird nie
     * vorweggenommen — {@code schritt = uebergang}, solange die api ihn nicht veröffentlicht hat.
     */
    private GemeinsameSteuerungDto.Zweischritt zweischritt(VerbundZeile v, List<MitgliedZeile> mitglieder) {
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty()) {
            return null;
        }
        DokumentZeile d = dokumente.get(0);
        Map<UUID, Stand> quittiert = new HashMap<>();
        for (MitgliedZeile m : mitglieder) {
            if (m.quittiertEpoche() != null) {
                quittiert.put(m.deviceId(), new Stand(m.quittiertEpoche(), m.quittiertRevision()));
            }
        }
        List<UUID> bestaetigt = new ArrayList<>();
        List<UUID> wartet = new ArrayList<>();
        for (MitgliedZeile m : mitglieder) {
            Stand q = quittiert.get(m.deviceId());
            (q != null && q.compareTo(d.stand()) >= 0 ? bestaetigt : wartet).add(m.deviceId());
        }
        return new GemeinsameSteuerungDto.Zweischritt(d.schritt().code(), d.epoche(), d.revision(),
                utc(d.createdAt()), List.copyOf(bestaetigt), List.copyOf(wartet));
    }

    private OffsetDateTime zuletztGesehen(UUID box) {
        List<Timestamp> t = jdbc.query("SELECT device_status_seen_at FROM device WHERE id = ?",
                (rs, n) -> rs.getTimestamp(1), box);
        return t.isEmpty() || t.get(0) == null ? null : utc(t.get(0).toInstant());
    }

    private static GemeinsameSteuerungDto.PlanZeile plan(PlanZustellungRepository.Plan p, boolean veroeffentlicht) {
        if (p == null) {
            return null;
        }
        return new GemeinsameSteuerungDto.PlanZeile(p.planId(), utc(p.generatedAt()),
                utc(veroeffentlicht ? p.veroeffentlichtUm() : p.quittiertUm()), p.urteil(), p.grund());
    }

    private static GemeinsameSteuerungDto.Revision revision(Long epoche, Long revision, Instant am) {
        return epoche == null || revision == null ? null
                : new GemeinsameSteuerungDto.Revision(epoche, revision, utc(am));
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }
}
