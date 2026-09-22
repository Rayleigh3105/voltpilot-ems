package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BewertungMessabdeckungDto.Messabdeckung;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** IP-13: verbindet den IP-9-Leser mit Orts-/Quellenfakten und der wirksamen K8-Fassung. */
@Service
public class BewertungMessabdeckungService {
    private final BewertungRanglisteService rangliste;
    private final BewertungMessabdeckungRepository repository;
    private final BewertungKriterienService kriterien;
    private final BewertungMessbedarfNaht messbedarfe;

    public BewertungMessabdeckungService(BewertungRanglisteService rangliste,
            BewertungMessabdeckungRepository repository, BewertungKriterienService kriterien,
            BewertungMessbedarfNaht messbedarfe) {
        this.rangliste = rangliste;
        this.repository = repository;
        this.kriterien = kriterien;
        this.messbedarfe = messbedarfe;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Messabdeckung lesen(LocalDate von, LocalDate bis) {
        var mengen = rangliste.lesen(von, bis);
        var ids = new LinkedHashSet<UUID>();
        mengen.einsaetze().forEach(e -> e.messstellen().forEach(m -> ids.add(m.id())));
        mengen.weitereTraeger().forEach(e -> e.messstellen().forEach(m -> ids.add(m.id())));
        String k8 = kriterien.lesen().werte().path("K8").asText();
        return BewertungMessabdeckungLeser.lesen(mengen, repository.infos(ids, von, bis),
                messbedarfe.offene(von, bis), k8);
    }
}
