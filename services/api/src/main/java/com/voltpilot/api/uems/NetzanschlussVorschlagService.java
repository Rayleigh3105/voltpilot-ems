package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Vorverknüpfter Anlegevorschlag: Vertragsdaten ergänzt der Mensch, site bleibt unverändert. */
@Service
public class NetzanschlussVorschlagService {
    private final JdbcTemplate jdbc;
    private final NetzanschlussService anschluesse;
    private final NetzanschlussRepository repo;
    private final StandortRepository standorte;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;

    public NetzanschlussVorschlagService(JdbcTemplate jdbc, NetzanschlussService anschluesse,
            NetzanschlussRepository repo, StandortRepository standorte, UnternehmenRepository unternehmen,
            RechtPruefung rechte) {
        this.jdbc = jdbc;
        this.anschluesse = anschluesse;
        this.repo = repo;
        this.standorte = standorte;
        this.unternehmen = unternehmen;
        this.rechte = rechte;
    }

    @Transactional(readOnly = true)
    public List<NetzanschlussDto.Vorschlag> liste(UUID standortId) {
        var s = standorte.finde(standortId).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden."));
        rechte.pruefen("netzanschluss.verwalten", RechtZiel.STANDORT, standortId, null);
        LocalDate heute = LocalDate.now(ZoneId.of(s.zeitzone()));
        var anlagen = jdbc.query("""
                SELECT a.id, a.name, z.gueltig_ab FROM site a
                JOIN anlage_standort z ON z.site_id = a.id AND z.tenant_id = a.tenant_id
                JOIN standort s ON s.id = z.standort_id AND s.tenant_id = z.tenant_id
                WHERE z.standort_id = ? AND z.aufgehoben_am IS NULL
                AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> ?::date
                AND s.zustand <> 'archiviert'
                AND EXISTS (SELECT 1 FROM funktion f WHERE f.standort_id = s.id
                    AND f.funktion = 'messen' AND f.zustand = 'aktiv')
                AND NOT EXISTS (SELECT 1 FROM anlage_netzanschluss n
                    WHERE n.site_id = a.id AND n.aufgehoben_am IS NULL)
                AND NOT EXISTS (SELECT 1 FROM netzanschluss_vorschlag_entscheidung e WHERE e.site_id = a.id)
                ORDER BY a.name, a.id
                """, (rs, n) -> new NetzanschlussDto.Vorschlag(rs.getObject("id", UUID.class),
                rs.getString("name"), rs.getObject("gueltig_ab", LocalDate.class), null,
                "Netzanschluss " + rs.getString("name")), standortId, heute);
        List<String> belegt = new ArrayList<>(repo.belegt().stream().map(NetzanschlussRepository.Belegung::kennzeichen).toList());
        int zaehler = repo.zaehler();
        List<NetzanschlussDto.Vorschlag> result = new ArrayList<>();
        for (var a : anlagen) {
            var k = NetzanschlussRegeln.kennzeichen(null, belegt, zaehler).vorschlag();
            result.add(new NetzanschlussDto.Vorschlag(a.anlageId(), a.anlageName(), a.bindungAb(), k.kennzeichen(), a.name()));
            belegt.add(k.kennzeichen());
            zaehler = k.zaehler();
        }
        return result;
    }

    @Transactional
    public NetzanschlussDto.Netzanschluss uebernehmen(UUID standortId, UUID anlageId,
            NetzanschlussDto.Uebernehmen a, ProtokollAkteur wer) {
        sperreUndPruefe(standortId, anlageId);
        LocalDate ab;
        try {
            ab = LocalDate.parse(a.bindungAb());
        } catch (DateTimeParseException | NullPointerException e) {
            throw NetzanschlussAbgelehnt.anfrage("bindung_ab");
        }
        rechte.rueckwirkend(ab);
        var s = standorte.finde(standortId).orElseThrow();
        if (ab.isBefore(LocalDate.now(ZoneId.of(s.zeitzone()))) && (a.grund() == null || a.grund().isBlank())) {
            throw NetzanschlussAbgelehnt.anfrage("grund");
        }
        UUID id = anschluesse.anlegen(standortId, new NetzanschlussDto.Anschluss(a.kennzeichen(), a.name(), a.malo(),
                a.netzbetreiber(), a.anschlussKva(), a.vereinbartKw(), a.messung(), a.gueltigAb(), a.gueltigBis()), wer);
        anschluesse.binden(standortId, id, new NetzanschlussDto.Binden(anlageId.toString(), ab.toString(), a.grund()), wer);
        merken(anlageId, "uebernommen", wer);
        return anschluesse.netzanschluss(standortId, id);
    }

    @Transactional
    public void verwerfen(UUID standortId, UUID anlageId, ProtokollAkteur wer) {
        sperreUndPruefe(standortId, anlageId);
        merken(anlageId, "verworfen", wer);
    }

    private void sperreUndPruefe(UUID standortId, UUID anlageId) {
        // Dieselbe Sperre wie Anlegen/Binden: auch konkurrierende manuelle Bindungen werden gesehen.
        if (unternehmen.sperren().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden.");
        }
        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM site WHERE id = ?)",
                Boolean.class, anlageId))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        if (liste(standortId).stream().noneMatch(v -> v.anlageId().equals(anlageId))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Vorschlag ist nicht mehr verfügbar. Bitte laden Sie die Liste neu.");
        }
    }

    private void merken(UUID anlageId, String entscheidung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO netzanschluss_vorschlag_entscheidung "
                + "(tenant_id, site_id, entscheidung, entschieden_von) VALUES (?, ?, ?, ?)",
                TenantContext.get(), anlageId, entscheidung, wer.sub());
    }
}
