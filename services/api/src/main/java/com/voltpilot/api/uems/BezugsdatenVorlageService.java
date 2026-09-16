package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.web.dto.BezugsdatenVorlageDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Kundenbereichsweite Vorlagen: jede Änderung ist eine neue, unveränderliche Fassung (E12). */
@Service
public class BezugsdatenVorlageService {

    private final BezugsdatenVorlageRepository vorlagen;
    private final BezugsgroesseRepository bezugsgroessen;
    private final RechtPruefung rechte;

    public BezugsdatenVorlageService(BezugsdatenVorlageRepository vorlagen, BezugsgroesseRepository bezugsgroessen,
            RechtPruefung rechte) {
        this.vorlagen = vorlagen;
        this.bezugsgroessen = bezugsgroessen;
        this.rechte = rechte;
    }

    @Transactional(readOnly = true)
    public BezugsdatenVorlageDto.Liste liste() {
        return new BezugsdatenVorlageDto.Liste(vorlagen.aktuelle().stream().map(this::dto).toList());
    }

    @Transactional
    public BezugsdatenVorlageDto.Vorlage speichern(BezugsdatenVorlageDto.Anfrage anfrage, ProtokollAkteur wer) {
        if (anfrage == null) {
            throw BezugsgroesseAbgelehnt.anfrage("anfrage");
        }
        String name = anfrage.name() == null ? "" : anfrage.name().strip();
        if (name.isEmpty() || name.length() > 120) {
            throw BezugsgroesseAbgelehnt.anfrage("name");
        }
        BezugsdatenImportDto.Zuordnung z = anfrage.zuordnung();
        BezugsdatenZuordnung.aus(z);
        Map<String, BezugsgroesseRepository.Zeile> jeKennzeichen = new LinkedHashMap<>();
        bezugsgroessen.alle().forEach(b -> jeKennzeichen.put(b.kennzeichen(), b));
        LinkedHashSet<UUID> bezuege = new LinkedHashSet<>();
        LinkedHashSet<String> kennzeichen = new LinkedHashSet<>();
        if (z.bezugsgroesse() != null && !z.bezugsgroesse().isBlank()) {
            kennzeichen.add(z.bezugsgroesse());
        }
        if (z.bezugTabelle() != null) {
            kennzeichen.addAll(z.bezugTabelle().values());
        }
        for (String kennung : kennzeichen) {
            BezugsgroesseRepository.Zeile bezug = jeKennzeichen.get(kennung);
            if (bezug == null) {
                throw BezugsgroesseAbgelehnt.anfrage("zuordnung.bezug_tabelle");
            }
            rechte.pruefenGeltung("bezugsgroesse.importieren", bezug.geltungArt(), bezug.geltungId(),
                    () -> BezugsgroesseAbgelehnt.von(BezugsgroesseRegeln.Ablehnung.NICHT_GEFUNDEN));
            bezuege.add(bezug.id());
        }
        UUID id = anfrage.vorlageId() == null ? UUID.randomUUID() : anfrage.vorlageId();
        int fassung = vorlagen.naechsteFassung(id);
        if (anfrage.vorlageId() != null && fassung == 1) {
            throw BezugsgroesseAbgelehnt.von(BezugsgroesseRegeln.Ablehnung.NICHT_GEFUNDEN);
        }
        vorlagen.einfuegen(id, fassung, name, z, bezuege, wer);
        return vorlagen.aktuell(id).map(this::dto).orElseThrow();
    }

    @Transactional(readOnly = true)
    public BezugsdatenVorlageRepository.Zeile aktuell(UUID id) {
        return vorlagen.aktuell(id).orElseThrow(
                () -> BezugsgroesseAbgelehnt.von(BezugsgroesseRegeln.Ablehnung.NICHT_GEFUNDEN));
    }

    private BezugsdatenVorlageDto.Vorlage dto(BezugsdatenVorlageRepository.Zeile z) {
        return new BezugsdatenVorlageDto.Vorlage(z.id(), z.fassung(), z.name(), z.zuordnung(),
                new BezugsdatenVorlageDto.Urheber(z.actorName(), z.actorRolle(), z.actorArt()),
                z.erstelltAm().atZone(ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }
}
