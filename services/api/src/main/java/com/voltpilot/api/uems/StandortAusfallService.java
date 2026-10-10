package com.voltpilot.api.uems;

import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.StandortAusfallDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Komponiert die Ausfall-Sicht aus Standort, Register und festgehaltenen Lücken-Fakten. */
@Service
public class StandortAusfallService {

    private final StandortLesemodellService standorte;
    private final StandortAusfallRepository ausfaelle;
    private final MessstelleRegisterService register;

    public StandortAusfallService(StandortLesemodellService standorte, StandortAusfallRepository ausfaelle,
            MessstelleRegisterService register) {
        this.standorte = standorte;
        this.ausfaelle = ausfaelle;
        this.register = register;
    }

    @Transactional(readOnly = true)
    public StandortAusfallDto.Ausfall ausfall(UUID standortId) {
        StandortAmStichtag standort = standorte.standort(standortId, null).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort not found"));
        List<UUID> anlagen = standort.anlagen().stream().map(StandortLesemodell.ZugeordneteAnlage::id).toList();
        List<StandortAusfallRepository.Box> boxFakten = ausfaelle.boxen(anlagen);
        List<StandortAusfallRepository.Messstelle> messFakten = ausfaelle.messstellen(anlagen);

        Map<UUID, StandortAusfallRepository.Messstelle> direkt = new LinkedHashMap<>();
        messFakten.forEach(m -> direkt.putIfAbsent(m.id(), m));
        Set<String> direkteKennzeichen = new LinkedHashSet<>();
        direkt.values().forEach(m -> direkteKennzeichen.add(m.kennzeichen()));

        MessstelleDto.Liste liste = register.liste(null,
                new MessstelleRegisterService.Filter(standort.kurzzeichen(), null, null, null, false, false));
        List<StandortAusfallDto.Messstelle> betroffen = new ArrayList<>();
        for (MessstelleDto.RegisterZeile z : liste.register()) {
            StandortAusfallRepository.Messstelle fakt = direkt.get(z.id());
            if (fakt != null) {
                betroffen.add(new StandortAusfallDto.Messstelle(z.id(), z.kennzeichen(), z.name(), z.art(),
                        MessstelleService.zeit(fakt.seit()), fakt.boxId(), fakt.box(), List.of()));
                continue;
            }
            if (z.berechnung() != null && "unvollstaendig".equals(z.berechnung().zustand())
                    && z.berechnung().fehlend().stream().anyMatch(direkteKennzeichen::contains)) {
                betroffen.add(new StandortAusfallDto.Messstelle(z.id(), z.kennzeichen(), z.name(), z.art(),
                        z.berechnung().seit(), null, null, z.berechnung().fehlend()));
            }
        }

        Map<UUID, List<UUID>> anlagenJeBox = new LinkedHashMap<>();
        for (StandortAusfallRepository.Box b : boxFakten) {
            anlagenJeBox.computeIfAbsent(b.id(), x -> new ArrayList<>()).add(b.siteId());
        }
        Map<UUID, StandortAusfallRepository.Box> boxen = new LinkedHashMap<>();
        boxFakten.forEach(b -> boxen.putIfAbsent(b.id(), b));
        List<StandortAusfallDto.Box> boxDto = boxen.values().stream().map(b -> new StandortAusfallDto.Box(
                b.id(), b.name(), MessstelleService.zeit(b.seit()), List.copyOf(anlagenJeBox.get(b.id())))).toList();
        return new StandortAusfallDto.Ausfall(standortId, ausfaelle.boxenGesamt(anlagen), boxDto.size(),
                betroffen.size(), boxDto, List.copyOf(betroffen));
    }
}
