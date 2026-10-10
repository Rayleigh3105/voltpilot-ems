package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Die benannten Steckerproben des Betreibers (AP-15 NW-8/I4) und ihr Grenz-Nachweis über denselben Zeitraum. */
@Service
public class SteckerprobeDienst {

    static final Duration HOECHSTDAUER = Duration.ofDays(31);
    private static final String KEIN_NETZANSCHLUSS = "kein_netzanschluss";

    private record Zeile(UUID id, UUID siteId, UUID boxId, Instant von, Instant bis, String bemerkung,
            Instant eingetragenAm) {}

    private final SteuerungsverbundRepository verbuende;
    private final NetzanschlussRepository anschluesse;
    private final StandortRepository standorte;
    private final GrenzNachweisService nachweise;
    private final JdbcTemplate jdbc;

    public SteckerprobeDienst(SteuerungsverbundRepository verbuende, NetzanschlussRepository anschluesse,
            StandortRepository standorte, GrenzNachweisService nachweise, JdbcTemplate jdbc) {
        this.verbuende = verbuende;
        this.anschluesse = anschluesse;
        this.standorte = standorte;
        this.nachweise = nachweise;
        this.jdbc = jdbc;
    }

    @Transactional
    public GemeinsameSteuerungDto.Steckerprobe eintragen(UUID siteId, OffsetDateTime von, OffsetDateTime bis,
            UUID boxId, String bemerkung, ProtokollAkteur wer) {
        VerbundZeile verbund = pruefen(siteId);
        Instant a = von.toInstant();
        Instant e = bis.toInstant();
        if (!e.isAfter(a) || Duration.between(a, e).compareTo(HOECHSTDAUER) > 0) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("von liegt vor bis; der Zeitraum ist höchstens 31 Tage.");
        }
        if (bemerkung != null && bemerkung.length() > 500) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("bemerkung hat höchstens 500 Zeichen.");
        }
        boolean mitglied = verbuende.mitglieder(verbund.id(), Instant.now()).stream()
                .map(MitgliedZeile::deviceId).anyMatch(boxId::equals);
        if (!mitglied) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.KEIN_MITGLIED,
                    "Diese Box ist kein Mitglied der Gemeinsamen Steuerung.");
        }
        UUID id = jdbc.queryForObject("INSERT INTO steuerungsverbund_steckerprobe "
                        + "(tenant_id, site_id, box_id, von, bis, bemerkung, created_by) VALUES (?,?,?,?,?,?,?) "
                        + "RETURNING id", UUID.class, TenantContext.get(), siteId, boxId, Timestamp.from(a),
                Timestamp.from(e), leerZuNull(bemerkung), wer.name());
        return auskunft(finden(id));
    }

    @Transactional(readOnly = true)
    public List<GemeinsameSteuerungDto.Steckerprobe> lesen(UUID siteId) {
        pruefen(siteId);
        return jdbc.query("SELECT id, site_id, box_id, von, bis, bemerkung, created_at "
                        + "FROM steuerungsverbund_steckerprobe WHERE site_id = ? ORDER BY von DESC, id", (rs, n) ->
                        new Zeile(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                                rs.getTimestamp(4).toInstant(), rs.getTimestamp(5).toInstant(), rs.getString(6),
                                rs.getTimestamp(7).toInstant()), siteId)
                .stream().map(this::auskunft).toList();
    }

    private VerbundZeile pruefen(UUID siteId) {
        if (!verbuende.anlageSichtbar(siteId)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
        return verbuende.derAnlage(siteId).orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(
                GemeinsameSteuerungAbgelehnt.NICHT_EINGERICHTET, "Die Gemeinsame Steuerung ist nicht eingerichtet."));
    }

    private Zeile finden(UUID id) {
        return jdbc.query("SELECT id, site_id, box_id, von, bis, bemerkung, created_at "
                        + "FROM steuerungsverbund_steckerprobe WHERE id = ?", (rs, n) ->
                        new Zeile(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                                rs.getTimestamp(4).toInstant(), rs.getTimestamp(5).toInstant(), rs.getString(6),
                                rs.getTimestamp(7).toInstant()), id).stream().findFirst()
                .orElseThrow(GemeinsameSteuerungAbgelehnt::nichtGefunden);
    }

    private GemeinsameSteuerungDto.Steckerprobe auskunft(Zeile z) {
        NetzanschlussDto.GrenzNachweis nachweis = null;
        String grund = KEIN_NETZANSCHLUSS;
        for (NetzanschlussRepository.Bindung b : anschluesse.bindungenDerAnlage(z.siteId())) {
            NetzanschlussRepository.Anschluss na = anschluesse.finde(b.netzanschlussId()).orElse(null);
            if (na == null) continue;
            ZoneId zone = standorte.finde(na.standortId()).map(s -> ZoneId.of(s.zeitzone())).orElse(ZoneOffset.UTC);
            if (b.laeuftAm(z.von().atZone(zone).toLocalDate())
                    && b.laeuftAm(z.bis().minusNanos(1).atZone(zone).toLocalDate())) {
                nachweis = nachweise.nachweis(na.standortId(), na.id(), null, z.von().atOffset(ZoneOffset.UTC).toString(),
                        z.bis().atOffset(ZoneOffset.UTC).toString(), ids -> true);
                grund = null;
                break;
            }
        }
        return new GemeinsameSteuerungDto.Steckerprobe(z.id(), z.von().atOffset(ZoneOffset.UTC),
                z.bis().atOffset(ZoneOffset.UTC), z.boxId(), z.bemerkung(), z.eingetragenAm().atOffset(ZoneOffset.UTC),
                grund, nachweis);
    }

    private static String leerZuNull(String text) {
        return text == null || text.isBlank() ? null : text.strip();
    }
}
