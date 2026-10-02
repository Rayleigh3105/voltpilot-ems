package com.voltpilot.api.mispel;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleRepository.Fassung;
import com.voltpilot.api.uems.ZaehlerrolleService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Werte des Messstellenbetreibers einlesen und je Zähler, Richtung und Monat mit den Gerätewerten abgleichen (MiSpeL
 * MP-15, Bedienkonzept BK-15 Variante A, Vertrag {@code mispel-abgrenzung.md} „Werte des Messstellenbetreibers“).
 *
 * <p>Die Gerätewerte liest {@link MispelZaehlerLeser} über die Messstelle, die Werte des Messstellenbetreibers
 * {@link MsbWerteRepository} je Zählpunkt und Richtung; die Ampel ist {@link MsbAbgleichRegeln}, die Wirkung auf den
 * Monat kommt aus den gespeicherten Läufen ({@link MispelMengenService#wirkung}). Maßgeblich bleiben die Werte des
 * Messstellenbetreibers (Tenor S. 28): der Abgleich erklärt, er ersetzt nichts.
 */
@Service
public class MsbAbgleichService {

    /** Die Zählrichtungen der Anlage in der Reihenfolge der Festlegung (Anlage 1 S. 32–33). */
    static final List<String> GROESSEN = List.of("Z1NB", "Z1NE", "Z2V", "Z2E", "Z3V", "Z3E");
    /** Höchstens so viele Monate je Messstelle (zwei Jahre). */
    static final int HOECHSTENS_MONATE = 24;
    /** Die Formate einer Datei des Messstellenbetreibers ({@code mispel_msb_import.format}). */
    public static final String CSV = "csv";
    public static final String MSCONS = "mscons";

    /**
     * Ergebnis eines Imports; {@code neu = false}, wenn dieselbe Datei schon eingelesen war. {@code uebergangen}: Mengen
     * ohne wahren Wert (MSCONS: Ersatz-, Vorschlags-, Prognose- und nicht verwendbare Werte), die eine Lücke bleiben.
     */
    public record Eingelesen(MsbWerteRepository.Import importDatei, boolean neu, List<String> zaehlpunkte,
            List<String> richtungen, int uebergangen) {}

    /** Ein Monat an einer Messstelle: der Abgleich und die Wirkung des Endgültig-Werdens auf die Anlage. */
    public record MonatZeile(String monat, String zaehlpunkt, MsbAbgleichRegeln.Ergebnis abgleich,
            MispelMengen.Wirkung wirkung) {}

    /** Der Abgleich an einer Messstelle: Rolle, Zählpunkt, Messstellenbetreiber, je Monat eine Zeile, Importe. */
    public record Messstelle(UUID messstelleId, String messstelle, String rolle, String festlegungsgroesse,
            String richtung, String zaehlpunkt, String messstellenbetreiber, String wertequelle, UUID anlage,
            List<MonatZeile> monate, List<MsbWerteRepository.Import> importe, MsbAbgleichRegeln.Schwellen schwellen) {}

    /** Ein Zähler der Anlage im Monat. */
    public record Zaehler(String groesse, String rolle, String richtung, UUID messstelleId, String messstelle,
            String zaehlpunkt, String messstellenbetreiber, MsbAbgleichRegeln.Ergebnis abgleich) {}

    /** Der Abgleich einer Anlage im Monat: die Zählrichtungen, die größte Abweichung und die Wirkung. */
    public record AnlageMonat(String monat, List<Zaehler> zaehler, String groessteAbweichung,
            MispelMengen.Wirkung wirkung, MsbAbgleichRegeln.Schwellen schwellen) {}

    private final ZaehlerrolleService rollen;
    private final MsbWerteRepository msb;
    private MispelZaehlerLeser leser;
    private final MispelMengenService mengen;
    private final MsbAbgleichRegeln.Schwellen schwellen;
    private final JdbcTemplate jdbc;
    private Clock uhr = Clock.systemUTC();

    public MsbAbgleichService(ZaehlerrolleService rollen, MsbWerteRepository msb, MispelZaehlerLeser leser,
            MispelMengenService mengen, JdbcTemplate jdbc,
            @Value("${voltpilot.mispel.abgleich.gruen-bis-prozent:2}") BigDecimal gruenBis,
            @Value("${voltpilot.mispel.abgleich.gelb-bis-prozent:5}") BigDecimal gelbBis) {
        this.rollen = rollen;
        this.msb = msb;
        this.leser = leser;
        this.mengen = mengen;
        this.jdbc = jdbc;
        this.schwellen = new MsbAbgleichRegeln.Schwellen(gruenBis, gelbBis);
    }

    /** Nur für Tests: der Leser der Gerätewerte. */
    void leserSetzen(MispelZaehlerLeser leser) {
        this.leser = leser;
    }

    /** Nur für Tests: die Uhr für „bis heute“. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- einlesen

    /**
     * Liest eine Datei an der Messstelle ein: MSCONS ({@link MsbWerteMscons}, erkannt an {@code UNA}/{@code UNB} am
     * Anfang) oder CSV ({@link MsbWerteCsv}). Jeder Wert muss einen Zählpunkt nennen, den die Messstelle in einer
     * Fassung ihrer Zählerrolle trägt (auch vor einem Zählerwechsel); beide Richtungen des Zählpunkts sind erlaubt
     * (Z1 sind zwei Messstellen mit demselben Zählpunkt, Vertrag {@code mispel-zaehlerrolle.md} § 1).
     */
    @Transactional
    public Eingelesen einlesen(UUID messstelleId, String dateiname, byte[] datei, ProtokollAkteur wer) {
        ZaehlerrolleService.Ansicht a = rollen.ansicht(messstelleId, null);
        Set<String> eigene = new LinkedHashSet<>();
        for (ZaehlerrolleService.FassungAnsicht f : a.fassungen()) {
            if (!f.fassung().aufgehoben() && f.fassung().angaben().zaehlpunkt() != null) {
                eigene.add(f.fassung().angaben().zaehlpunkt());
            }
        }
        if (eigene.isEmpty()) {
            throw new MsbAbgleichAbgelehnt("kein_zaehlpunkt", 422, "Diese Messstelle hat noch keinen Zählpunkt der "
                    + "Festlegung — erst die Zählerrolle mit Zählpunkt eintragen (Anlage 1 S. 23).");
        }
        String format = MsbWerteMscons.istEdifact(datei) ? MSCONS : CSV;
        List<MsbWerteCsv.Wert> werte;
        int uebergangen = 0;
        try {
            if (format.equals(MSCONS)) {
                // Zeichensatz UNOC (ISO 8859-1); gelesen werden nur Ziffern, Kennungen und Trennzeichen.
                MsbWerteMscons.Gelesen g = MsbWerteMscons.lesen(new String(datei, StandardCharsets.ISO_8859_1));
                werte = g.werte();
                uebergangen = g.uebergangen();
            } else {
                werte = MsbWerteCsv.lesen(new String(datei, StandardCharsets.UTF_8));
            }
        } catch (MsbWerteCsv.Ungueltig e) {
            // CSV: die Zeile; MSCONS: die Nummer des Segments (0 = die ganze Datei).
            throw new MsbAbgleichAbgelehnt("datei_ungueltig", 400, e.getMessage())
                    .mit("grund", e.grund()).mit("format", format).mit(format.equals(MSCONS) ? "segment" : "zeile",
                            e.zeile());
        }
        Set<String> zps = new LinkedHashSet<>();
        Set<String> richtungen = new LinkedHashSet<>();
        for (MsbWerteCsv.Wert w : werte) {
            if (!eigene.contains(w.zaehlpunkt())) {
                throw new MsbAbgleichAbgelehnt("zaehlpunkt_fremd", 422, "Der Zählpunkt " + w.zaehlpunkt() + " gehört "
                        + "nicht zu dieser Messstelle (" + String.join(", ", eigene) + ").")
                        .mit("zaehlpunkt", w.zaehlpunkt());
            }
            zps.add(w.zaehlpunkt());
            richtungen.add(w.richtung());
        }
        String sha = sha256(datei);
        var vorhanden = msb.mitPruefsumme(sha);
        if (vorhanden.isPresent()) {
            return new Eingelesen(vorhanden.get(), false, List.copyOf(zps), List.copyOf(richtungen), uebergangen);
        }
        String von = wer == null ? null : wer.name() != null ? wer.name() : wer.sub();
        String name = dateiname == null || dateiname.isBlank() ? null
                : dateiname.length() > 200 ? dateiname.substring(0, 200) : dateiname;
        return new Eingelesen(msb.anlegen(TenantContext.get(), messstelleId, format, name, sha, werte, von), true,
                List.copyOf(zps), List.copyOf(richtungen), uebergangen);
    }

    // ---------------------------------------------------------------- Messstelle

    /** Der Abgleich je Monat an einer Messstelle mit Zählerrolle, neuester Monat zuerst; ab Oktober 2026. */
    public Messstelle messstelle(UUID messstelleId) {
        ZaehlerrolleService.Ansicht a = rollen.ansicht(messstelleId, null);
        Fassung aktuell = a.aktuell();
        List<Fassung> fassungen = a.fassungen().stream().map(ZaehlerrolleService.FassungAnsicht::fassung)
                .filter(f -> !f.aufgehoben()).toList();
        String richtung = MsbWerteCsv.richtungDerMessstelle(a.messstelle().hauptgroesse().richtung());
        List<MonatZeile> monate = new ArrayList<>();
        YearMonth heute = YearMonth.from(LocalDate.ofInstant(uhr.instant(), MispelAbgrenzungRechenwerk.BERLIN));
        YearMonth erster = fassungen.stream().filter(f -> f.angaben().rolle() != null)
                .map(f -> YearMonth.from(f.gueltigAb())).min(YearMonth::compareTo).orElse(null);
        if (erster != null && richtung != null) {
            if (erster.isBefore(MispelNachweisService.AB)) {
                erster = MispelNachweisService.AB;
            }
            for (YearMonth m = heute; !m.isBefore(erster) && monate.size() < HOECHSTENS_MONATE; m = m.minusMonths(1)) {
                List<String> zps = zaehlpunkteIm(fassungen, m);
                if (zps.isEmpty()) {
                    continue;
                }
                MsbAbgleichRegeln.Ergebnis e = vergleichen(a.messstelle().kennzeichen(), zps, richtung, m);
                MispelMengen.Wirkung w = a.anlage() == null || e.msbKwh() == null ? null
                        : mengen.wirkung(a.anlage(), m);
                monate.add(new MonatZeile(m.toString(), zps.get(zps.size() - 1), e, w));
            }
        }
        ZaehlerrolleRegeln.Angaben an = aktuell == null ? null : aktuell.angaben();
        return new Messstelle(messstelleId, a.messstelle().kennzeichen(), an == null ? null : an.rolle(),
                a.festlegungsgroesse(), richtung, an == null ? null : an.zaehlpunkt(),
                an == null ? null : an.messstellenbetreiber(), an == null ? null : an.wertequelle(), a.anlage(),
                List.copyOf(monate), msb.derMessstelle(messstelleId), schwellen);
    }

    // ---------------------------------------------------------------- Anlage

    /**
     * Der Abgleich der Zählrichtungen einer Anlage im Monat (Monatskarte und Blatt „Abgleich“, MP-18); {@code null}
     * für eine fremde oder unbekannte Anlage (RLS).
     */
    public AnlageMonat anlage(UUID siteId, YearMonth monat) {
        Integer sichtbar = jdbc.query("SELECT 1 FROM site WHERE id = ?", rs -> rs.next() ? 1 : null, siteId);
        if (sichtbar == null) {
            return null;
        }
        LocalDate erster = monat.atDay(1);
        LocalDate letzter = monat.atEndOfMonth();
        ZaehlerrolleService.AnlageStand anfang = rollen.anlage(siteId, erster);
        ZaehlerrolleService.AnlageStand ende = rollen.anlage(siteId, letzter);
        List<Zaehler> zaehler = new ArrayList<>();
        Zaehler groesste = null;
        for (String g : GROESSEN) {
            ZaehlerrolleRegeln.Knoten k = anfang.zaehler().get(g);
            if (k == null) {
                continue;
            }
            ZaehlerrolleRegeln.Knoten k2 = ende.zaehler().get(g);
            String zp = k.angaben().zaehlpunkt();
            String richtung = MsbWerteCsv.richtungDerMessstelle(k.richtung());
            boolean wechsel = k2 == null || !k2.id().equals(k.id()) || !java.util.Objects.equals(zp,
                    k2.angaben().zaehlpunkt());
            List<String> zps = new ArrayList<>();
            if (zp != null) {
                zps.add(zp);
            }
            if (k2 != null && k2.angaben().zaehlpunkt() != null && !zps.contains(k2.angaben().zaehlpunkt())) {
                zps.add(k2.angaben().zaehlpunkt());
            }
            MsbAbgleichRegeln.Ergebnis e = richtung == null ? null
                    : vergleichen(k.kennzeichen(), zps, richtung, monat, wechsel);
            Zaehler z = new Zaehler(g, g.substring(0, 2), k.richtung(), k.id(), k.kennzeichen(), zp,
                    k.angaben().messstellenbetreiber(), e);
            zaehler.add(z);
            if (e != null && e.abweichungProzent() != null && (groesste == null
                    || e.abweichungProzent().abs().compareTo(groesste.abgleich().abweichungProzent().abs()) > 0)) {
                groesste = z;
            }
        }
        return new AnlageMonat(monat.toString(), List.copyOf(zaehler), groesste == null ? null : groesste.groesse(),
                mengen.wirkung(siteId, monat), schwellen);
    }

    // ---------------------------------------------------------------- vergleichen

    private MsbAbgleichRegeln.Ergebnis vergleichen(String kennzeichen, List<String> zps, String richtung,
            YearMonth m) {
        return vergleichen(kennzeichen, zps, richtung, m, zps.size() > 1);
    }

    private MsbAbgleichRegeln.Ergebnis vergleichen(String kennzeichen, List<String> zps, String richtung, YearMonth m,
            boolean wechsel) {
        Instant von = m.atDay(1).atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        Instant bis = m.plusMonths(1).atDay(1).atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
        int erwartet = (int) ((bis.getEpochSecond() - von.getEpochSecond()) / 900);
        Map<Instant, MispelZaehlerLeser.Menge> geraet = leser.lesen(kennzeichen, von, bis);
        BigDecimal g = geraet.values().stream().map(MispelZaehlerLeser.Menge::kwh).reduce(BigDecimal.ZERO,
                BigDecimal::add);
        int msbAnzahl = 0;
        BigDecimal msbSumme = BigDecimal.ZERO;
        for (String zp : zps) {
            Map<Instant, BigDecimal> w = msb.werte(zp, richtung, von, bis);
            msbAnzahl += w.size();
            msbSumme = w.values().stream().reduce(msbSumme, BigDecimal::add);
        }
        return MsbAbgleichRegeln.vergleichen(new MsbAbgleichRegeln.Eingang(erwartet, geraet.size(), g, msbAnzahl,
                msbSumme, wechsel), schwellen);
    }

    /** Die Zählpunkte der Fassungen, die im Monat gelten (mehr als einer = Zählerwechsel im Monat). */
    static List<String> zaehlpunkteIm(List<Fassung> fassungen, YearMonth m) {
        List<Fassung> sortiert = fassungen.stream().sorted(java.util.Comparator.comparing(Fassung::gueltigAb)).toList();
        List<String> out = new ArrayList<>();
        for (int i = 0; i < sortiert.size(); i++) {
            Fassung f = sortiert.get(i);
            LocalDate ab = f.gueltigAb();
            LocalDate bis = i + 1 < sortiert.size() ? sortiert.get(i + 1).gueltigAb().minusDays(1) : LocalDate.MAX;
            boolean imMonat = !ab.isAfter(m.atEndOfMonth()) && !bis.isBefore(m.atDay(1));
            String zp = f.angaben().zaehlpunkt();
            if (imMonat && f.angaben().rolle() != null && zp != null && !out.contains(zp)) {
                out.add(zp);
            }
        }
        return out;
    }

    private static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
