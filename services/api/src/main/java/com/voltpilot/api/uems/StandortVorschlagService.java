package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.StandortDto;
import com.voltpilot.api.web.dto.StandortVorschlagDto;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Lesende Vorschau und atomare Bestätigung der Bestands-Zuordnung (AP-02 IP-10). */
@Service
public class StandortVorschlagService {
    private final StandortVorschlagRepository vorschlaege;
    private final StandortService standorte;
    private final StandortRepository standortRepository;
    private final AnlageStandortService anlageStandort;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public StandortVorschlagService(StandortVorschlagRepository vorschlaege, StandortService standorte,
            StandortRepository standortRepository, AnlageStandortService anlageStandort,
            PlatformTransactionManager transactionManager) {
        this.vorschlaege = vorschlaege;
        this.standorte = standorte;
        this.standortRepository = standortRepository;
        this.anlageStandort = anlageStandort;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    void uhrStellen(Clock uhr) { this.uhr = uhr; }

    /** Schreibt nichts: jede Vorschlagszeile ist zunächst eine eigene Gruppe. */
    public StandortVorschlagDto.Vorschau vorschau() {
        List<StandortVorschlagDto.Gruppe> gruppen = vorschlaege.alle().stream().map(v ->
                new StandortVorschlagDto.Gruppe(v.name(), v.zeitzone(), null,
                        List.of(new StandortVorschlagDto.Anlage(v.id(), v.siteId(), v.siteName(), v.gueltigAb()))))
                .toList();
        return new StandortVorschlagDto.Vorschau(gruppen, gruppen.size());
    }

    /** Legt alle Gruppen samt Zuordnungen an oder gar nichts; jede offene Zeile muss genau einmal vorkommen. */
    public StandortVorschlagDto.Ergebnis bestaetigen(StandortVorschlagDto.Bestaetigen body,
            ProtokollAkteur wer) {
        if (body == null || body.gruppen() == null || body.gruppen().isEmpty()) {
            throw OrtAbgelehnt.anfrage("gruppen", "Bitte ordnen Sie jede Anlage einem Standort zu.");
        }
        return transaktion.execute(status -> schreiben(body, wer));
    }

    private StandortVorschlagDto.Ergebnis schreiben(StandortVorschlagDto.Bestaetigen body,
            ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (tenant == null) throw new IllegalStateException("Standort-Vorschlag ohne Kundenbereich");
        List<StandortVorschlagRepository.Vorschlag> offen = vorschlaege.alle();
        Map<UUID, StandortVorschlagRepository.Vorschlag> jeId = new LinkedHashMap<>();
        offen.forEach(v -> jeId.put(v.id(), v));
        Set<UUID> gesehen = new HashSet<>();
        for (int i = 0; i < body.gruppen().size(); i++) {
            StandortVorschlagDto.GruppeEingang gruppe = body.gruppen().get(i);
            if (gruppe == null) {
                throw OrtAbgelehnt.anfrage("gruppen[" + i + "]", "Bitte geben Sie einen Standort an.");
            }
            List<UUID> ids = gruppe.vorschlagIds();
            if (ids == null || ids.isEmpty()) {
                throw OrtAbgelehnt.anfrage("gruppen[" + i + "].vorschlagIds", "Ein Standort braucht mindestens eine Anlage.");
            }
            for (UUID id : ids) {
                if (id == null || !jeId.containsKey(id) || !gesehen.add(id)) {
                    throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.VORSCHLAG_GEAENDERT,
                            "Der Vorschlag hat sich geändert. Bitte laden Sie ihn neu.", Map.of());
                }
            }
        }
        if (gesehen.size() != offen.size()) {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.VORSCHLAG_GEAENDERT,
                    "Der Vorschlag hat sich geändert. Bitte laden Sie ihn neu.", Map.of());
        }

        Instant jetzt = uhr.instant();
        List<UUID> standortIds = new ArrayList<>();
        int zuordnungen = 0;
        for (StandortVorschlagDto.GruppeEingang gruppe : body.gruppen()) {
            String zone = gruppe.zeitzone();
            if (zone == null) zone = jeId.get(gruppe.vorschlagIds().get(0)).zeitzone();
            StandortLesemodell.StandortAmStichtag angelegt = standorte.anlegen(
                    new StandortDto.Stammdaten(gruppe.name(), null, gruppe.adresse(), zone, null, null, null), wer);
            StandortRepository.Standort ziel = standortRepository.finde(angelegt.id()).orElseThrow();
            standortIds.add(ziel.id());
            for (UUID id : gruppe.vorschlagIds()) {
                StandortVorschlagRepository.Vorschlag v = jeId.get(id);
                anlageStandort.zuordnen(tenant, v.siteId(), v.siteName(), ziel, v.gueltigAb(), jetzt, wer);
                zuordnungen++;
            }
        }
        if (!vorschlaege.entfernen(new ArrayList<>(gesehen))) {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.VORSCHLAG_GEAENDERT,
                    "Der Vorschlag hat sich geändert. Bitte laden Sie ihn neu.", Map.of());
        }
        return new StandortVorschlagDto.Ergebnis(List.copyOf(standortIds), zuordnungen);
    }
}
