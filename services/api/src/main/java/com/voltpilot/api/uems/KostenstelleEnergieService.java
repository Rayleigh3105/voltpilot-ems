package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Art;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Kostenstellen-Sicht (UEMS AP-10 IP-11): was eine Kostenstelle über eine Periode verbraucht hat — gemessen,
 * verteilt, berechnet — und was daneben NIEMANDEM gehört (nicht verteilt).
 *
 * <p><b>Was hier NICHT gerechnet wird — und woher es kommt:</b>
 * <ul>
 *   <li>Die Tageswerte je Messstelle liest das Lese-Modell „Werte je Messstelle“ ({@link MessstelleWerteService},
 *       AP-08 IP-9; gemessen aus {@code messreihe_tag}, berechnet aus der Spur von AP-10 IP-10). Ab Version 2 stehen
 *       sie in {@code messreihe_periode_version} (die Korrektur-Kaskade, AP-08 IP-17) — gelesen wird je Tag die höchste
 *       Version bis zur angefragten; ohne Angabe die neueste. Version 1 bleibt damit lesbar ({@code version=1}).</li>
 *   <li>Die vier Herkünfte, die Tagesanteile (E12) und die Summen bildet {@link KostenstelleEnergieRegeln} — sie ruft
 *       {@link VerteilungRegeln#amTag}, {@link VerteilungRegeln#erbe} und die Summenregel der Bilanz.</li>
 *   <li>Die Herkunft je Posten baut {@link BilanzwertHerkunft} (E13); der Messwert-Herkunftsvertrag bleibt
 *       unberührt.</li>
 * </ul>
 *
 * <p><b>Nichts wird gespeichert.</b> Ein verteilter Wert entsteht beim Lesen und trägt die Version seiner Quelle;
 * {@code berechnet_am} ist darum der Zeitpunkt dieser Sicht.
 *
 * <p><b>Mandantenzaun:</b> alles über die App-Verbindung hinter RLS; eine fremde Kostenstelle ist nicht zu finden und
 * damit 404, und ihr „nicht verteilt“ nennt nur Messstellen des eigenen Kundenbereichs.
 */
@Service
public class KostenstelleEnergieService {

    /** Die Perioden in der Reihenfolge der OpenAPI. */
    public static final List<String> PERIODEN = List.of("tag", "monat", "jahr");

    static final String VORGABE_PERIODE = "monat";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MOMENTANWERT = "Momentanwert";

    private final KostenstelleProzessRepository objekte;
    private final KostenstelleEnergieRepository lesen;
    private final MessstelleRepository messstellen;
    private final MessstelleWerteService werte;

    private volatile Clock uhr = Clock.systemUTC();

    public KostenstelleEnergieService(KostenstelleProzessRepository objekte, KostenstelleEnergieRepository lesen,
            MessstelleRepository messstellen, MessstelleWerteService werte) {
        this.objekte = objekte;
        this.lesen = lesen;
        this.messstellen = messstellen;
        this.werte = werte;
    }

    /** Nur für Tests: die Uhr für „heute“ und {@code berechnet_am}. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public KostenstelleEnergieDto.Energie energie(UUID id, String periodeWort, LocalDate am, String versionText) {
        String periode = periodeWort == null || periodeWort.isBlank() ? VORGABE_PERIODE : periodeWort.strip();
        if (!PERIODEN.contains(periode)) {
            throw BilanzAbgelehnt.anfrage("periode", "„periode“ ist tag, monat oder jahr.");
        }
        Integer version = version(versionText);
        KostenstelleProzessRepository.Objekt k = objekte.finde(Art.KOSTENSTELLE, id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Kostenstelle nicht gefunden."));
        String zoneText = lesen.zeitzone();
        ZoneId zone = zoneText == null ? ZoneId.of("UTC") : ZoneId.of(zoneText);
        Instant jetzt = uhr.instant();
        LocalDate tag = am != null ? am : LocalDate.ofInstant(jetzt, zone);
        LocalDate von = switch (periode) {
            case "tag" -> tag;
            case "monat" -> tag.withDayOfMonth(1);
            default -> tag.withDayOfYear(1);
        };
        LocalDate bis = switch (periode) {
            case "tag" -> tag;
            case "monat" -> YearMonth.from(tag).atEndOfMonth();
            default -> tag.withDayOfYear(tag.lengthOfYear());
        };

        Map<UUID, List<KostenstelleEnergieRepository.Anteil>> anteile = new HashMap<>();
        lesen.anteile(von, bis).forEach(a -> anteile.computeIfAbsent(a.messstelleId(), x -> new ArrayList<>()).add(a));
        List<VerteilungRegeln.Ziel> ziele = lesen.ziele().stream()
                .map(z -> new VerteilungRegeln.Ziel(z.kennzeichen(), z.gueltigAb(), z.gueltigBis()))
                .toList();

        Map<String, Messstelle> nachKennzeichen = new LinkedHashMap<>();
        Map<String, Map<LocalDate, KostenstelleEnergieRegeln.Tageswert>> tageswerte = new HashMap<>();
        Map<String, Map<LocalDate, String>> anlaesse = new HashMap<>();
        Map<String, Map<LocalDate, Map<String, Object>>> tagesHerkunft = new HashMap<>();
        List<KostenstelleEnergieRegeln.Quelle> quellen = new ArrayList<>();
        for (Messstelle m : messstellen.alle()) {
            List<KostenstelleEnergieRepository.Anteil> eigene = anteile.getOrDefault(m.id(), List.of());
            // Ohne Anteil zählt eine Messstelle nur mit, wenn sie Mengen trägt: ein Momentanwert ist nie „nicht verteilt“.
            if (eigene.isEmpty() && MOMENTANWERT.equals(m.hauptgroesse().wertart())) {
                continue;
            }
            Map<LocalDate, String> anlass = new HashMap<>();
            Map<LocalDate, KostenstelleEnergieRegeln.Tageswert> tage = tage(m, von, bis, version, anlass);
            if (eigene.isEmpty() && tage.isEmpty()) {
                continue;
            }
            nachKennzeichen.put(m.kennzeichen(), m);
            tageswerte.put(m.kennzeichen(), tage);
            anlaesse.put(m.kennzeichen(), anlass);
            if (MessstelleRegeln.BERECHNET.equals(m.art()) && !tage.isEmpty()) {
                tagesHerkunft.put(m.kennzeichen(), tagesHerkunft(m, tage, von, bis, zone));
            }
            quellen.add(new KostenstelleEnergieRegeln.Quelle(m.kennzeichen(), m.art(), m.hauptgroesse().groesse(),
                    m.hauptgroesse().richtung(), m.hauptgroesse().einheit(),
                    eigene.stream().map(a -> new KostenstelleEnergieRegeln.Anteil(a.kostenstelle(), a.anteilProzent(),
                            a.gueltigAb(), a.gueltigBis(), a.fassung())).toList(),
                    List.copyOf(tage.values())));
        }

        KostenstelleEnergieRegeln.Urteil u = KostenstelleEnergieRegeln.energie(k.kennzeichen(), von, bis, ziele,
                quellen);
        String berechnetAm = MessstelleWerteRegeln.iso(jetzt, zone);
        Herkunft h = new Herkunft(k.kennzeichen(), periode, schluessel(periode, von), berechnetAm, zone,
                nachKennzeichen, tageswerte, anlaesse, tagesHerkunft);
        return new KostenstelleEnergieDto.Energie(
                new KostenstelleEnergieDto.Kostenstelle(k.id(), k.kennzeichen(), k.name(), k.gueltigAb(),
                        k.gueltigBis()),
                periode, tag, von, bis, zone.getId(), version, berechnetAm,
                block(u.gemessen(), h, true), block(u.verteilt(), h, true), block(u.berechnet(), h, true),
                block(u.summe(), h, true), block(u.nichtVerteilt(), h, false));
    }

    // ------------------------------------------------------------------------------ Tageswerte

    /**
     * Die Tageswerte einer Messstelle im Zeitraum: Version 1 aus dem Lese-Modell „Werte je Messstelle“, darüber je Tag
     * die höchste Version bis {@code version} aus {@code messreihe_periode_version}. Ein Tag ohne gespeicherte Zeile
     * (noch nicht gebildet, keine Quelle) hat keinen Tageswert — er ist unbekannt, nicht 0.
     */
    private Map<LocalDate, KostenstelleEnergieRegeln.Tageswert> tage(Messstelle m, LocalDate von, LocalDate bis,
            Integer version, Map<LocalDate, String> anlass) {
        // Ausdrücklich Version 1: ohne Angabe zeigt das Lese-Modell seit AP-08 IP-18 die neueste; die Auswahl bis
        // „version“ trifft diese Sicht unten selbst.
        MessstelleWerteDto.Werte w = werte.werte(m.kennzeichen(), "tag", von.toString(), bis.toString(), "1");
        Map<UUID, MessstelleWerteDto.Quelle> bindungen = new HashMap<>();
        w.quellen().forEach(q -> bindungen.put(q.id(), q));
        boolean berechnet = MessstelleRegeln.BERECHNET.equals(m.art());
        Map<String, Map<LocalDate, KostenstelleEnergieRepository.Version>> versionen = new HashMap<>();
        Map<LocalDate, KostenstelleEnergieRegeln.Tageswert> raus = new LinkedHashMap<>();
        for (MessstelleWerteDto.Wert x : w.werte()) {
            if (x.grund() != null || x.zustand() == null) {
                continue;
            }
            LocalDate tag = OffsetDateTime.parse(x.von()).toLocalDate();
            KostenstelleEnergieRegeln.Tageswert tw = new KostenstelleEnergieRegeln.Tageswert(tag, x.menge(),
                    x.zustand(), x.abdeckungProzent(), x.version() == null ? 1 : x.version(),
                    x.kennzeichen() == null ? List.of() : x.kennzeichen());
            if (version == null || version > 1) {
                MessstelleWerteDto.Quelle q = x.quelle() == null ? null : bindungen.get(x.quelle());
                String spur = berechnet ? "ms:" + m.id() : q == null ? null : q.komponente() + ":" + q.kanal();
                if (spur != null) {
                    Map<LocalDate, KostenstelleEnergieRepository.Version> je = versionen.computeIfAbsent(spur, s -> {
                        Map<LocalDate, KostenstelleEnergieRepository.Version> neueste = new HashMap<>();
                        lesen.versionen(berechnet ? null : q.komponente(), berechnet ? null : q.kanal(),
                                berechnet ? m.id() : null, von, bis, version).forEach(v -> neueste.put(v.tag(), v));
                        return neueste;
                    });
                    KostenstelleEnergieRepository.Version v = je.get(tag);
                    if (v != null && v.version() > tw.version()) {
                        tw = new KostenstelleEnergieRegeln.Tageswert(tag, v.menge(), v.zustand(), v.abdeckungProzent(),
                                v.version(), saetze(v.kennzeichen()));
                        anlass.put(tag, v.anlass());
                    }
                }
            }
            raus.put(tag, tw);
        }
        return raus;
    }

    // ------------------------------------------------------------------------------ Antwort

    private record Herkunft(String kostenstelle, String periode, String schluessel, String berechnetAm, ZoneId zone,
            Map<String, Messstelle> messstellen, Map<String, Map<LocalDate, KostenstelleEnergieRegeln.Tageswert>> tage,
            Map<String, Map<LocalDate, String>> anlaesse,
            Map<String, Map<LocalDate, Map<String, Object>>> tagesHerkunft) {}

    /**
     * Die Herkunft jedes Tageswerts einer BERECHNETEN Messstelle (AP-10 IP-12): der gespeicherte Satz des Tages in der
     * Version, die die Sicht zeigt — Eingänge in DIESER Version, ab Version 2 mit Auslöser. Eine gemessene Messstelle
     * hat keinen; ihr Tag trägt {@code herkunft: null}.
     */
    private Map<LocalDate, Map<String, Object>> tagesHerkunft(Messstelle m,
            Map<LocalDate, KostenstelleEnergieRegeln.Tageswert> tage, LocalDate von, LocalDate bis, ZoneId zone) {
        Map<Instant, LocalDate> tagJeBeginn = new HashMap<>();
        Map<Instant, Map<String, Object>> je = werte.herkunft().umschlaege(m.id(), m.kennzeichen(),
                BerechnetePeriodenRepository.TAG, von.minusDays(1).atStartOfDay(zone).toInstant(),
                bis.plusDays(2).atStartOfDay(zone).toInstant(), zone, f -> {
                    KostenstelleEnergieRegeln.Tageswert tw = f.tag() == null ? null : tage.get(f.tag());
                    if (tw == null) {
                        return null;
                    }
                    tagJeBeginn.put(f.beginn(), f.tag());
                    return new BilanzwertHerkunftLeser.Wert(tw.version(), new BilanzwertHerkunft.Ergebnis(
                            text(tw.menge()), tw.zustand(), tw.abdeckungProzent(), tw.kennzeichen()));
                });
        Map<LocalDate, Map<String, Object>> raus = new HashMap<>();
        je.forEach((beginn, umschlag) -> raus.put(tagJeBeginn.get(beginn), umschlag));
        return raus;
    }

    private static KostenstelleEnergieDto.Block block(KostenstelleEnergieRegeln.Block b, Herkunft h, boolean verteilt) {
        return new KostenstelleEnergieDto.Block(b.menge(), b.einheit(), b.zustand(), b.grund(),
                b.summen().stream().map(s -> new KostenstelleEnergieDto.Summe(s.groesse(), s.richtung(), s.einheit(),
                        s.menge(), s.zustand(), s.abdeckungProzent(), s.vorhanden(), s.gesamt(), s.fehlend())).toList(),
                b.posten().stream().map(p -> posten(p, h, verteilt)).toList());
    }

    private static KostenstelleEnergieDto.Posten posten(KostenstelleEnergieRegeln.Posten p, Herkunft h,
            boolean verteilt) {
        Messstelle m = h.messstellen().get(p.messstelle());
        return new KostenstelleEnergieDto.Posten(
                new KostenstelleEnergieDto.MessstelleRef(m.id(), m.kennzeichen(), m.name(), m.art()),
                p.groesse(), p.richtung(), p.einheit(), p.menge(), p.zustand(), p.abdeckungProzent(), p.version(),
                p.kennzeichen(), p.fassungen(), p.fehlend(),
                p.tage().stream().map(t -> new KostenstelleEnergieDto.Tag(t.tag(), t.anteilProzent(), t.quelleMenge(),
                        t.menge(), t.zustand(), t.abdeckungProzent(), t.version(), t.grund(),
                        h.tagesHerkunft().getOrDefault(p.messstelle(), Map.of()).get(t.tag()))).toList(),
                verteilt ? herkunft(p, h) : null);
    }

    /**
     * Der Herkunfts-Satz eines Postens (E13, {@code bilanzwert-herkunft}): Art {@code verteilt}, Ziel die Kostenstelle,
     * die Verteilungs-Fassung des letzten verteilten Tages, EIN Eingang — die Quelle über dieselben Tage, mit ihrer
     * höchsten Version — und ab Version 2 der Auslöser aus der Version der Quelle.
     */
    private static Map<String, Object> herkunft(KostenstelleEnergieRegeln.Posten p, Herkunft h) {
        Map<LocalDate, KostenstelleEnergieRegeln.Tageswert> quelle = h.tage().getOrDefault(p.messstelle(), Map.of());
        List<KostenstelleEnergieRegeln.Tag> tage = p.tage();
        List<BilanzAbleitung.Summand> summanden = new ArrayList<>();
        LinkedHashSet<String> kennzeichen = new LinkedHashSet<>();
        int quelleVersion = 1;
        for (KostenstelleEnergieRegeln.Tag t : tage) {
            KostenstelleEnergieRegeln.Tageswert tw = quelle.get(t.tag());
            if (tw == null) {
                summanden.add(new BilanzAbleitung.Summand(t.tag().toString(), null, BilanzAbleitung.KEINE_WERTE, null,
                        1, List.of(), "+", BigDecimal.ONE));
                continue;
            }
            summanden.add(new BilanzAbleitung.Summand(t.tag().toString(), tw.menge(), tw.zustand(),
                    tw.abdeckungProzent(), tw.version(), List.of(), "+", BigDecimal.ONE));
            tw.kennzeichen().stream().filter(s -> !ErgebnisZustand.istKorrigiert(s)).forEach(kennzeichen::add);
            quelleVersion = Math.max(quelleVersion, tw.version());
        }
        if (quelleVersion > 1) {
            kennzeichen.add(ErgebnisZustand.korrigiert(quelleVersion));
        }
        BilanzAbleitung.SummeUrteil s = BilanzAbleitung.summeOhneAnzeige(summanden);
        KostenstelleEnergieRegeln.Tag letzter = tage.get(tage.size() - 1);
        String ausloeser = null;
        if (p.version() > 1) {
            KostenstelleEnergieRegeln.Tag erster = tage.stream().filter(t -> t.version() == p.version()).findFirst()
                    .orElse(letzter);
            String anlass = h.anlaesse().getOrDefault(p.messstelle(), Map.of()).get(erster.tag());
            ausloeser = BilanzwertHerkunft.ausloeser(anlass, List.of(p.messstelle()), erster.tag().toString(),
                    p.version());
        }
        BilanzwertHerkunft.Urteil urteil = BilanzwertHerkunft.herkunft(new BilanzwertHerkunft.Eingang(
                BilanzwertHerkunft.VERTEILT, h.kostenstelle(), h.periode(), h.schluessel(), null, null,
                BilanzwertHerkunft.periodeEnde(h.periode(), h.schluessel(), h.zone()), h.berechnetAm(), p.version(),
                ausloeser,
                new BilanzwertHerkunft.Verteilungsbezug(p.fassungen().stream().mapToInt(Integer::intValue).max()
                        .orElse(1), h.kostenstelle(), text(letzter.anteilProzent())),
                List.of(new BilanzwertHerkunft.Eingangswert(p.messstelle(), null, "gesamt",
                        s.vorhanden() == 0 ? null : text(s.menge()), s.zustand(), s.abdeckungProzent(), quelleVersion,
                        List.copyOf(kennzeichen))),
                new BilanzwertHerkunft.Ergebnis(text(p.menge()), p.zustand(), p.abdeckungProzent(), p.kennzeichen())));
        return BilanzwertHerkunft.umschlag(urteil);
    }

    // ------------------------------------------------------------------------------ Gerüst

    private static Integer version(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            int v = Integer.parseInt(text.strip());
            if (v >= 1) {
                return v;
            }
        } catch (NumberFormatException e) {
            // fällt unten durch
        }
        throw BilanzAbgelehnt.anfrage("version", "„version“ ist eine ganze Zahl ab 1.");
    }

    private static String schluessel(String periode, LocalDate von) {
        return switch (periode) {
            case "tag" -> von.toString();
            case "monat" -> YearMonth.from(von).toString();
            default -> String.valueOf(von.getYear());
        };
    }

    private static String text(BigDecimal zahl) {
        return BilanzwertHerkunft.betrag(zahl);
    }

    private static List<String> saetze(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            return JSON.readValue(json, new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new IllegalStateException("Kennzeichen einer Version sind kein JSON-Array: " + json, e);
        }
    }
}
