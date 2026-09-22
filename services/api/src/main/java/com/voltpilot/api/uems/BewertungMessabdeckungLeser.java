package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BewertungMessabdeckungRepository.Info;
import com.voltpilot.api.web.dto.BewertungMessabdeckungDto.*;
import com.voltpilot.api.web.dto.BewertungRanglisteDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** P3/W8: reine Projektion des IP-9-Leseergebnisses; keine DB, Uhr oder Verbrauchsbildung. */
public final class BewertungMessabdeckungLeser {
    private BewertungMessabdeckungLeser() {}

    public static Messabdeckung lesen(BewertungRanglisteDto.Rangliste rangliste,
            Map<UUID, Info> infos, List<BewertungMessbedarfNaht.Bedarf> bedarfe, String k8Schwelle) {
        Map<UUID, BewertungRanglisteDto.Anlage> anlagen = new LinkedHashMap<>();
        rangliste.anlagen().forEach(a -> anlagen.put(a.id(), a));
        Map<UUID, List<BewertungMessbedarfNaht.Bedarf>> bedarfJeEinsatz = new HashMap<>();
        bedarfe.forEach(b -> bedarfJeEinsatz.computeIfAbsent(b.einsatzId(), x -> new ArrayList<>()).add(b));

        List<Einsatz> jeEinsatz = new ArrayList<>();
        for (var e : zusammen(rangliste)) {
            var gemessen = new ArrayList<Messwert>();
            var geplant = new ArrayList<Plan>();
            var ersatz = new ArrayList<Messwert>();
            var restAnlagen = new LinkedHashSet<UUID>();
            for (var m : e.messstellen()) {
                Info info = infos.get(m.id());
                String ort = info == null ? null : info.ort();
                if (m.menge() != null) {
                    gemessen.add(new Messwert(m.id(), m.kennzeichen(), ort, m.menge(), m.einheit()));
                    if (positiv(m.ersatz()))
                        ersatz.add(new Messwert(m.id(), m.kennzeichen(), ort, m.ersatz(), m.einheit()));
                } else if (info != null && info.ohneDatenquelle()) {
                    geplant.add(new Plan(m.id(), m.kennzeichen(), ort, info.seit(), null));
                    if (m.anlageId() != null) restAnlagen.add(m.anlageId());
                }
            }
            for (var b : bedarfJeEinsatz.getOrDefault(e.id(), List.of())) {
                geplant.add(new Plan(null, null, b.ort(), null, b.kennzeichen()));
                if (b.anlageId() != null) restAnlagen.add(b.anlageId());
            }
            var ungemessen = restAnlagen.stream().map(anlagen::get).filter(java.util.Objects::nonNull)
                    .map(BewertungMessabdeckungLeser::rest).toList();
            jeEinsatz.add(new Einsatz(e.id(), e.kennzeichen(), e.name(), e.prozessId(), e.traeger(),
                    e.einheit(), e.menge(), List.copyOf(gemessen), List.copyOf(geplant),
                    List.copyOf(ersatz), ungemessen));
        }

        List<Ort> jeOrt = new ArrayList<>();
        for (var a : rangliste.anlagen()) {
            var zeilen = rangliste.einsaetze().stream().flatMap(e -> e.messstellen().stream())
                    .filter(m -> a.id().equals(m.anlageId())).toList();
            jeOrt.add(new Ort("anlage", a.id(), null, a.name(), "Strom", "kWh",
                    gemessen(zeilen, infos), geplant(zeilen, infos), ersatz(zeilen, infos), rest(a)));
        }
        Map<String, List<BewertungRanglisteDto.Messstelle>> weitereOrte = new LinkedHashMap<>();
        Map<String, BewertungRanglisteDto.Einsatz> weitereEinsaetze = new LinkedHashMap<>();
        for (var e : rangliste.einsaetze()) for (var m : e.messstellen()) {
            if (m.anlageId() != null) continue;
            Info i = infos.get(m.id());
            String schluessel = e.traeger()+"\u0000"+(i == null || i.ortId() == null ? m.id() : i.ortId());
            weitereOrte.computeIfAbsent(schluessel, x -> new ArrayList<>()).add(m);
            weitereEinsaetze.putIfAbsent(schluessel, e);
        }
        for (var e : rangliste.weitereTraeger()) for (var m : e.messstellen()) {
            Info i = infos.get(m.id());
            String schluessel = e.traeger()+"\u0000"+(i == null || i.ortId() == null ? m.id() : i.ortId());
            weitereOrte.computeIfAbsent(schluessel, x -> new ArrayList<>()).add(m);
            weitereEinsaetze.putIfAbsent(schluessel, e);
        }
        for (var z : weitereOrte.entrySet()) {
            var ms = z.getValue();
            var e = weitereEinsaetze.get(z.getKey());
            Info i = infos.get(ms.getFirst().id());
            jeOrt.add(new Ort(i == null ? "ort" : i.ortArt(), i == null ? null : i.ortId(), null,
                    i == null ? null : i.ort(), e.traeger(), e.einheit(), gemessen(ms, infos),
                    geplant(ms, infos), ersatz(ms, infos), null));
        }

        String ersatzSumme = ersatzSumme(rangliste.einsaetze());
        String k8 = BewertungMengenLeser.abdeckungUrteil(rangliste.zugeordnet(),
                rangliste.nenner().wert(), k8Schwelle);
        var summe = new Summe(rangliste.nenner(), rangliste.zugeordnet(), rangliste.abdeckungProzent(),
                k8, ersatzSumme, rangliste.rest(), BewertungRegeln.prozent(zahl(rangliste.rest()),
                        zahl(rangliste.nenner().wert())));
        return new Messabdeckung(rangliste.von(), rangliste.bis(), rangliste.umfangId(),
                rangliste.umfangFassung(), rangliste.teilansicht(), summe,
                List.copyOf(jeEinsatz), List.copyOf(jeOrt));
    }

