package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementHistoryService.EnergieAusLeistung;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.measurement.SpeicherklasseHistorie.Verweis;
import com.voltpilot.api.measurement.SpeicherklasseHistorie.Zeile;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Abgelehnt;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Bindung;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Deckung;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Form;
import com.voltpilot.api.uems.MessstelleWerteRegeln.OhneZahl;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Raster;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Reihe;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Schritt;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Zeitraum;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Lese-Modell „Werte je Messstelle“ (UEMS AP-08 IP-9): die erste Fläche, an der ein Kunde seine
 * Verbrauchszahlen abholt. <b>Eine Zahl verlässt diesen Dienst nie ohne ihren Zustand, ihre Abdeckung
 * und ihre Kennzeichen.</b>
 *
 * <p><b>Was hier NICHT gerechnet wird — und woher es kommt:</b>
 * <ul>
 *   <li>Menge, Zustand, Kennzeichen, Abdeckung, vorläufig/endgültig und Version stehen in den
 *       Speicherklassen und werden über den Lesepfad {@link SpeicherklasseHistorie} GELESEN:
 *       Viertelstunde aus {@code messreihe_viertelstunde}, Tag aus {@code messreihe_tag}, Monat und
 *       Jahr aus {@code messreihe_periode} — Tag, Monat und Jahr also aus den PERIODENSTÄNDEN, nie
 *       als Summe der Viertelstunden (F8: 2 304 kWh, die Summe wäre 1 966,4).</li>
 *   <li>Die Stunde ist keine Speicherklasse: sie ist je Schritt der freie Zeitraum der Regel
 *       ({@code ZeitraumMenge.raster} über den Lesepfad), mit ihrer Abdeckung aus Zeitraum und
 *       Kadenz zur Messzeit (§4.5, eine fehlende Viertelstunde zählt mit), vorläufig/endgültig
 *       {@link TagRegeln#zustand}.</li>
 *   <li>Eine Periode OHNE Zeile hat „keine Werte“ — mit 0 erhaltenen von so vielen erwarteten Werten,
 *       wie die Kadenz-Kette zu ihrem Beginn sagt ({@link KadenzRegeln#wirksam}), nie 0 kWh. Liegen
 *       darunter aber Rohwerte oder Viertelstunden, ist sie nur noch nicht gebildet und sagt das.</li>
 *   <li>Sätze spricht dieser Dienst keine: die Kennzeichen sind die gespeicherten des Vertrags
 *       ({@code docs/contracts/v2/ergebnis-zustand.md}), Beschriftung und Tagesdauer kommen aus
 *       {@link ErgebnisZustand#raster} und {@link ErgebnisZustand#tagesdauer}.</li>
 * </ul>
 *
 * <p><b>Nur die Rolle {@code fuehrend}</b> der Hauptgröße liefert — eine Vergleichsquelle oder eine
 * Nebengröße nie. Welche Reihe einen Schritt beantwortet, entscheidet {@link MessstelleWerteRegeln#deckung}.
 *
 * <p><b>Mandantenzaun:</b> alles über die App-Verbindung hinter RLS; eine fremde Messstelle ist nicht
 * zu finden und damit 404, nie 403.
 */
@Service
public class MessstelleWerteService {

    private final JdbcTemplate jdbc;
    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final QuelleKadenzRepository kadenzen;
    private final MesskanalService kanaele;
    private final SpeicherklasseHistorie historie;
    private final BerechnetePeriodenRepository berechnete;

    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleWerteService(JdbcTemplate jdbc, MessstelleRepository messstellen,
            MessstelleQuelleRepository quellen, QuelleKadenzRepository kadenzen, MesskanalService kanaele,
            SpeicherklasseHistorie historie, BerechnetePeriodenRepository berechnete) {
        this.jdbc = jdbc;
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.kadenzen = kadenzen;
        this.kanaele = kanaele;
        this.historie = historie;
        this.berechnete = berechnete;
    }

    /** Nur für Tests: die Uhr, an der die Frist (vorläufig/endgültig) gemessen wird. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public MessstelleWerteDto.Werte werte(String kennzeichen, String raster, String von, String bis,
            String version) {
        Form form = pruefe(() -> MessstelleWerteRegeln.form(raster, von, bis, version));
        UUID tenant = TenantContext.get();
        Messstelle m = messstellen.findeNachKennzeichen(kennzeichen).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        MessstelleRegeln.Groesse haupt = m.hauptgroesse();
        List<Quelle> fuehrend = quellen.derMessstelle(m.id()).stream()
                .filter(q -> "fuehrend".equals(q.rolle()))
                .filter(q -> q.groesse().equals(haupt.groesse()) && q.richtung().equals(haupt.richtung()))
                .toList();
        Zone zone = zone(tenant, fuehrend, form);
        Zeitraum z = pruefe(() -> MessstelleWerteRegeln.zeitraum(form, zone.id()));
        Instant jetzt = uhr.instant();

        List<Bindung> bindungen = fuehrend.stream().map(q -> new Bindung(q.id(), q.entityId(), q.kanal(),
                q.herleitung(), q.anteil(), q.gueltigAb(), q.gueltigBis())).toList();
        List<Quelle> imZeitraum = fuehrend.stream()
                .filter(q -> q.gueltigAb().isBefore(z.bis()) && (q.gueltigBis() == null || q.gueltigBis().isAfter(z.von())))
                .toList();

        Map<Schritt, Deckung> deckung = new LinkedHashMap<>();
        for (Schritt s : z.schritte()) {
            deckung.put(s, "berechnet".equals(m.art()) ? new Deckung(null, null, OhneZahl.BERECHNET)
                    : MessstelleWerteRegeln.deckung(bindungen, s));
        }
        Map<Reihe, Gelesen> gelesen = new HashMap<>();
        deckung.entrySet().stream().filter(e -> e.getValue().reihe() != null)
                .collect(Collectors.groupingBy(e -> e.getValue().reihe(), LinkedHashMap::new,
                        Collectors.mapping(Map.Entry::getKey, Collectors.toList())))
                .forEach((reihe, schritte) -> gelesen.put(reihe, lies(tenant, reihe, z, schritte)));

        Map<Instant, BerechnetePeriodenRepository.Gespeichert> spur = gespeicherteSpur(m, z);
        Beschriftung beschriftung = new Beschriftung(z);
        List<MessstelleWerteDto.Wert> werte = new ArrayList<>();
        for (Map.Entry<Schritt, Deckung> e : deckung.entrySet()) {
            Schritt s = e.getKey();
            Deckung d = e.getValue();
            Rahmen r = new Rahmen(MessstelleWerteRegeln.iso(s.von(), zone.id()),
                    MessstelleWerteRegeln.iso(s.bis(), zone.id()), beschriftung.von(s), stunden(z, s),
                    z.raster() == Raster.TAG ? ErgebnisZustand.tagesdauer(TagRegeln.tag(s.von(), zone.id()), zone.id())
                            : null);
            werte.add(spur != null ? berechnet(r, s, spur.get(s.von()), z, form.version())
                    : d.reihe() == null ? ohneReihe(r, d.grund())
                    : wert(r, s, d, gelesen.get(d.reihe()), z, form.version(), jetzt));
        }

        return new MessstelleWerteDto.Werte(
                new MessstelleWerteDto.Messstelle(m.id(), m.kennzeichen(), m.name(), m.art(), haupt.groesse(),
                        haupt.richtung(), haupt.einheit(), haupt.wertart()),
                z.raster().wort(), MessstelleWerteRegeln.iso(z.von(), zone.id()),
                MessstelleWerteRegeln.iso(z.bis(), zone.id()), zone.id().getId(), zone.herkunft(), form.version(),
                imZeitraum.stream().map(q -> new MessstelleWerteDto.Quelle(q.id(), q.entityId(), q.kanal(),
                        q.herleitung(), q.anteil(), MessstelleWerteRegeln.iso(q.gueltigAb(), zone.id()),
                        q.gueltigBis() == null ? null : MessstelleWerteRegeln.iso(q.gueltigBis(), zone.id()))).toList(),
                List.copyOf(werte));
    }

    // ------------------------------------------------------------------------------ Lesen

    /** Was für EINE Reihe gelesen wurde — über den Lesepfad, ein Zug je Speicherklasse. */
    private record Gelesen(Map<Instant, Zeile> zeilen, Map<Instant, Zeile> viertelstunden, List<Verweis> ereignisse,
            Set<Instant> mitDaten, Integer selektionS, Map<UUID, List<KadenzRegeln.Fassung>> fassungen) {}

    private Gelesen lies(UUID tenant, Reihe reihe, Zeitraum z, List<Schritt> schritte) {
        Instant a = schritte.get(0).von();
        Instant b = schritte.get(schritte.size() - 1).bis();
        UUID e = reihe.entityId();
        String k = reihe.kanal();
        Map<Instant, Zeile> zeilen = new HashMap<>();
        Map<Instant, Zeile> viertel = new HashMap<>();
        switch (z.raster()) {
            case VIERTELSTUNDE -> historie.viertelstunden(tenant, e, k, a, b.minusSeconds(1), 900)
                    .forEach(x -> zeilen.put(x.zeit(), x));
            case STUNDE -> {
                historie.viertelstunden(tenant, e, k, a, b.minusSeconds(1), 3600).forEach(x -> zeilen.put(x.zeit(), x));
                historie.viertelstunden(tenant, e, k, a, b.minusSeconds(1), 900).forEach(x -> viertel.put(x.zeit(), x));
            }
            case TAG -> historie.tage(tenant, e, k, a, b.minusSeconds(1)).forEach(x -> zeilen.put(x.zeit(), x));
            case MONAT, JAHR -> historie.perioden(tenant, e, k, z.raster().wort(), a, b)
                    .forEach(x -> zeilen.put(x.zeit(), x));
        }
        // Welche Perioden ohne Zeile schon etwas darunter tragen — für die Stunde die fehlenden
        // Viertelstunden, sonst die fehlenden Schritte selbst.
        List<Schritt> offen = new ArrayList<>();
        for (Schritt s : schritte) {
            if (z.raster() == Raster.STUNDE) {
                for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
                    if (!viertel.containsKey(q)) {
                        offen.add(new Schritt(q, q.plusSeconds(900)));
                    }
                }
            } else if (!zeilen.containsKey(s.von())) {
                offen.add(s);
            }
        }
        Set<Instant> mitDaten = new HashSet<>(historie.mitDaten(tenant, e, k,
                offen.stream().map(Schritt::von).toList(), offen.stream().map(Schritt::bis).toList()));
        return new Gelesen(zeilen, viertel, historie.ereignisVerweise(tenant, e, k, a, b), mitDaten,
                offen.isEmpty() ? null : selektionS(tenant, e, k), new HashMap<>());
    }

    // ------------------------------------------------------------------ Die Spur berechnet (AP-10 IP-10)

    /**
     * Die gespeicherten Periodenwerte einer BERECHNETEN Messstelle ({@link BerechnetePeriodenLauf}, E6 = A) —
     * {@code null}, wo es keine Spur gibt: eine gemessene Messstelle, eine berechnete mit Momentanwert (nur live)
     * und die Stunde (keine Speicherklasse; dort bleibt der Grund {@code berechnet}).
     */
    private Map<Instant, BerechnetePeriodenRepository.Gespeichert> gespeicherteSpur(Messstelle m, Zeitraum z) {
        if (!MessstelleRegeln.BERECHNET.equals(m.art()) || "Momentanwert".equals(m.hauptgroesse().wertart())
                || z.raster() == Raster.STUNDE) {
            return null;
        }
        return berechnete.gespeichert(m.id(), z.raster().wort(), z.von(), z.bis());
    }

    /**
     * Ein Schritt einer berechneten Messstelle: die gespeicherte Zeile mit Menge, Zustand, Kennzeichen, Abdeckung
     * und vorläufig/endgültig — ohne Zeile ist sie noch nicht gebildet (der Lauf rechnet nach den gemessenen).
     * Eine berechnete Zeile hat keine Rohwerte: {@code erhalten}/{@code erwartet} und {@code quelle} bleiben leer.
     */
    private static MessstelleWerteDto.Wert berechnet(Rahmen r, Schritt s,
            BerechnetePeriodenRepository.Gespeichert zeile, Zeitraum z, Integer version) {
        if (zeile == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG, null,
                    null, null, null, OhneZahl.NOCH_NICHT_GEBILDET.wort(), List.of());
        }
        if (version != null && version != zeile.version()) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, null, null, null, null, null,
                    OhneZahl.VERSION_NICHT_GESPEICHERT.wort(), List.of());
        }
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                zeile.menge(), null, null, null, zeile.mengeZustand(), zeile.kennzeichen(), null, null,
                zeile.abdeckungProzent(), zeile.zustand(), iso(zeile.endgueltigAb(), z.zone()), zeile.version(),
                gebildetAus(z.raster()), null, null, List.of());
    }

    // ------------------------------------------------------------------------ Ein Schritt

    private record Rahmen(String von, String bis, String beschriftung, Long stunden, String tagesdauer) {}

    private MessstelleWerteDto.Wert wert(Rahmen r, Schritt s, Deckung d, Gelesen g, Zeitraum z, Integer version,
            Instant jetzt) {
        Bindung b = d.bindung();
        List<MessstelleWerteDto.Ereignis> ereignisse = ereignisse(g.ereignisse(), s, z.zone());
        Zeile zeile = g.zeilen().get(s.von());
        if (z.raster() == Raster.STUNDE && zeile != null) {
            return stunde(r, s, b, zeile, g, z, version, jetzt, ereignisse);
        }
        if (zeile == null) {
            return ohneZeile(r, s, b, g, z, jetzt, ereignisse);
        }
        if (version != null && !version.equals(zeile.version())) {
            return leer(r, b, OhneZahl.VERSION_NICHT_GESPEICHERT, ereignisse);
        }
        if (zeile.mengeZustand() == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), zeile.erhalten(), zeile.erwartet(),
                    zeile.abdeckungProzent(), zeile.zustand(), iso(zeile.endgueltigAb(), z.zone()), zeile.version(),
                    gebildetAus(z.raster()), b.id(), OhneZahl.OHNE_MENGE_GESPEICHERT.wort(), ereignisse);
        }
        Zahlen n = zahlen(b, zeile);
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                n.menge(), n.mittel(), n.min(), n.max(), zeile.mengeZustand(), kennzeichen(zeile),
                zeile.erhalten(), zeile.erwartet(), zeile.abdeckungProzent(), zeile.zustand(),
                iso(zeile.endgueltigAb(), z.zone()), zeile.version(), gebildetAus(z.raster()), b.id(), null, ereignisse);
    }

    /**
     * Die Stunde: Menge, Zustand, Kennzeichen UND Abdeckung aus dem Lesepfad (er bildet sie je Schritt aus
     * Zeitraum und Kadenz zur Messzeit — eine fehlende Viertelstunde zählt mit ihrer Erwartung, F8 17:00:
     * 29 von 60). Die Viertelstunden liest diese Route nur noch für das, was die Stundenzeile nicht sagt:
     * ob eine davon erst Rohwerte hat (noch nicht gebildet), ob alle dieselbe Version tragen, und
     * vorläufig/endgültig nach {@link TagRegeln#zustand} mit der Frist des Stunden-Endes.
     */
    private MessstelleWerteDto.Wert stunde(Rahmen r, Schritt s, Bindung b, Zeile zeile, Gelesen g, Zeitraum z,
            Integer version, Instant jetzt, List<MessstelleWerteDto.Ereignis> ereignisse) {
        int vorhanden = 0;
        int endgueltig = 0;
        Set<Integer> versionen = new HashSet<>();
        for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
            Zeile v = g.viertelstunden().get(q);
            if (v == null && g.mitDaten().contains(q)) {
                // Eine Viertelstunde der Stunde hat Rohwerte, aber noch keine Zeile: die Stunde ist nicht fertig gebildet.
                return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                        null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG,
                        null, null, null, b.id(), OhneZahl.NOCH_NICHT_GEBILDET.wort(), ereignisse);
            }
            if (v == null) {
                continue;
            }
            vorhanden++;
            endgueltig += ViertelstundeRegeln.ENDGUELTIG.equals(v.zustand()) ? 1 : 0;
            versionen.add(v.version());
        }
        if (version != null && !(versionen.size() == 1 && versionen.contains(version))) {
            return leer(r, b, OhneZahl.VERSION_NICHT_GESPEICHERT, ereignisse);
        }
        String fassung = TagRegeln.zustand(vorhanden, endgueltig, TagRegeln.endgueltigAb(s.bis()), jetzt);
        Instant endgueltigAb = TagRegeln.endgueltigAb(s.bis());
        if (zeile.mengeZustand() == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), zeile.erhalten(), zeile.erwartet(),
                    zeile.abdeckungProzent(), fassung, iso(endgueltigAb, z.zone()),
                    versionen.size() == 1 ? versionen.iterator().next() : null, "zeitraum", b.id(),
                    OhneZahl.OHNE_MENGE_GESPEICHERT.wort(), ereignisse);
        }
        Zahlen n = zahlen(b, zeile);
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                n.menge(), n.mittel(), n.min(), n.max(), zeile.mengeZustand(), kennzeichen(zeile), zeile.erhalten(),
                zeile.erwartet(), zeile.abdeckungProzent(), fassung, iso(endgueltigAb, z.zone()),
                versionen.size() == 1 ? versionen.iterator().next() : null, "zeitraum", b.id(), null, ereignisse);
    }

    /** Ein Schritt ohne gespeicherte Zeile: noch nicht gebildet — oder wirklich „keine Werte“. */
    private MessstelleWerteDto.Wert ohneZeile(Rahmen r, Schritt s, Bindung b, Gelesen g, Zeitraum z, Instant jetzt,
            List<MessstelleWerteDto.Ereignis> ereignisse) {
        boolean darunter = z.raster() == Raster.STUNDE
                ? stundeMitDaten(s, g) : g.mitDaten().contains(s.von());
        if (darunter) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG, null,
                    null, null, b.id(), OhneZahl.NOCH_NICHT_GEBILDET.wort(), ereignisse);
        }
        int erwartet = erwartetOhneZeile(b, g, s.von(), s.bis());
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, ErgebnisZustand.KEINE_WERTE, List.of(), 0, erwartet,
                SpeicherklasseHistorie.abdeckung(0, erwartet),
                TagRegeln.zustand(0, 0, TagRegeln.endgueltigAb(s.bis()), jetzt), null, null, null, b.id(), null,
                ereignisse);
    }

    private static boolean stundeMitDaten(Schritt s, Gelesen g) {
        for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
            if (g.mitDaten().contains(q)) {
                return true;
            }
        }
        return false;
    }

    /** Ein Schritt ohne Reihe: keine Quelle („keine Werte“) oder ein benannter Grund ohne Zustand. */
    private static MessstelleWerteDto.Wert ohneReihe(Rahmen r, OhneZahl grund) {
        String zustand = grund == OhneZahl.KEINE_QUELLE ? ErgebnisZustand.KEINE_WERTE : null;
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, zustand, List.of(), null, null, null, null, null, null, null, null,
                grund.wort(), List.of());
    }

    private static MessstelleWerteDto.Wert leer(Rahmen r, Bindung b, OhneZahl grund,
            List<MessstelleWerteDto.Ereignis> ereignisse) {
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, null, List.of(), null, null, null, null, null, null, null, b.id(),
                grund.wort(), ereignisse);
    }

    private record Zahlen(BigDecimal menge, BigDecimal mittel, BigDecimal min, BigDecimal max) {}

    /**
     * Welche Zahl die Zeile für DIESE Messstelle trägt — jede in der Einheit ihrer Hauptgröße: ein
     * Zählerstand die Menge; eine Integration die Energie, und nur MIT ihrem Kennzeichen „aus Leistung
     * integriert“ ({@link EnergieAusLeistung}); ein Momentanwert Mittel, Min und Max, nie eine Menge.
     */
    private static Zahlen zahlen(Bindung b, Zeile zeile) {
        if ("momentanwert".equals(b.herleitung())) {
            return new Zahlen(null, zeile.wert(), zeile.minimum(), zeile.maximum());
        }
        if ("integration".equals(b.herleitung())) {
            EnergieAusLeistung energie = zeile.energie();
            return new Zahlen(energie == null ? null : energie.wert(), null, null, null);
        }
        return new Zahlen(zeile.wert(), null, null, null);
    }

    private static List<String> kennzeichen(Zeile zeile) {
        return zeile.kennzeichen() == null ? List.of() : zeile.kennzeichen();
    }

    /**
     * Die erwarteten Werte einer Periode OHNE Zeile: Länge ÷ Kadenz ({@code VerbrauchRegeln.erwarteteWerte}),
     * die Kadenz aus der Kette zum Beginn der Periode — Fassung der Bindung → Mess-Selektion → Katalog →
     * 300 s ({@link MesskanalService#kadenz}), dieselbe Kette, die jede gespeicherte Zeile trägt.
     */
    private int erwartetOhneZeile(Bindung b, Gelesen g, Instant von, Instant bis) {
        List<KadenzRegeln.Fassung> fassungen = g.fassungen().computeIfAbsent(b.id(), id ->
                kadenzen.derBindung(id).stream().map(QuelleKadenzRepository.Zeile::fuerRegeln).toList());
        KadenzRegeln.Fassung f = KadenzRegeln.fassungAm(fassungen, von);
        int kadenzS = kanaele.kadenz(b.kanal(), g.selektionS(), f == null ? null : f.erwartetS()).erwartetS();
        return VerbrauchRegeln.erwarteteWerte(von, bis, Duration.ofSeconds(kadenzS));
    }

    /** Die Kadenz der Mess-Selektion der Reihe — nur, wenn sie eindeutig ist; sonst weiter in der Kette. */
    private Integer selektionS(UUID tenant, UUID entity, String kanal) {
        // Kein DISTINCT (SkipScan, siehe SpeicherklasseHistorie.komponente) — entdoppelt wird hier.
        List<Integer> kadenz = jdbc.query("SELECT cadence_s FROM device_measurement_selection WHERE tenant_id = ? "
                + "AND entity_id = ? AND point_key = ? AND cadence_s IS NOT NULL LIMIT 50",
                (rs, n) -> rs.getInt(1), tenant, entity, kanal).stream().distinct().toList();
        return kadenz.size() == 1 ? kadenz.get(0) : null;
    }

    /**
     * Die Verweise, die einen Schritt berühren: ein Zeitraum-Ereignis, wenn es sich mit {@code [von, bis)}
     * überschneidet; ein Zeitpunkt-Ereignis in {@code (von, bis]} — dieselbe Zuordnung wie die Regel der
     * Viertelstunde (ein Wechsel um 10:45 gehört zu 10:30).
     */
    private static List<MessstelleWerteDto.Ereignis> ereignisse(List<Verweis> alle, Schritt s, ZoneId zone) {
        List<MessstelleWerteDto.Ereignis> out = new ArrayList<>();
        for (Verweis v : alle) {
            boolean trifft = v.bis() == null
                    ? v.von().isAfter(s.von()) && !v.von().isAfter(s.bis())
                    : v.von().isBefore(s.bis()) && v.bis().isAfter(s.von());
            if (trifft) {
                out.add(new MessstelleWerteDto.Ereignis(v.ereignisId(), v.art(), MessstelleWerteRegeln.iso(v.von(), zone),
                        v.bis() == null ? null : MessstelleWerteRegeln.iso(v.bis(), zone)));
            }
        }
        return List.copyOf(out);
    }

    // --------------------------------------------------------------------- Zeit und Zone

    private record Zone(ZoneId id, String herkunft) {}

    /**
     * Die Zeitzone der Antwort — dieselbe Kette wie die Tagesklasse (STANDORT der Anlage der Reihe →
     * UNTERNEHMEN → VORGABE), damit die Schritte genau auf den gespeicherten Perioden liegen.
     */
    private Zone zone(UUID tenant, List<Quelle> fuehrend, Form form) {
        Instant stichtag = form.von().zeitpunkt() != null ? form.von().zeitpunkt()
                : form.von().tag().atStartOfDay(ZoneId.of("UTC")).toInstant();
        UUID site = fuehrend.stream()
                .filter(q -> q.gueltigBis() == null || q.gueltigBis().isAfter(stichtag))
                .map(Quelle::siteId).filter(x -> x != null).findFirst()
                .orElse(fuehrend.stream().map(Quelle::siteId).filter(x -> x != null).findFirst().orElse(null));
        if (site != null) {
            List<String> standort = jdbc.queryForList("""
                    SELECT st.zeitzone FROM anlage_standort a
                      JOIN standort st ON st.id = a.standort_id AND st.tenant_id = a.tenant_id
                     WHERE a.tenant_id = ? AND a.site_id = ? AND a.aufgehoben_am IS NULL
                       AND a.gueltig_ab <= ?::date AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= ?::date)
                     ORDER BY a.gueltig_ab DESC LIMIT 1
                    """, String.class, tenant, site, Timestamp.from(stichtag), Timestamp.from(stichtag));
            if (!standort.isEmpty() && TagRegeln.ZONEN.contains(standort.get(0))) {
                return new Zone(TagRegeln.zone(standort.get(0)), TagRegeln.AUS_STANDORT);
            }
        }
        List<String> unternehmen = jdbc.queryForList(
                "SELECT zeitzone FROM unternehmen WHERE tenant_id = ? ORDER BY created_at, id LIMIT 1", String.class, tenant);
        if (!unternehmen.isEmpty() && TagRegeln.ZONEN.contains(unternehmen.get(0))) {
            return new Zone(TagRegeln.zone(unternehmen.get(0)), TagRegeln.AUS_UNTERNEHMEN);
        }
        return new Zone(TagRegeln.zone(TagRegeln.VORGABE_ZONE), TagRegeln.AUS_VORGABE);
    }

    /** Die Stunden eines Tages, Monats oder Jahres — gezählt von der Kette, nie hier. */
    private static Long stunden(Zeitraum z, Schritt s) {
        return switch (z.raster()) {
            case VIERTELSTUNDE, STUNDE -> null;
            case TAG -> (long) TagRegeln.stunden(TagRegeln.tag(s.von(), z.zone()), z.zone());
            case MONAT, JAHR -> VerbrauchRegeln.stunden(s.von(), s.bis());
        };
    }

    /** E10: die Beschriftung der Viertelstunden und Stunden aus {@link ErgebnisZustand#raster}, je Ortstag einmal. */
    private static final class Beschriftung {
        private final Zeitraum z;
        private final Map<LocalDate, Map<String, String>> jeTag = new HashMap<>();

        Beschriftung(Zeitraum z) {
            this.z = z;
        }

        String von(Schritt s) {
            if (z.raster() != Raster.VIERTELSTUNDE && z.raster() != Raster.STUNDE) {
                return null;
            }
            LocalDate tag = TagRegeln.tag(s.von(), z.zone());
            return jeTag.computeIfAbsent(tag, t -> ErgebnisZustand.raster(t, z.zone(), z.raster().wort()).stream()
                            .collect(Collectors.toMap(ErgebnisZustand.Feld::von, ErgebnisZustand.Feld::beschriftung)))
                    .get(MessstelleWerteRegeln.iso(s.von(), z.zone()));
        }
    }

    private static String gebildetAus(Raster r) {
        return r.wort();
    }

    private static String iso(Instant t, ZoneId zone) {
        return t == null ? null : MessstelleWerteRegeln.iso(t, zone);
    }

    private static <T> T pruefe(java.util.function.Supplier<T> regel) {
        try {
            return regel.get();
        } catch (Abgelehnt e) {
            throw MessstelleAbgelehnt.schnittstelle(MessstelleAbgelehnt.Schnittstelle.ANFRAGE_UNGUELTIG,
                    e.getMessage(), MessstelleWerteRegeln.fakten(e.ablehnung()));
        }
    }
}
