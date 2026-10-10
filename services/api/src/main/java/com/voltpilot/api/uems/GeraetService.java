package com.voltpilot.api.uems;

import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.uems.GeraetRepository.Einbau;
import com.voltpilot.api.uems.GeraetRepository.Speisung;
import com.voltpilot.api.uems.GeraetRepository.Teil;
import com.voltpilot.api.web.dto.GeraetDto;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Geräte lesen (UEMS AP-04 IP-10): je Anlage alle Einbauten, je Einbau seine Komponenten,
 * Karten und Vorgänger. Alles unter der Mandanten-RLS — eine fremde Anlage und ein fremdes
 * Gerät sind 404, nie 403.
 *
 * <p>Die Vorgänger eines Einbaus sind die früheren Einbauten DESSELBEN Geräts (gleiches
 * {@code kennzeichen}, früherer {@code eingebaut_am}), der jüngste zuerst: Z-5b (ab 18.11.2026
 * 10:40) nennt Z-5a (bis 18.11.2026 10:40).
 */
@Service
public class GeraetService {

    static final ZoneId ZEITZONE = MessstelleService.ZEITZONE;

    private final GeraetRepository geraete;
    private final Geltungsbereich geltungsbereich;

    public GeraetService(GeraetRepository geraete, Geltungsbereich geltungsbereich) {
        this.geraete = geraete;
        this.geltungsbereich = geltungsbereich;
    }

    /** Alle Einbauten der Anlage, ausgebaute eingeschlossen — nach Gerät, dann nach Einbau. */
    @Transactional(readOnly = true)
    public GeraetDto.Liste derAnlage(UUID siteId) {
        geltungsbereich.requireSite(siteId);
        Map<UUID, List<Speisung>> speisungen =
                nach(geraete.speisungenDerAnlage(siteId), Speisung::geraetId);
        Map<UUID, List<Teil>> teile = nach(geraete.teileDerAnlage(siteId), Teil::geraetId);
        List<Einbau> alle = geraete.derGeraeteDerAnlage(siteId);
        return new GeraetDto.Liste(geraete.derAnlage(siteId).stream()
                .map(e -> dto(e, speisungen, teile, alle))
                .toList());
    }

    /** Ein Einbau mit seinen Komponenten, Karten und Vorgängern. */
    @Transactional(readOnly = true)
    public GeraetDto.Geraet eines(UUID id) {
        Einbau e = geraete.eines(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));
        return dto(e, nach(geraete.speisungenDes(id), Speisung::geraetId),
                nach(geraete.teileDes(id), Teil::geraetId), geraete.desselbenGeraets(id));
    }

    private static GeraetDto.Geraet dto(Einbau e, Map<UUID, List<Speisung>> speisungen,
            Map<UUID, List<Teil>> teile, List<Einbau> einbautenDerGeraete) {
        List<GeraetDto.Vorgaenger> vorgaenger = einbautenDerGeraete.stream()
                .filter(v -> v.kennzeichen().equals(e.kennzeichen())
                        && v.eingebautAm().isBefore(e.eingebautAm()))
                .sorted(Comparator.comparing(Einbau::eingebautAm).reversed())
                .map(v -> new GeraetDto.Vorgaenger(v.id(), v.einbauKennzeichen(), v.hersteller(),
                        v.typ(), v.seriennummer(), zeit(v.eingebautAm()), zeit(v.ausgebautAm())))
                .toList();
        return new GeraetDto.Geraet(e.id(), e.siteId(), e.kennzeichen(), e.einbauKennzeichen(),
                e.geraeteart(), e.hersteller(), e.typ(), e.seriennummer(), e.bezeichnung(),
                e.dataSourceId(), e.geraeteId(), zeit(e.eingebautAm()), zeit(e.ausgebautAm()),
                e.ausBestand(),
                speisungen.getOrDefault(e.id(), List.of()).stream()
                        .map(s -> new GeraetDto.Komponente(s.entityId(), s.teilId(), s.steckplatz(),
                                zeit(s.gueltigAb()), zeit(s.gueltigBis())))
                        .toList(),
                teile.getOrDefault(e.id(), List.of()).stream()
                        .map(t -> new GeraetDto.Teil(t.id(), t.teilart(), t.steckplatz(),
                                t.bezeichnung(), t.typ(), t.seriennummer(), zeit(t.eingebautAm()),
                                zeit(t.ausgebautAm())))
                        .toList(),
                vorgaenger);
    }

    private static <T> Map<UUID, List<T>> nach(List<T> zeilen, Function<T, UUID> schluessel) {
        Map<UUID, List<T>> out = new LinkedHashMap<>();
        for (T z : zeilen) {
            out.computeIfAbsent(schluessel.apply(z), k -> new ArrayList<>()).add(z);
        }
        return out;
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, ZEITZONE);
    }
}
