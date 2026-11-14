package com.voltpilot.api.anlagencheck;

import com.voltpilot.api.anlagencheck.AnlagenCheckDto.EinheitDto;
import com.voltpilot.api.anlagencheck.AnlagenCheckDto.SaeuleDto;
import com.voltpilot.api.anlagencheck.AnlagenCheckDto.UrteilDto;
import com.voltpilot.api.anlagencheck.AnlagenCheckDto.ZeitraumDto;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.EinheitUrteil;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Modus;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Reihe;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.TagWert;
import com.voltpilot.api.anlagencheck.AnlagenCheckRegel.Urteil;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.forecast.ForecastModels;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.HistoryService;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Anlagen-Check (Bedienkonzept vp-privatkunde-bedienkonzept §9.2 A2/A5): setzt die Reihen aus Erwartung (A1),
 * gemessenen Stundenwerten und Abregelung zusammen und lässt {@link AnlagenCheckRegel} urteilen; dazu die
 * Speicher-Bilanz ({@link SpeicherBilanzRegel}).
 *
 * <p><b>Einheiten oder ganze Anlage</b> (BK-5 = A): verglichen wird je Einheit, sobald mindestens zwei bestätigte
 * PV-Einheiten ein Gerät mit eigener Messreihe zugeordnet haben. Sonst die ganze Anlage aus {@code forecast_rueckblick}
 * - der häufigste Haushalt (ein Hybrid-Wechselrichter) ist keiner Einheit zuordenbar und bekommt die Kachel trotzdem.
 *
 * <p><b>Abgeregelte Tage</b> sind die Tage mit GEPLANTER Abregelung ({@code schedule.curtail_kw}, gesteuerte Anlagen);
 * eine feste 60-/70-%-Grenze eines Wechselrichters ist je Tag nicht bekannt und bleibt ungewertet sichtbar.
 */
@Service
public class AnlagenCheckService {

    static final String MODUS_EINHEITEN = "einheiten";
    static final String MODUS_GANZE_ANLAGE = "ganze_anlage";
    static final String GANZE_ANLAGE_ID = "anlage";
    static final String GANZE_ANLAGE_NAME = "Ganze Anlage";

    private final AnlagenCheckRepository repo;
    private final HistoryRepository history;
    private final ForecastModelService forecastModels;
    private final Geltungsbereich geltungsbereich;
    private final Clock clock;

    @Autowired
    public AnlagenCheckService(AnlagenCheckRepository repo, HistoryRepository history,
            ForecastModelService forecastModels, Geltungsbereich geltungsbereich) {
        this(repo, history, forecastModels, geltungsbereich, Clock.systemUTC());
    }

    AnlagenCheckService(AnlagenCheckRepository repo, HistoryRepository history, ForecastModelService forecastModels,
            Geltungsbereich geltungsbereich, Clock clock) {
        this.repo = repo;
        this.history = history;
        this.forecastModels = forecastModels;
        this.geltungsbereich = geltungsbereich;
        this.clock = clock;
    }

    private LocalDate heute() {
        return LocalDate.now(clock.withZone(HistoryRange.ZONE));
    }

    // ---- Solar --------------------------------------------------------------------------------------

    /** Ein Vergleichsglied: Einheit (mit Messreihen) oder die ganze Anlage. */
    private record Glied(String id, String name, Double kwp, List<String> entityIds) {}

