package com.voltpilot.api.mispel;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Ergebnis;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Viertelstunde;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Zeitraum;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import com.voltpilot.api.repo.MispelMarktdatenRepository;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwHerkunft;
import com.voltpilot.api.repo.MispelMarktdatenRepository.AwViertelstunde;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleService;
import com.voltpilot.api.uems.ZaehlerrolleService.AnlageStand;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-8: der Monatslauf der Abgrenzungsoption je Anlage (Einspeisestelle) — liest die Zähler der Festlegung
 * ({@link ZaehlerrolleService#anlage}, MP-6), ihre Viertelstundenmengen ({@link MispelZaehlerLeser}) und AW¼ &gt; 0
 * ({@link MispelMarktdatenRepository#awZeiten}, MP-7), rechnet mit {@link MispelAbgrenzungRechenwerk} und speichert
 * das Ergebnis mit dem Nachweis-Datensatz (Eingänge, Zwischenwerte, Version, Prüfsumme) als Fassung in
 * {@code mispel_abgrenzung_monat}.
 *
 * <p><b>Stand (Entscheid E4 = C, Bauplan § 8.5):</b> {@code endgueltig} nur, wenn jede Viertelstunde des Zeitraums
 * gerechnet ist, jeder Zähler die Wertequelle „Messstellenbetreiber“ und das Urteil „tauglich“ trägt (mess- und
 * eichrechtskonform, Tenor S. 28; § 21 Abs. 4 S. 2 EnFG), alle Viertelstunden endgültig sind, AW¼ aus der Liste der
 * ÜNB stammt (A1 S. 17 Fn. 8) und der Zeitraum vorbei ist. Sonst {@code vorlaeufig} mit den Gründen — eine
 * vorläufige Zahl ist keine Mengenbestimmung im Sinn der Festlegung. Eine fehlende Viertelstunde ist eine Lücke:
 * sie geht nicht als Null in die Summen ein, sondern bleibt draußen und steht im Nachweis.
 *
 * <p>Formelsatz, AW-Regel und Stammdaten kommen heute vom Aufrufer ({@link Vorgaben}); später aus dem Förderweg
 * (MP-5/MP-17). Rumpfmonate gibt der Aufrufer als Zeitraum vor; erkannt werden sie mit MP-21. Ändert sich die
 * Zuordnung der Zähler innerhalb des Zeitraums, rechnet der Lauf nicht ({@code bestimmungsrelevante_aenderung},
 * A1 S. 102 Abschn. 11).
 */
@Service
public class MispelAbgrenzungService {

    /** Die Fassung dieses Rechenwerks; steigt mit jeder Änderung an Rechenweg oder Nachweis-Aufbau. */
    public static final String RECHENWERK_VERSION = "MP-8/1";
    /** Der Vertrag und seine Fassung ({@code schema_version} der Vektor-Datei). */
    public static final String VERTRAG = "docs/contracts/v2/mispel-abgrenzung.md";
    public static final String VERTRAG_VERSION = "1.0";
    public static final String VORLAEUFIG = "vorlaeufig";
    public static final String ENDGUELTIG = "endgueltig";
    public static final String MSB = "messstellenbetreiber";
    public static final String GERAET = "geraet";
    public static final String GEBOTSZONE = "DE-LU";

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int LUECKEN_IM_NACHWEIS = 96;

    /**
     * Was der Lauf von der Anlage wissen muss: der Formelsatz (E5 = B: A1, A5, A5-Variante, A10, A11), die AW-Regel
     * je geförderter Anlage ({@link MispelMarktdatenRepository#REGELN}; {@code awRegelB} nur in A5/A5-Variante),
     * Painst/Pbinst (A5, A5-Variante), ungeförderte Anlage in A5 (A1 S. 52) und optional ein Rumpfmonat
     * {@code [rumpfVon, rumpfBis)} in Tagen (A1 S. 102); {@code null} = Kalendermonatsanfang bzw. -ende.
     */
    public record Vorgaben(String formelsatz, String awRegel, String awRegelB, Map<String, BigDecimal> stammdaten,
            Set<String> ungefoerdert, LocalDate rumpfVon, LocalDate rumpfBis) {

        public static Vorgaben von(String formelsatz, String awRegel) {
            return new Vorgaben(formelsatz, awRegel, null, null, Set.of(), null, null);
        }
    }

    /** Ein Lauf: die gespeicherte Fassung, das Ergebnis und die Gründe für „vorläufig“; {@code neu} = angehängt. */
    public record Lauf(Zeile zeile, boolean neu, Ergebnis ergebnis, List<String> gruende) {}

    private final ZaehlerrolleService zaehlerrollen;
    private final MispelMarktdatenRepository marktdaten;
    private final MispelAbgrenzungRepository laeufe;
    private MispelZaehlerLeser leser;
    private Clock uhr = Clock.systemUTC();

    public MispelAbgrenzungService(ZaehlerrolleService zaehlerrollen, MispelMarktdatenRepository marktdaten,
            MispelAbgrenzungRepository laeufe, MispelZaehlerLeser leser) {
        this.zaehlerrollen = zaehlerrollen;
        this.marktdaten = marktdaten;
        this.laeufe = laeufe;
        this.leser = leser;
    }

    /** Nur für Tests: die Uhr, an der „Zeitraum vorbei“ gemessen wird. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Nur für Tests: die Zählerwerte ohne die Verdichtungskette der Messreihen. */
    void leserSetzen(MispelZaehlerLeser leser) {
        this.leser = leser;
    }

    /** Die gespeicherten Läufe eines Kalendermonats (für Nachweis und Export, MP-16). */
    public List<Zeile> laeufe(UUID siteId, YearMonth monat) {
        return laeufe.desMonats(siteId, monat.atDay(1));
    }

    /** Ein Zähler des Laufs: Größe der Festlegung, Messstelle, Angaben der Zählerrolle und ihr Urteil am ersten Tag. */
    private record Zaehler(String eingang, ZaehlerrolleRegeln.Knoten knoten, String urteil) {}

    public Lauf monatslauf(UUID siteId, YearMonth monat, Vorgaben v) {
        String fs = v.formelsatz();
        if (!MispelAbgrenzungRechenwerk.FORMELSAETZE.contains(fs)) {
            throw new MispelAbgrenzungAbgelehnt("formelsatz_unbekannt", "Formelsatz „" + fs + "“ ist nicht im Umfang "
                    + "(Bauplan § 8.5, E5 = B): " + String.join(", ", MispelAbgrenzungRechenwerk.FORMELSAETZE) + ".");
        }
        LocalDate vonTag = v.rumpfVon() != null ? v.rumpfVon() : monat.atDay(1);
        LocalDate bisTag = v.rumpfBis() != null ? v.rumpfBis() : monat.plusMonths(1).atDay(1);
        if (!YearMonth.from(vonTag).equals(monat) || !vonTag.isBefore(bisTag)
                || bisTag.isAfter(monat.plusMonths(1).atDay(1))) {
            throw new MispelAbgrenzungAbgelehnt("vorgaben_ungueltig", "Ein Rumpfmonat liegt in seinem Kalendermonat "
                    + "(Anlage 1 S. 102, Abschn. 11): " + vonTag + " bis " + bisTag + " passt nicht zu " + monat + ".");
        }
        Instant von = vonTag.atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        Instant bis = bisTag.atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        boolean rumpf = v.rumpfVon() != null || v.rumpfBis() != null;

        List<Zaehler> zaehler = zaehler(siteId, fs, vonTag, bisTag.minusDays(1));
        Map<String, Map<Instant, MispelZaehlerLeser.Menge>> mengen = new LinkedHashMap<>();
        for (Zaehler z : zaehler) {
            mengen.put(z.eingang(), leser.lesen(z.knoten().kennzeichen(), von, bis));
        }
        Map<String, String> awRegeln = awRegeln(v);
        Map<String, Map<Instant, AwViertelstunde>> aw = new LinkedHashMap<>();
        awRegeln.forEach((eingang, regel) -> {
            Map<Instant, AwViertelstunde> je = new LinkedHashMap<>();
            marktdaten.awZeiten(regel, GEBOTSZONE, von, bis).viertelstunden().forEach(a -> je.put(a.beginn(), a));
            aw.put(eingang, je);
        });

        // Die Viertelstunden des Zeitraums: vollständig gerechnet oder Lücke — nie als Null.
        List<Viertelstunde> eingaenge = new ArrayList<>();
        Map<String, List<String>> luecken = new TreeMap<>();
        boolean alleEndgueltig = true;
        boolean awAmtlich = true;
        int erwartet = 0;
        for (Instant t = von; t.isBefore(bis); t = t.plus(VIERTELSTUNDE)) {
            erwartet++;
            List<String> fehlt = new ArrayList<>();
            Map<String, BigDecimal> z = new LinkedHashMap<>();
            for (Zaehler zl : zaehler) {
                MispelZaehlerLeser.Menge m = mengen.get(zl.eingang()).get(t);
                if (m == null) {
                    fehlt.add(zl.eingang());
                } else {
                    z.put(zl.eingang(), m.kwh());
                    alleEndgueltig &= m.endgueltig();
                }
            }
            Map<String, Boolean> a = new LinkedHashMap<>();
            for (String eingang : awRegeln.keySet()) {
                AwViertelstunde q = aw.get(eingang).get(t);
                if (q == null || q.awGroesserNull() == null) {
                    fehlt.add(eingang);
                } else {
                    a.put(eingang, q.awGroesserNull());
                    awAmtlich &= q.herkunft() == AwHerkunft.UENB_LISTE;
                }
            }
            if (fehlt.isEmpty()) {
                eingaenge.add(new Viertelstunde(OffsetDateTime.ofInstant(t, MispelAbgrenzungRechenwerk.BERLIN), z, a));
            } else {
                luecken.computeIfAbsent(String.join("+", fehlt), k -> new ArrayList<>())
                        .add(OffsetDateTime.ofInstant(t, MispelAbgrenzungRechenwerk.BERLIN).toString());
            }
        }
        if (eingaenge.isEmpty()) {
            throw new MispelAbgrenzungAbgelehnt("keine_werte", "Für " + monat + " liegt keine vollständige Viertelstunde "
                    + "vor — ohne Werte rechnet der Lauf nichts (unbekannt ist keine Null).");
        }

        String schluessel = rumpf ? monat + "/" + vonTag.getDayOfMonth() : monat.toString();
        Ergebnis e;
        try {
            List<Zeitraum> raeume = rumpf ? List.of(new Zeitraum(schluessel,
                    OffsetDateTime.ofInstant(von, MispelAbgrenzungRechenwerk.BERLIN),
                    OffsetDateTime.ofInstant(bis, MispelAbgrenzungRechenwerk.BERLIN), v.stammdaten())) : null;
            e = MispelAbgrenzungRechenwerk.rechne(fs, eingaenge, rumpf ? null : v.stammdaten(), raeume,
                    v.ungefoerdert() == null ? Set.of() : v.ungefoerdert());
        } catch (IllegalArgumentException ex) {
            throw new MispelAbgrenzungAbgelehnt("vorgaben_ungueltig", ex.getMessage());
        }

        String wertequelle = zaehler.stream().allMatch(z -> MSB.equals(z.knoten().angaben().wertequelle()))
                ? MSB : GERAET;
        List<String> gruende = new ArrayList<>();
        if (!luecken.isEmpty()) {
            gruende.add("luecken");
        }
        if (GERAET.equals(wertequelle)) {
            gruende.add("wertequelle_geraet");
        }
        zaehler.stream().filter(z -> !"tauglich".equals(z.urteil()))
                .forEach(z -> gruende.add("zaehler_" + z.urteil() + ":" + z.knoten().kennzeichen()));
        if (!alleEndgueltig) {
            gruende.add("viertelstunden_vorlaeufig");
        }
        if (!awAmtlich) {
            gruende.add("aw_rueckfall");
        }
        if (uhr.instant().isBefore(bis)) {
            gruende.add("zeitraum_offen");
        }
        String stand = gruende.isEmpty() ? ENDGUELTIG : VORLAEUFIG;

        String nachweis = nachweis(siteId, monat, schluessel, von, bis, v, awRegeln, zaehler, stand, gruende,
                wertequelle, erwartet, eingaenge, luecken, e);
        String pruefsumme = sha256(nachweis);
        UUID tenant = TenantContext.get();
        Optional<Zeile> letzte = laeufe.letzte(siteId, von);
        if (letzte.isPresent() && letzte.get().pruefsumme().equals(pruefsumme)) {
            return new Lauf(letzte.get(), false, e, List.copyOf(gruende));
        }
        Zeile z = new Zeile(null, siteId, monat.atDay(1), von, bis, letzte.map(Zeile::fassung).orElse(0) + 1, fs,
                stand, wertequelle, erwartet, eingaenge.size(), RECHENWERK_VERSION, VERTRAG_VERSION, nachweis,
                pruefsumme, uhr.instant());
        UUID id = laeufe.anhaengen(tenant, z);
        return new Lauf(new Zeile(id, z.siteId(), z.monat(), z.zeitraumVon(), z.zeitraumBis(), z.fassung(),
                z.formelsatz(), z.stand(), z.wertequelle(), z.viertelstundenErwartet(), z.viertelstundenGerechnet(),
                z.rechenwerkVersion(), z.vertragVersion(), z.nachweis(), z.pruefsumme(), z.gerechnetAm()), true, e,
                List.copyOf(gruende));
    }

    /** Die Zähler des Formelsatzes am ersten und letzten Tag; sie müssen an beiden dieselben Messstellen sein. */
    private List<Zaehler> zaehler(UUID siteId, String fs, LocalDate erster, LocalDate letzter) {
        AnlageStand anfang = zaehlerrollen.anlage(siteId, erster);
        AnlageStand ende = zaehlerrollen.anlage(siteId, letzter);
        List<Zaehler> out = new ArrayList<>();
        List<String> fehlt = new ArrayList<>();
        for (String eingang : MispelAbgrenzungRechenwerk.zaehlerEingaenge(fs)) {
            String groesse = eingang.substring(0, eingang.length() - 1);
            ZaehlerrolleRegeln.Knoten k = anfang.zaehler().get(groesse);
            if (k == null) {
                fehlt.add(groesse);
                continue;
            }
            ZaehlerrolleRegeln.Knoten k2 = ende.zaehler().get(groesse);
            if (k2 == null || !k2.id().equals(k.id()) || !Objects.equals(k2.angaben(), k.angaben())) {
                throw new MispelAbgrenzungAbgelehnt("bestimmungsrelevante_aenderung", "Der Zähler " + groesse
                        + " ändert sich zwischen " + erster + " und " + letzter + " — für die Teile gelten Rumpfmonate "
                        + "(Anlage 1 S. 102, Abschn. 11).");
            }
            String urteil = ZaehlerrolleRegeln.urteil(k.angaben().rolle(),
                    ZaehlerrolleRegeln.befundeZu(k.kennzeichen(), anfang.befunde()));
            out.add(new Zaehler(eingang, k, urteil));
        }
        if (!fehlt.isEmpty()) {
            throw new MispelAbgrenzungAbgelehnt("zaehler_fehlt", "Formelsatz " + fs + " braucht die Zähler "
                    + String.join(", ", fehlt) + " am " + erster + " (Anlage 1 S. 32–33) — keine Messstelle der "
                    + "Anlage trägt diese Größe der Festlegung.");
        }
        return out;
    }

    private static Map<String, String> awRegeln(Vorgaben v) {
        Map<String, String> out = new LinkedHashMap<>();
        Set<String> ohne = v.ungefoerdert() == null ? Set.of() : v.ungefoerdert();
        for (String eingang : MispelAbgrenzungRechenwerk.awEingaenge(v.formelsatz())) {
            if (eingang.equals("AWa¼") && ohne.contains("a") || eingang.equals("AWb¼") && ohne.contains("b")) {
                continue;
            }
            String regel = eingang.equals("AWb¼") ? v.awRegelB() : v.awRegel();
            if (regel == null || !MispelMarktdatenRepository.REGELN.contains(regel)) {
                throw new MispelAbgrenzungAbgelehnt("vorgaben_ungueltig", "Für " + eingang + " fehlt die AW-Regel der "
                        + "Anlage (eine von " + new TreeSet<>(MispelMarktdatenRepository.REGELN) + ", Anlage 1 S. 17 Fn. 8).");
            }
            out.put(eingang, regel);
        }
        return out;
    }

    // ------------------------------------------------------------------ der Nachweis-Datensatz

    private String nachweis(UUID siteId, YearMonth monat, String schluessel, Instant von, Instant bis, Vorgaben v,
            Map<String, String> awRegeln, List<Zaehler> zaehler, String stand, List<String> gruende,
            String wertequelle, int erwartet, List<Viertelstunde> eingaenge, Map<String, List<String>> luecken,
            Ergebnis e) {
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("festlegung", "BNetzA, Marktintegration von Speichern und Ladepunkten (MiSpeL), Az. 618-25-02, "
                + "Beschluss 2026-10-01, Anlage 1 – Abgrenzungsoption");
        n.put("vertrag", VERTRAG);
        n.put("vertrag_version", VERTRAG_VERSION);
        n.put("rechenwerk_version", RECHENWERK_VERSION);
        n.put("anlage", siteId.toString());
        n.put("monat", monat.toString());
        n.put("schluessel", schluessel);
        n.put("zeitraum", Map.of("von", OffsetDateTime.ofInstant(von, MispelAbgrenzungRechenwerk.BERLIN).toString(),
                "bis", OffsetDateTime.ofInstant(bis, MispelAbgrenzungRechenwerk.BERLIN).toString()));
        n.put("zeitzone", MispelAbgrenzungRechenwerk.BERLIN.getId());
        n.put("formelsatz", v.formelsatz());
        Map<String, String> stamm = new TreeMap<>();
        if (v.stammdaten() != null) {
            v.stammdaten().forEach((k, w) -> stamm.put(k, w.stripTrailingZeros().toPlainString()));
        }
        n.put("stammdaten", stamm);
        n.put("ungefoerdert", v.ungefoerdert() == null ? List.of() : v.ungefoerdert().stream().sorted().toList());
        n.put("stand", stand);
        n.put("stand_gruende", gruende);
        n.put("wertequelle", wertequelle);
        List<Map<String, Object>> zl = new ArrayList<>();
        for (Zaehler z : zaehler) {
            Map<String, Object> m = new LinkedHashMap<>();
            ZaehlerrolleRegeln.Angaben a = z.knoten().angaben();
            m.put("eingang", z.eingang());
            m.put("messstelle", z.knoten().kennzeichen());
            m.put("rolle", a.rolle());
            m.put("zaehlpunkt", a.zaehlpunkt());
            m.put("messstellenbetreiber", a.messstellenbetreiber());
            m.put("eichstatus", a.eichstatus());
            m.put("eichfrist_bis", a.eichfristBis() == null ? null : a.eichfristBis().toString());
            m.put("wertequelle", a.wertequelle());
            m.put("urteil", z.urteil());
            zl.add(m);
        }
        n.put("zaehler", zl);
        n.put("aw_regeln", awRegeln);
        Map<String, Object> qh = new LinkedHashMap<>();
        qh.put("erwartet", erwartet);
        qh.put("gerechnet", eingaenge.size());
        qh.put("luecken", erwartet - eingaenge.size());
        Map<String, Object> lueckenNachweis = new LinkedHashMap<>();
        luecken.forEach((fehlt, beginne) -> lueckenNachweis.put(fehlt, Map.of("anzahl", beginne.size(),
                "erste", beginne.subList(0, Math.min(LUECKEN_IM_NACHWEIS, beginne.size())))));
        qh.put("luecken_je_eingang", lueckenNachweis);
        n.put("viertelstunden", qh);
        // Eingänge und Zwischenwerte je Viertelstunde, dann Monat und Jahr — alles ungerundet (Regel vergleich).
        Map<OffsetDateTime, Map<String, Bruch>> zwischen = new LinkedHashMap<>();
        e.viertelstunden().forEach(w -> zwischen.put(w.beginn(), w.werte()));
        List<Map<String, Object>> zeilen = new ArrayList<>();
        for (Viertelstunde q : eingaenge) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("beginn", q.beginn().toString());
            q.zaehler().forEach((k, w) -> m.put(k, w.stripTrailingZeros().toPlainString()));
            q.awGroesserNull().forEach((k, w) -> m.put(k + " > 0", w));
            Map<String, Bruch> w = zwischen.get(q.beginn());
            if (w != null) {
                w.forEach((k, b) -> m.put(k, text(b)));
            }
            zeilen.add(m);
        }
        n.put("eingaenge_und_viertelstundenwerte", zeilen);
        n.put("monatswerte", texte(e.monate()));
        n.put("jahreswerte_dieses_laufs", texte(e.jahre()));
        try {
            return MAPPER.writeValueAsString(n);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static Map<String, Map<String, String>> texte(Map<String, Map<String, Bruch>> werte) {
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        werte.forEach((k, m) -> {
            Map<String, String> t = new LinkedHashMap<>();
            m.forEach((nr, b) -> t.put(nr, text(b)));
            out.put(k, t);
        });
        return out;
    }

    /** Exakt: Dezimalzahl oder Bruch; {@code null} = nicht bestimmbar (Regel nenner_null). */
    private static String text(Bruch b) {
        return b == null ? null : b.text();
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
