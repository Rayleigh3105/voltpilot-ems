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
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
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
    private final BilanzwertHerkunftLeser herkunft;
    private final WertVersionenLeser versionen;

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
        this.herkunft = new BilanzwertHerkunftLeser(berechnete);
        this.versionen = new WertVersionenLeser(jdbc);
    }

    /** Die Herkunft gespeicherter berechneter Werte (AP-10 IP-12) — derselbe Leser für Bilanz und Kostenstelle. */
    BilanzwertHerkunftLeser herkunft() {
        return herkunft;
    }

    /** Nur für Tests: die Uhr, an der die Frist (vorläufig/endgültig) gemessen wird. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public MessstelleWerteDto.Werte werte(String kennzeichen, String raster, String von, String bis,
            String version) {
        return werte(kennzeichen, raster, von, bis, version, versionen);
    }

    /**
     * Die Route {@code GET …/werte}: wie {@link #werte(String, String, String, String, String)}, dazu die Frist (UEMS
     * AP-12 IP-16, B16) — NUR an der Route. Die Leser im Haus (Kostenstellen, Kennzahlen, Bilanz, berechnete Perioden,
     * Bericht-Bildung) lesen eine alte Periode weiter als „keine Werte“ und brechen an ihr nie ab.
     */
    public MessstelleWerteDto.Werte werteDerRoute(String kennzeichen, String raster, String von, String bis,
            String version) {
        Form form = pruefe(() -> MessstelleWerteRegeln.form(raster, von, bis, version));
        Lesung l = lesen(kennzeichen, form, versionen);
        MessstelleWerteDto.Werte antwort = werte(l, form);
        pruefeAufbewahrung(l, form.version());
        return antwort;
    }

    /** Der früheste freigegebene Berichtsstand, der GENAU diese Periode der Messstelle in Version 1 zitiert. */
    private static final String FESTGEHALTEN = "SELECT s.nr, s.freigegeben_am FROM bericht_quelle q "
            + "JOIN bericht_stand s ON s.tenant_id = q.tenant_id AND s.bericht_id = q.bericht_id AND s.nr = q.stand_nr "
            + "WHERE q.tenant_id = ? AND q.objekt_id = ? AND q.art = ? AND q.bezug <> ? AND q.stand_nr IS NOT NULL "
            + "AND q.version = 1 AND q.erster_tag = ? AND q.letzter_tag = ? ORDER BY s.freigegeben_am, s.nr LIMIT 1";

    /**
     * Nach den Fristen (Bericht-Vertrag S4, B16): fragt die Anfrage GENAU EINE Periode — Monat oder Jahr, die Perioden,
     * die ein Bericht zitiert — einer gemessenen Reihe in Version 1 (angefragt oder als neueste), und liegt sie jenseits
     * der Aufbewahrung ohne Zeile und ohne etwas darunter, ist sie nicht mehr gespeichert: 404
     * {@code wert_nicht_mehr_gespeichert} mit dem Berichtsstand, der sie festhält ({@code FESTGEHALTEN}; eine mittelbare
     * Quelle zählt nicht, ihr Wert steht nicht als Zahl im Abzug). Eine Version ab 2 hat keine Frist und antwortet weiter;
     * innerhalb der Aufbewahrung bleibt eine Periode ohne Zeile „keine Werte“.
     */
    private void pruefeAufbewahrung(Lesung l, Integer version) {
        Zeitraum z = l.z();
        if (l.spur() != null || l.deckung().size() != 1 || (z.raster() != Raster.MONAT && z.raster() != Raster.JAHR)) {
            return;
        }
        Map.Entry<Schritt, Deckung> e = l.deckung().entrySet().iterator().next();
        Schritt s = e.getKey();
        Reihe reihe = e.getValue().reihe();
        if (reihe == null || !MessstelleWerteRegeln.jenseitsDerAufbewahrung(s.von(), l.jetzt())) {
            return;
        }
        Gelesen g = l.gelesen().get(reihe);
        if (g.zeilen().containsKey(s.von()) || g.mitDaten().contains(s.von())
                || WertVersionenRegeln.wahl(nummern(g.versionen().getOrDefault(s.von(), List.of())), version)
                        .version() != 1) {
            return;
        }
        ZoneId zone = l.zone().id();
        LocalDate ersterTag = s.von().atZone(zone).toLocalDate();
        String schluessel = z.raster() == Raster.MONAT ? YearMonth.from(ersterTag).toString()
                : String.valueOf(ersterTag.getYear());
        List<Map.Entry<Integer, Instant>> staende = jdbc.query(FESTGEHALTEN,
                (rs, i) -> Map.entry(rs.getInt("nr"), rs.getTimestamp("freigegeben_am").toInstant()), l.tenant(),
                l.m().id(), BerichtRegeln.QUELLE_ARTEN.get(0), BerichtRegeln.MITTELBAR, ersterTag,
                s.bis().atZone(zone).toLocalDate().minusDays(1));
        Map.Entry<Integer, Instant> stand = staende.isEmpty() ? null : staende.get(0);
        throw new MessstelleWerteRegeln.WertNichtMehrGespeichert(z.raster().wort(), schluessel,
                stand == null ? null : stand.getKey(), stand == null ? null : stand.getValue(), zone);
    }

    /**
     * Wie {@link #werte(String, String, String, String, String)}, die Versionen ab 2 aber aus {@code versionen} — der
     * Korrektur-Kaskade (AP-11 IP-8), die sie in IHRER Transaktion eben geschrieben hat. Version 1, die Quellen und die
     * Einstellungen ändert keine Kaskade; sie liest weiter der Kundenbereich über Row-Level-Security.
     */
    MessstelleWerteDto.Werte werte(String kennzeichen, String raster, String von, String bis, String version,
            WertVersionenLeser versionen) {
        Form form = pruefe(() -> MessstelleWerteRegeln.form(raster, von, bis, version));
        return werte(lesen(kennzeichen, form, versionen), form);
    }

    /**
     * Die Werte einer Messstelle, deren Mandanten der Aufrufer AUSDRÜCKLICH nennt — stets die neueste Version (UEMS
     * AP-12 IP-5). Die Bildung eines Berichts-Abzugs liest über die Verbindung ihres Aufrufers; die Kaskade hält eine
     * der Verwaltungsrolle, an der keine RLS filtert — darum nie über das Kennzeichen allein ({@link BerichtAbzugBildung}).
     * Die Versionen liest der Leser dieses Dienstes, also dieselbe Verbindung.
     */
    MessstelleWerteDto.Werte werte(UUID tenant, Messstelle m, String raster, String von, String bis) {
        return werte(tenant, m, raster, von, bis, null);
    }

    /**
     * Wie {@link #werte(UUID, Messstelle, String, String, String)}, mit {@code version} wie die Route ({@code null} =
     * die neueste) — die Kostenstellen-Sicht fragt Version 1 und legt die späteren selbst darüber (UEMS AP-12 IP-6).
     */
    MessstelleWerteDto.Werte werte(UUID tenant, Messstelle m, String raster, String von, String bis, String version) {
        Form form = pruefe(() -> MessstelleWerteRegeln.form(raster, von, bis, version));
        return werte(lesen(tenant, m, form, versionen), form);
    }

    private MessstelleWerteDto.Werte werte(Lesung l, Form form) {
        Zeitraum z = l.z();
        Zone zone = l.zone();

        // Eine Version, die es an keinem Schritt gibt, ist eine benannte Ablehnung — nie leer, nie die höchste.
        int hoechste = 1;
        for (Map.Entry<Schritt, Deckung> e : l.deckung().entrySet()) {
            hoechste = Math.max(hoechste, hoechsteVersion(l, e.getKey(), e.getValue()));
        }
        WertVersionenRegeln.pruefeVorhanden(form.version(), hoechste);

        Map<Instant, Map<String, Object>> herkuenfte = herkuenfte(l, beginn -> {
            WertVersionenRegeln.Wahl w = WertVersionenRegeln.wahl(
                    nummern(l.spurVersionen().getOrDefault(beginn, List.of())), form.version());
            return w.gespeichert() ? w.version() : null;
        });
        List<MessstelleWerteDto.Wert> werte = new ArrayList<>();
        for (Map.Entry<Schritt, Deckung> e : l.deckung().entrySet()) {
            werte.add(schritt(l, e.getKey(), e.getValue(), form.version(), herkuenfte));
        }

        return new MessstelleWerteDto.Werte(
                new MessstelleWerteDto.Messstelle(l.m().id(), l.m().kennzeichen(), l.m().name(), l.m().art(),
                        l.haupt().groesse(), l.haupt().richtung(), l.haupt().einheit(), l.haupt().wertart()),
                z.raster().wort(), MessstelleWerteRegeln.iso(z.von(), zone.id()),
                MessstelleWerteRegeln.iso(z.bis(), zone.id()), zone.id().getId(), zone.herkunft(), form.version(),
                quellen(l), List.copyOf(werte));
    }

    /**
     * Die Versions-Historie EINER Periode (AP-08 IP-18): je Version der Wert, genau wie {@code version=n} ihn zeigt,
     * der Wert davor, und die Entscheidungen, die sie ausmachen — wer, wann, warum, aus den Fassungen der Vorgänge
     * gelesen. Version 1 ist die Zahl der Verdichtung. Eine Periode ohne Korrektur hat genau eine Version.
     */
    public MessstelleWerteDto.Historie historie(String kennzeichen, String raster, String von, String bis) {
        Form form = pruefe(() -> MessstelleWerteRegeln.historieForm(raster, von, bis));
        Lesung l = lesen(kennzeichen, form, versionen);
        Schritt s = pruefe(() -> MessstelleWerteRegeln.einePeriode(l.z()));
        Deckung d = l.deckung().get(s);
        ZoneId zone = l.zone().id();
        MessstelleWerteDto.Messstelle messstelle = new MessstelleWerteDto.Messstelle(l.m().id(), l.m().kennzeichen(),
                l.m().name(), l.m().art(), l.haupt().groesse(), l.haupt().richtung(), l.haupt().einheit(),
                l.haupt().wertart());

        MessstelleWerteDto.Wert neueste = wertIn(l, s, d, null);
        List<MessstelleWerteDto.Version> liste = new ArrayList<>();
        String grund = null;
        if (neueste.versionen() == null) {
            // Die Periode gehört der Messstelle nicht (ganz) oder ist noch nicht gebildet: keine Version, der Grund steht da.
            grund = neueste.grund();
        } else {
            List<WertVersionenLeser.Version> spaetere = spaetereVersionen(l, s, d);
            Set<String> kennungen = new LinkedHashSet<>();
            spaetere.forEach(v -> {
                kennungen.addAll(v.wirkt());
                kennungen.add(v.anlassKennung());
            });
            List<WertVersionenLeser.Fassung> fassungen = kennungen.isEmpty() ? List.of()
                    : versionen.fassungen(l.tenant(), kennungen);
            List<WertVersionenRegeln.Fassung> fuerRegeln = fassungen.stream()
                    .map(WertVersionenLeser.Fassung::fuerRegeln).toList();
            MessstelleWerteDto.Wert vorher = null;
            List<String> wirkteVorher = List.of();
            for (int n = 1; n <= neueste.versionen(); n++) {
                MessstelleWerteDto.Wert wert = wertIn(l, s, d, n);
                if (n == 1) {
                    liste.add(new MessstelleWerteDto.Version(1, null, wert, iso(ersteGebildet(l, s, d), zone), null,
                            null, List.of()));
                } else {
                    WertVersionenLeser.Version v = finde(spaetere, n);
                    List<MessstelleWerteDto.Entscheidung> entscheidungen = WertVersionenRegeln.entscheidungen(
                                    wirkteVorher, v.wirkt(),
                                    new WertVersionenRegeln.Schluessel(v.anlassKennung(), v.anlassFassung()),
                                    fuerRegeln, v.gebildetAm())
                            .stream().map(k -> entscheidung(k, fassungen, zone)).toList();
                    liste.add(new MessstelleWerteDto.Version(n, vorher, wert, iso(v.gebildetAm(), zone),
                            iso(v.nachgezogenAm(), zone), new MessstelleWerteDto.Anlass(v.anlassKennung(),
                                    v.anlassFassung()), entscheidungen));
                    wirkteVorher = v.wirkt();
                }
                vorher = wert;
            }
        }
        return new MessstelleWerteDto.Historie(messstelle, l.z().raster().wort(), MessstelleWerteRegeln.iso(s.von(), zone),
                MessstelleWerteRegeln.iso(s.bis(), zone), zone.getId(), l.zone().herkunft(), grund, List.copyOf(liste));
    }

    // ------------------------------------------------------------------------------ Lesen

    /** Was eine Anfrage liest, bevor ein Schritt eine Version wählt — für Werte und Historie derselbe Zug. */
    private record Lesung(UUID tenant, Messstelle m, MessstelleRegeln.Groesse haupt, Zone zone, Zeitraum z,
            Instant jetzt, List<Quelle> imZeitraum, Map<Schritt, Deckung> deckung, Map<Reihe, Gelesen> gelesen,
            Map<Instant, BerechnetePeriodenRepository.Gespeichert> spur,
            Map<Instant, List<WertVersionenLeser.Version>> spurVersionen, Beschriftung beschriftung, UUID ablesung,
            List<AblesungRepository.Wert> ablesewerte) {}

    private Lesung lesen(String kennzeichen, Form form, WertVersionenLeser versionen) {
        UUID tenant = TenantContext.get();
        Messstelle m = messstellen.findeNachKennzeichen(kennzeichen).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        return lesen(tenant, m, form, versionen);
    }

    private Lesung lesen(UUID tenant, Messstelle m, Form form, WertVersionenLeser versionen) {
        MessstelleRegeln.Groesse haupt = m.hauptgroesse();
        List<Quelle> fuehrend = fuehrend(m);
        AblesungRepository ablesungen = new AblesungRepository(jdbc);
        UUID ablesung = ablesungen.quelle(tenant, m.id());
        Zone zone = zone(tenant, fuehrend, form);
        if (ablesung != null) {
            Instant t = form.von().zeitpunkt() != null ? form.von().zeitpunkt()
                    : form.von().tag().atStartOfDay(zone.id()).toInstant();
            var az = ablesungen.zone(tenant, m.id(), t);
            zone = new Zone(az.id(), az.herkunft());
        }
        Zone gewaehlteZone = zone;
        Zeitraum z = pruefe(() -> MessstelleWerteRegeln.zeitraum(form, gewaehlteZone.id()));
        Instant jetzt = uhr.instant();

        List<Bindung> bindungen = bindungen(fuehrend);
        List<Quelle> imZeitraum = imZeitraum(fuehrend, z.von(), z.bis());

        Map<Schritt, Deckung> deckung = new LinkedHashMap<>();
        for (Schritt s : z.schritte()) {
            deckung.put(s, "berechnet".equals(m.art()) ? new Deckung(null, null, OhneZahl.BERECHNET)
                    : MessstelleWerteRegeln.deckung(bindungen, s));
        }
        Map<Reihe, Gelesen> gelesen = new HashMap<>();
        deckung.entrySet().stream().filter(e -> e.getValue().reihe() != null)
                .collect(Collectors.groupingBy(e -> e.getValue().reihe(), LinkedHashMap::new,
                        Collectors.mapping(Map.Entry::getKey, Collectors.toList())))
                .forEach((reihe, schritte) -> gelesen.put(reihe, lies(tenant, reihe, z, schritte, versionen)));

        Map<Instant, BerechnetePeriodenRepository.Gespeichert> spur = gespeicherteSpur(m, z, ablesung != null);
        Map<Instant, List<WertVersionenLeser.Version>> spurVersionen = spur == null ? Map.of()
                : versionen.perioden(tenant, z.raster().wort(), null, null, m.id(), z.von(), z.bis());
        return new Lesung(tenant, m, haupt, zone, z, jetzt, imZeitraum, deckung, gelesen, spur, spurVersionen,
                new Beschriftung(z), ablesung, ablesung == null ? List.of() : ablesungen.werte(tenant, ablesung));
    }

    private static List<MessstelleWerteDto.Quelle> quellen(Lesung l) {
        return quellen(l.imZeitraum(), l.zone().id());
    }

    private static List<MessstelleWerteDto.Quelle> quellen(List<Quelle> imZeitraum, ZoneId zone) {
        return imZeitraum.stream().map(q -> new MessstelleWerteDto.Quelle(q.id(), q.entityId(), q.kanal(),
                q.herleitung(), q.anteil(), MessstelleWerteRegeln.iso(q.gueltigAb(), zone),
                q.gueltigBis() == null ? null : MessstelleWerteRegeln.iso(q.gueltigBis(), zone))).toList();
    }

    /** Die führenden Bindungen der Hauptgröße — eine Vergleichsquelle oder eine Nebengröße liefert nie. */
    private List<Quelle> fuehrend(Messstelle m) {
        MessstelleRegeln.Groesse haupt = m.hauptgroesse();
        return quellen.derMessstelle(m.id()).stream()
                .filter(q -> "fuehrend".equals(q.rolle()))
                .filter(q -> q.groesse().equals(haupt.groesse()) && q.richtung().equals(haupt.richtung()))
                .toList();
    }

    private static List<Bindung> bindungen(List<Quelle> fuehrend) {
        return fuehrend.stream().map(q -> new Bindung(q.id(), q.entityId(), q.kanal(), q.herleitung(), q.anteil(),
                q.gueltigAb(), q.gueltigBis())).toList();
    }

    private static List<Quelle> imZeitraum(List<Quelle> fuehrend, Instant von, Instant bis) {
        return fuehrend.stream()
                .filter(q -> q.gueltigAb().isBefore(bis) && (q.gueltigBis() == null || q.gueltigBis().isAfter(von)))
                .toList();
    }

    // ------------------------------------------------------------------ Die Woche einer Kennzahl (AP-11 IP-12)

    /**
     * Die Wochen einer Messstelle für den Kennzahl-Leser (UEMS AP-11 IP-12, P5) — kein Raster der Route. Je Woche
     * Montag 00:00 bis Montag 00:00 in der Zeitzone des Standorts ({@link MessstelleWerteRegeln#woche}, 167/168/169
     * Stunden), ihre Menge der freie Zeitraum der Regel ({@link ZeitraumMenge#zeitraum} über den Lesepfad): aus den
     * Periodenständen an den Wochengrenzen, nie als Summe der Tage. Welche Reihe die Woche beantwortet, entscheidet
     * {@link MessstelleWerteRegeln#deckung} wie an jedem anderen Schritt.
     *
     * <p>Die Woche ist keine Speicherklasse — wie die Stunde: trägt eine ihrer Viertelstunden eine spätere Version,
     * steht keine Zahl da ({@code version_nicht_gebildet}), nie die von Version 1 unter einem anderen Etikett; eine
     * berechnete Messstelle hat keine Wochen-Spur ({@code berechnet}).
     *
     * @param von ein Tag der ersten Woche, {@code bis} ein Tag der letzten
     * @param versionen die Versionen ab 2 — {@code null}: die des Lesemodells (Kundenbereich)
     */
    MessstelleWerteDto.Werte wochen(String kennzeichen, LocalDate von, LocalDate bis, WertVersionenLeser versionen) {
        UUID tenant = TenantContext.get();
        Messstelle m = messstellen.findeNachKennzeichen(kennzeichen).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        WertVersionenLeser spaetere = versionen == null ? this.versionen : versionen;
        List<Quelle> fuehrend = fuehrend(m);
        Zone zone = zone(tenant, fuehrend, von.atStartOfDay(ZoneId.of("UTC")).toInstant());
        List<Bindung> bindungen = bindungen(fuehrend);
        Instant jetzt = uhr.instant();
        List<MessstelleWerteDto.Wert> werte = new ArrayList<>();
        for (LocalDate montag = BezugsPeriode.spanneUm(von, "woche")[0]; !montag.isAfter(bis);
                montag = montag.plusDays(7)) {
            Schritt s = MessstelleWerteRegeln.woche(montag, zone.id());
            Rahmen r = new Rahmen(MessstelleWerteRegeln.iso(s.von(), zone.id()),
                    MessstelleWerteRegeln.iso(s.bis(), zone.id()),
                    KennzahlRegeln.periodeText("woche", BezugsPeriode.schluesselVon(montag, "woche")),
                    VerbrauchRegeln.stunden(s.von(), s.bis()), null);
            Deckung d = "berechnet".equals(m.art()) ? new Deckung(null, null, OhneZahl.BERECHNET)
                    : MessstelleWerteRegeln.deckung(bindungen, s);
            werte.add(d.reihe() == null ? ohneReihe(r, d.grund()) : woche(r, s, d, tenant, spaetere, jetzt, zone.id()));
        }
        Instant ab = MessstelleWerteRegeln.woche(von, zone.id()).von();
        Instant ende = MessstelleWerteRegeln.woche(bis, zone.id()).bis();
        MessstelleRegeln.Groesse haupt = m.hauptgroesse();
        return new MessstelleWerteDto.Werte(
                new MessstelleWerteDto.Messstelle(m.id(), m.kennzeichen(), m.name(), m.art(), haupt.groesse(),
                        haupt.richtung(), haupt.einheit(), haupt.wertart()),
                "woche", MessstelleWerteRegeln.iso(ab, zone.id()), MessstelleWerteRegeln.iso(ende, zone.id()),
                zone.id().getId(), zone.herkunft(), null, quellen(imZeitraum(fuehrend, ab, ende), zone.id()),
                List.copyOf(werte));
    }

    /** Eine Woche mit ihrer Reihe: der freie Zeitraum der Regel — ohne Zahl, wenn eine Viertelstunde später korrigiert ist. */
    private MessstelleWerteDto.Wert woche(Rahmen r, Schritt s, Deckung d, UUID tenant, WertVersionenLeser versionen,
            Instant jetzt, ZoneId zone) {
        Bindung b = d.bindung();
        Reihe reihe = d.reihe();
        if (versionen.viertelstunden(tenant, reihe.entityId(), reihe.kanal(), s.von(), s.bis()).values().stream()
                .anyMatch(v -> !v.isEmpty())) {
            return leer(r, b, OhneZahl.VERSION_NICHT_GEBILDET, List.of(), null);
        }
        ZeitraumMenge.Zeitraum z = historie.zeitraum(tenant, reihe.entityId(), reihe.kanal(), s.von(), s.bis(), jetzt);
        VerbrauchRegeln.Ergebnis e = z.menge() == null ? null : z.menge().ergebnis();
        // Wie zahlen(): eine Menge hat nur der Zählerstand — Momentanwert und Energie aus Leistung bildet der Zeitraum nicht.
        boolean menge = e != null && !"momentanwert".equals(b.herleitung()) && !"integration".equals(b.herleitung());
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                menge ? e.menge() : null, null, null, null, menge ? e.zustand() : null,
                menge && e.kennzeichen() != null ? e.kennzeichen() : List.of(), z.erhalten(), z.erwartet(),
                z.abdeckungProzent(), z.zustand(), MessstelleWerteRegeln.iso(TagRegeln.endgueltigAb(s.bis()), zone),
                z.viertelstundenVorhanden() == 0 ? null : 1, "zeitraum", b.id(), null, List.of(), null, null);
    }

    /** Was für EINE Reihe gelesen wurde — über den Lesepfad, ein Zug je Speicherklasse, dazu ihre Versionen ab 2. */
    private record Gelesen(Map<Instant, Zeile> zeilen, Map<Instant, Zeile> viertelstunden, List<Verweis> ereignisse,
            Set<Instant> mitDaten, Integer selektionS, Map<UUID, List<KadenzRegeln.Fassung>> fassungen,
            Map<Instant, List<WertVersionenLeser.Version>> versionen) {}

    private Gelesen lies(UUID tenant, Reihe reihe, Zeitraum z, List<Schritt> schritte, WertVersionenLeser versionen) {
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
        // Die Versionen ab 2 (Ersatzwert-Lauf, Kaskade): je Periode; die Stunde fragt ihre Viertelstunden.
        Map<Instant, List<WertVersionenLeser.Version>> spaetere = switch (z.raster()) {
            case VIERTELSTUNDE, STUNDE -> versionen.viertelstunden(tenant, e, k, a, b);
            case TAG, MONAT, JAHR -> versionen.perioden(tenant, z.raster().wort(), e, k, null, a, b);
        };
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
                offen.isEmpty() ? null : selektionS(tenant, e, k), new HashMap<>(), spaetere);
    }

    // ------------------------------------------------------------------ Die Spur berechnet (AP-10 IP-10)

    /**
     * Die gespeicherten Periodenwerte einer BERECHNETEN Messstelle ({@link BerechnetePeriodenLauf}, E6 = A) —
     * {@code null}, wo es keine Spur gibt: eine gemessene Messstelle, eine berechnete mit Momentanwert (nur live)
     * und die Stunde (keine Speicherklasse; dort bleibt der Grund {@code berechnet}).
     */
    private Map<Instant, BerechnetePeriodenRepository.Gespeichert> gespeicherteSpur(Messstelle m, Zeitraum z, boolean ablesung) {
        if (ablesung) return z.raster() == Raster.MONAT || z.raster() == Raster.JAHR
                ? berechnete.gespeichert(m.id(), z.raster().wort(), z.von(), z.bis()) : null;
        if (!MessstelleRegeln.BERECHNET.equals(m.art()) || "Momentanwert".equals(m.hauptgroesse().wertart())
                || z.raster() == Raster.STUNDE) {
            return null;
        }
        return berechnete.gespeichert(m.id(), z.raster().wort(), z.von(), z.bis());
    }

    /**
     * Die Herkunft je Beginn der Spur (AP-10 IP-12) — für die Version, die der Schritt zeigt ({@code version} je
     * Beginn, {@code null} = keine Zahl): ab Version 2 mit den Eingängen DIESER Version und ihrem Anlass.
     */
    private Map<Instant, Map<String, Object>> herkuenfte(Lesung l, Function<Instant, Integer> version) {
        if (l.ablesung() != null || l.spur() == null || (l.spur().isEmpty() && l.spurVersionen().isEmpty())) {
            return Map.of();
        }
        return herkunft.umschlaege(l.m().id(), l.m().kennzeichen(), l.z().raster().wort(), l.z().von(), l.z().bis(),
                l.zone().id(), f -> {
                    Integer v = version.apply(f.beginn());
                    if (v == null) {
                        return null;
                    }
                    if (v == 1) {
                        BerechnetePeriodenRepository.Gespeichert g = l.spur().get(f.beginn());
                        return g == null ? null : new BilanzwertHerkunftLeser.Wert(1, new BilanzwertHerkunft.Ergebnis(
                                BilanzwertHerkunft.betrag(g.menge()), g.mengeZustand(), g.abdeckungProzent(),
                                g.kennzeichen()));
                    }
                    WertVersionenLeser.Version x = finde(l.spurVersionen().getOrDefault(f.beginn(), List.of()), v);
                    return x == null ? null : new BilanzwertHerkunftLeser.Wert(v, new BilanzwertHerkunft.Ergebnis(
                            BilanzwertHerkunft.betrag(x.menge()), x.mengeZustand(), x.abdeckungProzent(),
                            x.kennzeichen()));
                });
    }

    /**
     * Ein Schritt einer berechneten Messstelle: die gespeicherte Zeile (Version 1) oder ihre Version ab 2 mit Menge,
     * Zustand, Kennzeichen, Abdeckung und vorläufig/endgültig — ohne jede Zeile ist sie noch nicht gebildet (der Lauf
     * rechnet nach den gemessenen). Eine berechnete Zeile hat keine Rohwerte: {@code erhalten}/{@code erwartet} und
     * {@code quelle} bleiben leer.
     */
    private static MessstelleWerteDto.Wert berechnet(Rahmen r, BerechnetePeriodenRepository.Gespeichert zeile,
            List<WertVersionenLeser.Version> spaetere, Zeitraum z, Integer version, Map<String, Object> herkunft) {
        if (zeile == null && spaetere.isEmpty()) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG, null,
                    null, null, null, OhneZahl.NOCH_NICHT_GEBILDET.wort(), List.of(), null, null);
        }
        WertVersionenRegeln.Wahl w = WertVersionenRegeln.wahl(nummern(spaetere), version);
        if (!w.gespeichert()) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, null, null, null, null, null,
                    OhneZahl.VERSION_NICHT_GESPEICHERT.wort(), List.of(), null, w.hoechste());
        }
        String endgueltigAb = zeile == null ? null : iso(zeile.endgueltigAb(), z.zone());
        if (w.version() > 1) {
            WertVersionenLeser.Version v = finde(spaetere, w.version());
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    v.menge(), null, null, null, v.mengeZustand(), v.kennzeichen(), null, null, v.abdeckungProzent(),
                    v.zustand(), endgueltigAb, v.version(), gebildetAus(z.raster()), null, null, List.of(), herkunft,
                    w.hoechste());
        }
        if (zeile == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG, null,
                    null, null, null, OhneZahl.NOCH_NICHT_GEBILDET.wort(), List.of(), null, w.hoechste());
        }
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                zeile.menge(), null, null, null, zeile.mengeZustand(), zeile.kennzeichen(), null, null,
                zeile.abdeckungProzent(), zeile.zustand(), endgueltigAb, zeile.version(), gebildetAus(z.raster()), null,
                null, List.of(), herkunft, w.hoechste());
    }

    // ------------------------------------------------------------------------ Ein Schritt

    private record Rahmen(String von, String bis, String beschriftung, Long stunden, String tagesdauer) {}

    private MessstelleWerteDto.Wert schritt(Lesung l, Schritt s, Deckung d, Integer version,
            Map<Instant, Map<String, Object>> herkuenfte) {
        Zeitraum z = l.z();
        ZoneId zone = l.zone().id();
        Rahmen r = new Rahmen(MessstelleWerteRegeln.iso(s.von(), zone), MessstelleWerteRegeln.iso(s.bis(), zone),
                l.beschriftung().von(s), stunden(z, s),
                z.raster() == Raster.TAG ? ErgebnisZustand.tagesdauer(TagRegeln.tag(s.von(), zone), zone) : null);
        if (l.ablesung() != null && l.spur() != null && !l.spur().containsKey(s.von())
                && l.spurVersionen().getOrDefault(s.von(), List.of()).isEmpty()) {
            if (d.reihe() != null) return wert(r, s, d, l.gelesen().get(d.reihe()), z, version, l.jetzt());
            boolean ohneZuordnung = false;
            for (int i = 1; i < l.ablesewerte().size(); i++) {
                var a = l.ablesewerte().get(i - 1);
                var b = l.ablesewerte().get(i);
                if (b.monat() == null && a.zeitpunkt().isBefore(s.bis()) && b.zeitpunkt().isAfter(s.von())) {
                    ohneZuordnung = true;
                    break;
                }
            }
            return ohneReihe(r, OhneZahl.KEINE_QUELLE, ohneZuordnung
                    ? List.of("Ablesezeitraum ohne Monatszuordnung") : List.of());
        }
        if (l.spur() != null) {
            return berechnet(r, l.spur().get(s.von()), l.spurVersionen().getOrDefault(s.von(), List.of()), z, version,
                    herkuenfte.get(s.von()));
        }
        return d.reihe() == null ? ohneReihe(r, d.grund())
                : wert(r, s, d, l.gelesen().get(d.reihe()), z, version, l.jetzt());
    }

    /** Ein Schritt in genau einer Version — {@code null} = die neueste; für die Historie je Version einzeln. */
    private MessstelleWerteDto.Wert wertIn(Lesung l, Schritt s, Deckung d, Integer version) {
        Map<Instant, Map<String, Object>> herkuenfte = herkuenfte(l, beginn -> {
            WertVersionenRegeln.Wahl w = WertVersionenRegeln.wahl(
                    nummern(l.spurVersionen().getOrDefault(beginn, List.of())), version);
            return beginn.equals(s.von()) && w.gespeichert() ? w.version() : null;
        });
        return schritt(l, s, d, version, herkuenfte);
    }

    /** Die gespeicherten Versionen ab 2 eines Schritts, älteste zuerst. */
    private static List<WertVersionenLeser.Version> spaetereVersionen(Lesung l, Schritt s, Deckung d) {
        if (l.spur() != null) {
            return l.spurVersionen().getOrDefault(s.von(), List.of());
        }
        return d.reihe() == null ? List.of()
                : l.gelesen().get(d.reihe()).versionen().getOrDefault(s.von(), List.of());
    }

    /** Die neueste Version eines Schritts — an der Stunde die ihrer Viertelstunden (sie selbst hat keine). */
    private static int hoechsteVersion(Lesung l, Schritt s, Deckung d) {
        if (l.spur() == null && d.reihe() != null && l.z().raster() == Raster.STUNDE) {
            return hoechsteDerViertelstunden(l.gelesen().get(d.reihe()), s);
        }
        return WertVersionenRegeln.wahl(nummern(spaetereVersionen(l, s, d)), null).hoechste();
    }

    private static int hoechsteDerViertelstunden(Gelesen g, Schritt s) {
        int hoechste = 1;
        for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
            hoechste = Math.max(hoechste, WertVersionenRegeln.wahl(
                    nummern(g.versionen().getOrDefault(q, List.of())), null).hoechste());
        }
        return hoechste;
    }

    /** Wann die Verdichtung Version 1 des Schritts gebildet hat — {@code null} ohne Zeile. */
    private Instant ersteGebildet(Lesung l, Schritt s, Deckung d) {
        if (l.spur() != null) {
            return versionen.ersteGebildet(l.tenant(), l.z().raster().wort(), null, null, l.m().id(), s.von());
        }
        return versionen.ersteGebildet(l.tenant(), l.z().raster().wort(), d.reihe().entityId(), d.reihe().kanal(), null,
                s.von());
    }

    private MessstelleWerteDto.Wert wert(Rahmen r, Schritt s, Deckung d, Gelesen g, Zeitraum z, Integer version,
            Instant jetzt) {
        Bindung b = d.bindung();
        List<MessstelleWerteDto.Ereignis> ereignisse = ereignisse(g.ereignisse(), s, z.zone());
        Zeile zeile = g.zeilen().get(s.von());
        if (z.raster() == Raster.STUNDE) {
            // Die Stunde hat keine eigenen Versionen: trägt eine Viertelstunde eine spätere, als die gefragte Zahl
            // der Stunde gebildet wäre, steht keine Zahl da — nie die von Version 1 unter einem anderen Etikett.
            int spaetere = hoechsteDerViertelstunden(g, s);
            int gefragt = version == null ? spaetere : version;
            if (gefragt > 1) {
                return leer(r, b, spaetere >= gefragt ? OhneZahl.VERSION_NICHT_GEBILDET
                        : OhneZahl.VERSION_NICHT_GESPEICHERT, ereignisse, null);
            }
            return zeile != null ? stunde(r, s, b, zeile, g, z, jetzt, ereignisse)
                    : ohneZeile(r, s, b, g, z, jetzt, ereignisse, null);
        }
        List<WertVersionenLeser.Version> spaetere = g.versionen().getOrDefault(s.von(), List.of());
        WertVersionenRegeln.Wahl w = WertVersionenRegeln.wahl(nummern(spaetere), version);
        if (!w.gespeichert()) {
            return leer(r, b, OhneZahl.VERSION_NICHT_GESPEICHERT, ereignisse, w.hoechste());
        }
        if (w.version() > 1) {
            return ausVersion(r, s, b, zeile, finde(spaetere, w.version()), g, z, jetzt, ereignisse, w.hoechste());
        }
        if (zeile == null) {
            return ohneZeile(r, s, b, g, z, jetzt, ereignisse, w.hoechste());
        }
        if (zeile.mengeZustand() == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), zeile.erhalten(), zeile.erwartet(),
                    zeile.abdeckungProzent(), zeile.zustand(), iso(zeile.endgueltigAb(), z.zone()), zeile.version(),
                    gebildetAus(z.raster()), b.id(), OhneZahl.OHNE_MENGE_GESPEICHERT.wort(), ereignisse, null,
                    w.hoechste());
        }
        Zahlen n = zahlen(b, zeile);
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                n.menge(), n.mittel(), n.min(), n.max(), zeile.mengeZustand(), kennzeichen(zeile),
                zeile.erhalten(), zeile.erwartet(), zeile.abdeckungProzent(), zeile.zustand(),
                iso(zeile.endgueltigAb(), z.zone()), zeile.version(), gebildetAus(z.raster()), b.id(), null, ereignisse,
                null, w.hoechste());
    }

    /**
     * Ein Schritt in einer Version ab 2 — Zahl, Zustand und Kennzeichen stehen in der Version. Ihre Rohwert-Fakten
     * ebenfalls, wenn die Kaskade sie schrieb; eine Viertelstunde des Ersatzwert-Laufs hat die Fakten von Version 1
     * (in einer Lücke: 0 von den erwarteten Werten, wie Version 1 „keine Werte“ sie nennt). Vorläufig/endgültig der
     * Basis — eine Version ändert es nicht.
     */
    private MessstelleWerteDto.Wert ausVersion(Rahmen r, Schritt s, Bindung b, Zeile zeile, WertVersionenLeser.Version v,
            Gelesen g, Zeitraum z, Instant jetzt, List<MessstelleWerteDto.Ereignis> ereignisse, int hoechste) {
        Integer erhalten;
        Integer erwartet;
        Integer abdeckung;
        BigDecimal mittel = null;
        BigDecimal min = null;
        BigDecimal max = null;
        BigDecimal energie = null;
        if (v.mitFakten()) {
            erhalten = v.erhalten();
            erwartet = v.erwartet();
            abdeckung = v.abdeckungProzent();
            mittel = v.mittel();
            min = v.min();
            max = v.max();
            energie = v.energie();
        } else if (zeile != null) {
            erhalten = zeile.erhalten();
            erwartet = zeile.erwartet();
            abdeckung = zeile.abdeckungProzent();
            mittel = zeile.wert();
            min = zeile.minimum();
            max = zeile.maximum();
            energie = zeile.energie() == null ? null : zeile.energie().wert();
        } else {
            erhalten = 0;
            erwartet = erwartetOhneZeile(b, g, s.von(), s.bis());
            abdeckung = SpeicherklasseHistorie.abdeckung(0, erwartet);
        }
        String fassung = v.zustand() != null ? v.zustand() : zeile != null ? zeile.zustand()
                : TagRegeln.zustand(0, 0, TagRegeln.endgueltigAb(s.bis()), jetzt);
        Zahlen n = switch (b.herleitung()) {
            case "momentanwert" -> new Zahlen(null, mittel, min, max);
            case "integration" -> {
                EnergieAusLeistung e = EnergieAusLeistung.aus(energie, v.kennzeichen());
                yield new Zahlen(e == null ? null : e.wert(), null, null, null);
            }
            default -> new Zahlen(v.menge(), null, null, null);
        };
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                n.menge(), n.mittel(), n.min(), n.max(), v.mengeZustand(), v.kennzeichen(), erhalten, erwartet,
                abdeckung, fassung, zeile == null ? null : iso(zeile.endgueltigAb(), z.zone()), v.version(),
                gebildetAus(z.raster()), b.id(), null, ereignisse, null, hoechste);
    }

    /**
     * Die Stunde: Menge, Zustand, Kennzeichen UND Abdeckung aus dem Lesepfad (er bildet sie je Schritt aus
     * Zeitraum und Kadenz zur Messzeit — eine fehlende Viertelstunde zählt mit ihrer Erwartung, F8 17:00:
     * 29 von 60). Die Viertelstunden liest diese Route nur noch für das, was die Stundenzeile nicht sagt:
     * ob eine davon erst Rohwerte hat (noch nicht gebildet), ob alle dieselbe Version tragen, und
     * vorläufig/endgültig nach {@link TagRegeln#zustand} mit der Frist des Stunden-Endes. Gelesen wird sie nur
     * in Version 1 — eine spätere hat {@link #wert} schon benannt.
     */
    private MessstelleWerteDto.Wert stunde(Rahmen r, Schritt s, Bindung b, Zeile zeile, Gelesen g, Zeitraum z,
            Instant jetzt, List<MessstelleWerteDto.Ereignis> ereignisse) {
        int vorhanden = 0;
        int endgueltig = 0;
        Set<Integer> versionen = new HashSet<>();
        for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
            Zeile v = g.viertelstunden().get(q);
            if (v == null && g.mitDaten().contains(q)) {
                // Eine Viertelstunde der Stunde hat Rohwerte, aber noch keine Zeile: die Stunde ist nicht fertig gebildet.
                return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                        null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG,
                        null, null, null, b.id(), OhneZahl.NOCH_NICHT_GEBILDET.wort(), ereignisse, null, null);
            }
            if (v == null) {
                continue;
            }
            vorhanden++;
            endgueltig += ViertelstundeRegeln.ENDGUELTIG.equals(v.zustand()) ? 1 : 0;
            versionen.add(v.version());
        }
        String fassung = TagRegeln.zustand(vorhanden, endgueltig, TagRegeln.endgueltigAb(s.bis()), jetzt);
        Instant endgueltigAb = TagRegeln.endgueltigAb(s.bis());
        if (zeile.mengeZustand() == null) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), zeile.erhalten(), zeile.erwartet(),
                    zeile.abdeckungProzent(), fassung, iso(endgueltigAb, z.zone()),
                    versionen.size() == 1 ? versionen.iterator().next() : null, "zeitraum", b.id(),
                    OhneZahl.OHNE_MENGE_GESPEICHERT.wort(), ereignisse, null, null);
        }
        Zahlen n = zahlen(b, zeile);
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                n.menge(), n.mittel(), n.min(), n.max(), zeile.mengeZustand(), kennzeichen(zeile), zeile.erhalten(),
                zeile.erwartet(), zeile.abdeckungProzent(), fassung, iso(endgueltigAb, z.zone()),
                versionen.size() == 1 ? versionen.iterator().next() : null, "zeitraum", b.id(), null, ereignisse, null,
                null);
    }

    /**
     * Ein Schritt ohne gespeicherte Zeile: noch nicht gebildet — oder wirklich „keine Werte“ (dann Version 1 einer
     * Periode, die {@code versionen} zählt; an der Stunde {@code null}).
     */
    private MessstelleWerteDto.Wert ohneZeile(Rahmen r, Schritt s, Bindung b, Gelesen g, Zeitraum z, Instant jetzt,
            List<MessstelleWerteDto.Ereignis> ereignisse, Integer versionen) {
        boolean darunter = z.raster() == Raster.STUNDE
                ? stundeMitDaten(s, g) : g.mitDaten().contains(s.von());
        if (darunter) {
            return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                    null, null, null, null, null, List.of(), null, null, null, ViertelstundeRegeln.VORLAEUFIG, null,
                    null, null, b.id(), OhneZahl.NOCH_NICHT_GEBILDET.wort(), ereignisse, null, null);
        }
        int erwartet = erwartetOhneZeile(b, g, s.von(), s.bis());
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, ErgebnisZustand.KEINE_WERTE, List.of(), 0, erwartet,
                SpeicherklasseHistorie.abdeckung(0, erwartet),
                TagRegeln.zustand(0, 0, TagRegeln.endgueltigAb(s.bis()), jetzt), null, null, null, b.id(), null,
                ereignisse, null, versionen);
    }

    private static boolean stundeMitDaten(Schritt s, Gelesen g) {
        for (Instant q = s.von(); q.isBefore(s.bis()); q = q.plusSeconds(900)) {
            if (g.mitDaten().contains(q)) {
                return true;
            }
        }
        return false;
    }

    /** Ein Schritt ohne Reihe: keine Quelle („keine Werte“) oder ein benannter Grund ohne Zustand — ohne Versionen. */
    private static MessstelleWerteDto.Wert ohneReihe(Rahmen r, OhneZahl grund) {
        return ohneReihe(r, grund, List.of());
    }

    private static MessstelleWerteDto.Wert ohneReihe(Rahmen r, OhneZahl grund, List<String> kennzeichen) {
        String zustand = grund == OhneZahl.KEINE_QUELLE ? ErgebnisZustand.KEINE_WERTE : null;
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, zustand, kennzeichen, null, null, null, null, null, null, null, null,
                grund.wort(), List.of(), null, null);
    }

    private static MessstelleWerteDto.Wert leer(Rahmen r, Bindung b, OhneZahl grund,
            List<MessstelleWerteDto.Ereignis> ereignisse, Integer versionen) {
        return new MessstelleWerteDto.Wert(r.von(), r.bis(), r.beschriftung(), r.stunden(), r.tagesdauer(),
                null, null, null, null, null, List.of(), null, null, null, null, null, null, null, b.id(),
                grund.wort(), ereignisse, null, versionen);
    }

    // ------------------------------------------------------------------------ Versionen (AP-08 IP-18)

    private static List<Integer> nummern(List<WertVersionenLeser.Version> versionen) {
        return versionen.stream().map(WertVersionenLeser.Version::version).toList();
    }

    private static WertVersionenLeser.Version finde(List<WertVersionenLeser.Version> versionen, int version) {
        return versionen.stream().filter(v -> v.version() == version).findFirst().orElse(null);
    }

    /**
     * Eine Entscheidung, wie sie gespeichert ist: Urheber und Zeitpunkt ihrer Fassung, das „warum“ als der Text, den
     * der Mensch DAZU geschrieben hat — fehlt er, nennt {@code fehlt} es, ein Grund wird nicht erfunden. Auch die
     * Versionen einer Kennzahl ({@link KennzahlWerteService}) sprechen ihre Korrekturen und Ersatzwerte hierüber.
     */
    static MessstelleWerteDto.Entscheidung entscheidung(WertVersionenRegeln.Schluessel k,
            List<WertVersionenLeser.Fassung> fassungen, ZoneId zone) {
        String vorgang = WertVersionenRegeln.Vorgang.aus(k.kennung()).wort();
        WertVersionenLeser.Fassung f = fassung(fassungen, k.kennung(), k.fassung());
        if (f == null) {
            return new MessstelleWerteDto.Entscheidung(vorgang, k.kennung(), k.fassung(), null, null, null, null, null,
                    null, null, List.of(WertVersionenRegeln.FEHLT_FASSUNG), null);
        }
        WertVersionenLeser.Fassung erste = f.fassung() == 1 ? f : fassung(fassungen, k.kennung(), 1);
        String warum = WertVersionenRegeln.begruendung(f.fassung(), f.begruendung(), f.grund());
        MessstelleWerteDto.Angelegt angelegt = f.fassung() == 1 || erste == null ? null
                : new MessstelleWerteDto.Angelegt(urheber(erste), iso(erste.am(), zone),
                        WertVersionenRegeln.begruendung(1, erste.begruendung(), erste.grund()), erste.beleg());
        return new MessstelleWerteDto.Entscheidung(vorgang, f.kennung(), f.fassung(), f.status(),
                erste == null ? null : erste.methode(), erste == null ? null : erste.art(), urheber(f),
                iso(f.am(), zone), warum, f.beleg(),
                warum == null ? List.of(WertVersionenRegeln.FEHLT_WARUM) : List.of(), angelegt);
    }

    private static WertVersionenLeser.Fassung fassung(List<WertVersionenLeser.Fassung> fassungen, String kennung,
            int fassung) {
        return fassungen.stream().filter(f -> f.kennung().equals(kennung) && f.fassung() == fassung).findFirst()
                .orElse(null);
    }

    private static MessstelleWerteDto.Urheber urheber(WertVersionenLeser.Fassung f) {
        return new MessstelleWerteDto.Urheber(f.actorName(), f.actorRolle(), f.actorArt());
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
        return zone(tenant, fuehrend, form.von().zeitpunkt() != null ? form.von().zeitpunkt()
                : form.von().tag().atStartOfDay(ZoneId.of("UTC")).toInstant());
    }

    private Zone zone(UUID tenant, List<Quelle> fuehrend, Instant stichtag) {
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