    public AnlagenCheckDto anlagenCheck(UUID siteId, HistoryRange range, LocalDate at) {
        geltungsbereich.requireSite(siteId);
        LocalDate heute = heute();
        LocalDate gestern = heute.minusDays(1);
        AnlagenCheckRepository.Stamm stamm = repo.stamm(siteId);
        String modell = forecastModels.activeModels(siteId).get(ForecastModels.KIND_PV);

        List<AnlagenCheckRepository.Einheit> einheiten = repo.pvEinheiten(siteId);
        List<AnlagenCheckRepository.Zuordnung> zuordnungen = repo.zuordnungen(siteId);
        List<Glied> gemessen = new ArrayList<>();
        List<String> ohneGeraet = new ArrayList<>();
        for (AnlagenCheckRepository.Einheit e : einheiten) {
            List<AnlagenCheckRepository.Zuordnung> eigene = zuordnungen.stream()
                    .filter(z -> z.einheitId().equals(e.id())).toList();
            List<String> ids = AnlagenCheckRepository.entityIds(eigene);
            String name = name(e, eigene);
            if (ids.isEmpty()) {
                ohneGeraet.add(name);
            } else {
                gemessen.add(new Glied(e.id().toString(), name, e.kwp(), ids));
            }
        }
        Modus modus = gemessen.size() >= 2 ? Modus.EINHEITEN : Modus.GANZE_ANLAGE;

        // Ein Lesefenster für Kachel und Zeitraum.
        LocalDate kachelVon = gestern.minusDays(AnlagenCheckRegel.FENSTER_LANG_TAGE - 1L);
        LocalDate zVon = null;
        LocalDate zBis = null;
        if (range != null) {
            HistoryRange.Window w = range.window(at != null ? at : heute);
            zVon = LocalDate.ofInstant(w.from(), HistoryRange.ZONE);
            zBis = LocalDate.ofInstant(w.to(), HistoryRange.ZONE).minusDays(1);
        }
        LocalDate leseVon = zVon != null && zVon.isBefore(kachelVon) ? zVon : kachelVon;
        LocalDate zAbgeschlossen = zBis == null ? null : (zBis.isBefore(gestern) ? zBis : gestern);
        LocalDate leseBis = gestern;

        List<Reihe> reihen;
        if (modus == Modus.EINHEITEN) {
            reihen = einheitenReihen(siteId, gemessen, modell, stamm, leseVon, leseBis);
        } else {
            Double kwp = stamm != null && stamm.pvKwp() != null ? stamm.pvKwp() : summeKwp(einheiten);
            reihen = List.of(anlageReihe(siteId, modell, kwp, leseVon, leseBis));
            ohneGeraet = List.of();
        }
        boolean pv = (stamm != null && stamm.pvKwp() != null && stamm.pvKwp() > 0) || !einheiten.isEmpty()
                || reihen.stream().anyMatch(r -> r.tage().stream()
                        .anyMatch(t -> t.gemessenKwh() != null && t.gemessenKwh() > 0));
        Set<LocalDate> abgeregelt = abgeregelt(siteId, leseVon, leseBis);

        Urteil kachel = AnlagenCheckRegel.rollend(reihen, modus, abgeregelt, gestern);
        ZeitraumDto zeitraum = range == null ? null
                : zeitraum(range, zVon, zBis, zAbgeschlossen, reihen, modus, abgeregelt);
        return new AnlagenCheckDto(pv, modus == Modus.EINHEITEN ? MODUS_EINHEITEN : MODUS_GANZE_ANLAGE,
                urteilDto(kachel), zeitraum, List.copyOf(ohneGeraet));
    }

    /** Der Name einer Einheit: ihre Bezeichnung, sonst das eine zugeordnete Gerät, sonst „Einheit seit …". */
    static String name(AnlagenCheckRepository.Einheit e, List<AnlagenCheckRepository.Zuordnung> eigene) {
        if (e.bezeichnung() != null && !e.bezeichnung().isBlank()) {
            return e.bezeichnung();
        }
        if (eigene.size() == 1 && eigene.get(0).name() != null) {
            return eigene.get(0).name();
        }
        return e.inbetriebnahme() != null ? "Einheit seit " + e.inbetriebnahme().getYear() : "Einheit";
    }

    private static Double summeKwp(List<AnlagenCheckRepository.Einheit> einheiten) {
        double s = 0;
        for (AnlagenCheckRepository.Einheit e : einheiten) {
            if (e.kwp() == null) {
                return null;
            }
            s += e.kwp();
        }
        return s > 0 ? s : null;
    }