    private static List<BewertungRanglisteDto.Einsatz> zusammen(BewertungRanglisteDto.Rangliste r) {
        var aus = new ArrayList<BewertungRanglisteDto.Einsatz>(r.einsaetze());
        aus.addAll(r.weitereTraeger());
        aus.sort(Comparator.comparing(BewertungRanglisteDto.Einsatz::kennzeichen));
        return aus;
    }
    private static List<Messwert> gemessen(List<BewertungRanglisteDto.Messstelle> ms, Map<UUID, Info> infos) {
        return ms.stream().filter(m -> m.menge() != null).map(m -> new Messwert(m.id(), m.kennzeichen(),
                ort(infos, m.id()), m.menge(), m.einheit())).toList();
    }
    private static List<Plan> geplant(List<BewertungRanglisteDto.Messstelle> ms, Map<UUID, Info> infos) {
        return ms.stream().filter(m -> m.menge() == null && infos.containsKey(m.id())
                        && infos.get(m.id()).ohneDatenquelle())
                .map(m -> new Plan(m.id(), m.kennzeichen(), ort(infos, m.id()), infos.get(m.id()).seit(), null)).toList();
    }
    private static List<Messwert> ersatz(List<BewertungRanglisteDto.Messstelle> ms, Map<UUID, Info> infos) {
        return ms.stream().filter(m -> m.menge() != null && positiv(m.ersatz()))
                .map(m -> new Messwert(m.id(), m.kennzeichen(), ort(infos, m.id()), m.ersatz(), m.einheit())).toList();
    }
    private static String ort(Map<UUID, Info> infos, UUID id) {
        Info i = infos.get(id); return i == null ? null : i.ort();
    }
    private static Rest rest(BewertungRanglisteDto.Anlage a) {
        return new Rest(a.id(), a.name(), a.rest(), a.restAnteilProzent());
    }
    private static boolean positiv(String s) { return s != null && new BigDecimal(s).signum() > 0; }
    private static BigDecimal zahl(String s) { return s == null ? null : new BigDecimal(s); }
    private static String ersatzSumme(List<BewertungRanglisteDto.Einsatz> einsaetze) {
        BigDecimal summe = BigDecimal.ZERO;
        for (var e : einsaetze) {
            if (e.menge() != null && e.ersatz() == null) return null;
            if (e.ersatz() != null) summe = summe.add(new BigDecimal(e.ersatz()));
        }
        return summe.stripTrailingZeros().toPlainString();
    }
}