    private List<Reihe> einheitenReihen(UUID siteId, List<Glied> glieder, String modell,
            AnlagenCheckRepository.Stamm stamm, LocalDate von, LocalDate bis) {
        Map<UUID, Map<LocalDate, Double>> erwartung = repo.erwartung(siteId, modell, von, bis);
        List<String> alleIds = new ArrayList<>();
        glieder.forEach(g -> g.entityIds().forEach(id -> {
            if (!alleIds.contains(id)) {
                alleIds.add(id);
            }
        }));
        Instant from = von.atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant to = bis.plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant();
        Map<String, Map<Instant, Double>> stunden = repo.pvStunden(siteId, alleIds, from, to);
        double breite = stamm != null && stamm.breite() != null ? stamm.breite() : 51.0;
        double laenge = stamm != null && stamm.laenge() != null ? stamm.laenge() : 10.0;

        List<Reihe> reihen = new ArrayList<>();
        for (Glied g : glieder) {
            Map<LocalDate, Double> erw = erwartung.getOrDefault(UUID.fromString(g.id()), Map.of());
            List<TagWert> tage = new ArrayList<>();
            for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
                tage.add(tagWert(d, g.entityIds(), stunden, erw.get(d), breite, laenge));
            }
            reihen.add(new Reihe(g.id(), g.name(), g.kwp(), tage));
        }
        return reihen;
    }

    /** Ein Tag einer Einheit über alle ihre Geräte: Summe; fehlt einem Gerät tagsüber zu viel, ist der Tag Lücke. */
    static TagWert tagWert(LocalDate d, List<String> entityIds, Map<String, Map<Instant, Double>> stunden,
            Double erwartet, double breite, double laenge) {
        List<Instant> h = stundenDesTages(d);
        List<Boolean> tagsueber = new ArrayList<>();
        for (Instant s : h) {
            tagsueber.add(SonnenStand.hoehe(breite, laenge, s.plus(Duration.ofMinutes(30)))
                    > AnlagenCheckRegel.TAG_AB_GRAD);
        }
        Double summe = null;
        boolean luecke = false;
        for (String id : entityIds) {
            Map<Instant, Double> reihe = stunden.getOrDefault(id, Map.of());
            List<Double> werte = new ArrayList<>();
            for (Instant s : h) {
                werte.add(reihe.get(s));
            }
            TagWert t = AnlagenCheckRegel.tagAusStunden(d, werte, tagsueber, erwartet);
            luecke |= t.luecke();
            if (t.gemessenKwh() == null) {
                luecke |= entityIds.size() > 1;
            } else {
                summe = (summe == null ? 0 : summe) + t.gemessenKwh();
            }
        }
        return new TagWert(d, summe, erwartet, luecke);
    }

    /** Die Stundenanfänge eines Berliner Tags (23, 24 oder 25). */
    static List<Instant> stundenDesTages(LocalDate d) {
        Instant start = d.atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant ende = d.plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant();
        List<Instant> out = new ArrayList<>();
        for (Instant t = start; t.isBefore(ende); t = t.plus(Duration.ofHours(1))) {
            out.add(t);
        }
        return out;
    }

    private Reihe anlageReihe(UUID siteId, String modell, Double kwp, LocalDate von, LocalDate bis) {
        Map<LocalDate, AnlagenCheckRepository.AnlageTag> nachTag = new LinkedHashMap<>();
        for (AnlagenCheckRepository.AnlageTag t : repo.anlageTage(siteId, modell, von, bis)) {
            nachTag.put(t.tag(), t);
        }
        List<TagWert> tage = new ArrayList<>();
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            AnlagenCheckRepository.AnlageTag t = nachTag.get(d);
            tage.add(t == null ? new TagWert(d, null, null, false)
                    : new TagWert(d, t.gemessenKwh(), t.erwartetKwh(), false));
        }
        return new Reihe(GANZE_ANLAGE_ID, GANZE_ANLAGE_NAME, kwp, tage);
    }

    private Set<LocalDate> abgeregelt(UUID siteId, LocalDate von, LocalDate bis) {
        Set<LocalDate> out = new HashSet<>();
        Instant from = von.atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant to = bis.plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant();
        for (HistoryRepository.ValueSlot s : history.curtailSlots(siteId, from, to)) {
            out.add(LocalDate.ofInstant(s.slot(), HistoryRange.ZONE));
        }
        return out;
    }

    private static ZeitraumDto zeitraum(HistoryRange range, LocalDate von, LocalDate bis, LocalDate abgeschlossen,
            List<Reihe> reihen, Modus modus, Set<LocalDate> abgeregelt) {
        String z = switch (range) {
            case DAY -> "tag";
            case WEEK -> "woche";
            case MONTH -> "monat";
            case YEAR -> "jahr";
        };
        boolean jahr = range == HistoryRange.YEAR;
        if (abgeschlossen == null || abgeschlossen.isBefore(von)) {
            List<EinheitDto> leer = reihen.stream()
                    .map(r -> new EinheitDto(r.id(), r.name(), null, null, null, "offen", null, null, 0)).toList();
            return new ZeitraumDto(z, von, bis, null, null, null, null, 0, 0, leer, jahr ? "monat" : "tag",
                    List.of());
        }
        Urteil u = AnlagenCheckRegel.urteil(reihen, modus, abgeregelt, von, abgeschlossen);
        List<EinheitDto> einheiten = new ArrayList<>();
        Double gemSumme = null;
        Double erwSumme = null;
        for (int i = 0; i < reihen.size(); i++) {
            Reihe r = reihen.get(i);
            EinheitUrteil eu = u.einheiten().get(i);
            Double gem = null;
            Double erw = null;
            for (TagWert t : r.tage()) {
                if (t.tag().isBefore(von) || t.tag().isAfter(abgeschlossen)) {
                    continue;
                }
                if (t.gemessenKwh() != null) {
                    gem = (gem == null ? 0 : gem) + t.gemessenKwh();
                }
                if (t.erwartetKwh() != null) {
                    erw = (erw == null ? 0 : erw) + t.erwartetKwh();
                }
            }
            if (gem != null) {
                gemSumme = (gemSumme == null ? 0 : gemSumme) + gem;
            }
            if (erw != null) {
                erwSumme = (erwSumme == null ? 0 : erwSumme) + erw;
            }
            boolean tag = range == HistoryRange.DAY;
            einheiten.add(new EinheitDto(r.id(), r.name(), gem, erw, tag ? null : eu.verhaeltnis(),
                    tag ? "offen" : wort(eu.zustand()), eu.keineWerteSeit(), tag ? null : eu.wenigerSeit(),
                    eu.gewerteteTage()));
        }
        // Säulen: je Tag, im Jahr je Monat.
        Map<LocalDate, List<Double>> saeulen = new LinkedHashMap<>();
        for (LocalDate d = von; !d.isAfter(abgeschlossen); d = d.plusDays(1)) {
            LocalDate key = jahr ? d.withDayOfMonth(1) : d;
            List<Double> werte = saeulen.computeIfAbsent(key, k -> {
                List<Double> l = new ArrayList<>();
                reihen.forEach(r -> l.add(null));
                return l;
            });
            for (int i = 0; i < reihen.size(); i++) {
                TagWert t = reihen.get(i).am(d);
                if (t != null && t.gemessenKwh() != null) {
                    Double alt = werte.get(i);
                    werte.set(i, (alt == null ? 0 : alt) + t.gemessenKwh());
                }
            }
        }
        List<SaeuleDto> s = new ArrayList<>();
        saeulen.forEach((k, v) -> s.add(new SaeuleDto(k, nullErlaubt(v))));
        String gesamt = range == HistoryRange.DAY ? null : wort(u.gesamt());
        return new ZeitraumDto(z, von, bis, abgeschlossen, gemSumme, erwSumme, gesamt, u.sonnenTage(),
                u.abgeregelteTage(), List.copyOf(einheiten), jahr ? "monat" : "tag", List.copyOf(s));
    }

    private static List<Double> nullErlaubt(List<Double> l) {
        return java.util.Collections.unmodifiableList(new ArrayList<>(l));
    }

    static UrteilDto urteilDto(Urteil u) {
        List<EinheitDto> einheiten = u.einheiten().stream()
                .map(e -> new EinheitDto(e.id(), e.name(), e.gemessenKwh(), e.erwartetKwh(), e.verhaeltnis(),
                        wort(e.zustand()), e.keineWerteSeit(), e.wenigerSeit(), e.gewerteteTage()))
                .toList();
        return new UrteilDto(wort(u.gesamt()), u.von(), u.bis(), u.fensterTage(), u.sonnenTage(),
                u.abgeregelteTage(), einheiten);
    }

    static String wort(Enum<?> e) {
        return e.name().toLowerCase(Locale.ROOT);
    }

    // ---- Speicher -----------------------------------------------------------------------------------

    /** Wie weit die Speicher-Bilanz zurückliest: 30 Tage + 12 volle Monate + Rand. */
    static final int SPEICHER_LESETAGE = 400;

    public SpeicherBilanzDto speicherBilanz(UUID siteId) {
        geltungsbereich.requireSite(siteId);
        LocalDate heute = heute();
        LocalDate leseVon = YearMonth.from(heute).minusMonths(12).atDay(1)
                .minusDays(SpeicherBilanzRegel.FENSTER_OHNE_KAPAZITAET_TAGE);
        if (leseVon.isAfter(heute.minusDays(SPEICHER_LESETAGE))) {
            leseVon = heute.minusDays(SPEICHER_LESETAGE);
        }
        Instant from = leseVon.atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant to = heute.atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant cutover = history.v2HistoryCutover(siteId);
        List<HistoryBucketDto> buckets = history.rollupBuckets(siteId, from, to, true);
        if (cutover != null) {
            buckets = HistoryService.splice(buckets, history.v2RollupBuckets(siteId, from, to, true), cutover);
        }
        List<SpeicherBilanzRegel.Tag> tage = new ArrayList<>();
        for (HistoryBucketDto b : buckets) {
            tage.add(new SpeicherBilanzRegel.Tag(LocalDate.ofInstant(b.start(), HistoryRange.ZONE),
                    dbl(b.batteryChargeKwh()), dbl(b.batteryDischargeKwh()), dbl(b.socLastPct())));
        }
        AnlagenCheckRepository.Stamm stamm = repo.stamm(siteId);
        Double kapazitaet = stamm == null ? null : stamm.speicherKwh();
        double vorher = repo.herausVor(siteId, from);
        SpeicherBilanzRegel.Bilanz b = SpeicherBilanzRegel.bilanz(tage, kapazitaet, heute, vorher);
        return new SpeicherBilanzDto(wort(b.zustand()), b.von(), b.bis(), b.fensterTage(), b.tageMitDaten(),
                b.hineinKwh(), b.herausKwh(), b.ausgleichKwh(), b.wirkungsgrad(), b.verlustKwh(), b.vollzyklen(),
                b.vollzyklenSeitBeginn(), b.kapazitaetKwh(), b.vergleichMin(), b.vergleichMax(), b.vergleichMonate(),
                b.satz() == null ? null : wort(b.satz()),
                b.monate().stream().map(m -> new SpeicherBilanzDto.MonatDto(m.monat().toString(), m.hineinKwh(),
                        m.herausKwh(), m.wirkungsgrad(), m.vollzyklen())).toList());
    }

    private static Double dbl(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }
}
