package com.voltpilot.api.mispel;

import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Dateien des Messstellenbetreibers für die Tests von MP-15/MP-15b: dieselben Viertelstunden als CSV
 * ({@link MsbWerteCsv}) und als MSCONS ({@link MsbWerteMscons}, MIG 2.5, wie ein Messstellenbetreiber sie schickt).
 *
 * <p>Je Viertelstunde des Zeitraums eine Menge je Richtung. Der erste Zählpunkt gilt bis zum Tag vor {@code wechsel},
 * der zweite ab dann (Zählerwechsel); am Tag {@code luecke} fehlt die zweite Richtung 10–12 Uhr — in der MSCONS fehlt
 * 10–11 Uhr ganz und 11–12 Uhr steht ein Ersatzwert (QTY+67), der ebenso eine Lücke bleibt.
 */
final class MsbBeispiel {

    static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final DateTimeFormatter F303 = DateTimeFormatter.ofPattern("uuuuMMddHHmm");

    private MsbBeispiel() {}

    /** Die CSV eines Monats. {@code r1}/{@code r2}: {@code bezug}/{@code abgabe} oder die OBIS-Kennzahl. */
    static String csv(YearMonth m, List<String> zps, String r1, double kwh1, String r2, double kwh2,
            LocalDate wechsel, LocalDate luecke) {
        StringBuilder s = new StringBuilder("# Lastgang des Messstellenbetreibers, Beginn der Viertelstunde\n"
                + "zeitstempel;zaehlpunkt;richtung;kwh\n");
        DateTimeFormatter f = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
        for (ZonedDateTime t = m.atDay(1).atStartOfDay(BERLIN);
                t.isBefore(m.plusMonths(1).atDay(1).atStartOfDay(BERLIN)); t = t.plusMinutes(15)) {
            String zp = wechsel != null && !t.toLocalDate().isBefore(wechsel) && zps.size() > 1 ? zps.get(1)
                    : zps.get(0);
            String ts = t.toOffsetDateTime().format(f);
            s.append(ts).append(';').append(zp).append(';').append(r1).append(';')
                    .append(String.format(Locale.GERMANY, "%.3f", kwh1)).append('\n');
            boolean fehlt = luecke != null && t.toLocalDate().equals(luecke) && t.getHour() >= 10 && t.getHour() < 12;
            if (!fehlt) {
                s.append(ts).append(';').append(zp).append(';').append(r2).append(';')
                        .append(String.format(Locale.GERMANY, "%.3f", kwh2)).append('\n');
            }
        }
        return s.toString();
    }

    /** Die MSCONS eines Monats, Zeitpunkte in UTC ({@code ?+00}) wie im BDEW-Format üblich. */
    static String mscons(YearMonth m, List<String> zps, String r1, double kwh1, String r2, double kwh2,
            LocalDate wechsel, LocalDate luecke) {
        return mscons(m.atDay(1).atStartOfDay(BERLIN), m.plusMonths(1).atDay(1).atStartOfDay(BERLIN), zps, r1, kwh1,
                r2, kwh2, wechsel, luecke, false);
    }

    /** Die MSCONS eines Tages in Ortszeit {@code [tag, tag + 1)}; {@code ortszeit}: Versatz ?+01/?+02 statt UTC. */
    static String msconsTag(LocalDate tag, String zp, boolean ortszeit) {
        return mscons(tag.atStartOfDay(BERLIN), tag.plusDays(1).atStartOfDay(BERLIN), List.of(zp), "bezug", 0.25,
                "abgabe", 0.125, null, null, ortszeit);
    }

    static String mscons(ZonedDateTime von, ZonedDateTime bis, List<String> zps, String r1, double kwh1, String r2,
            double kwh2, LocalDate wechsel, LocalDate luecke, boolean ortszeit) {
        List<String> seg = new ArrayList<>();
        seg.add("UNH+1+MSCONS:D:04B:UN:2.5");
        seg.add("BGM+7+MSI" + von.toLocalDate().toString().replace("-", "") + "+9");
        seg.add("DTM+137:" + zeit(bis.plusDays(1), false) + ":303");
        seg.add("RFF+Z13:13025");
        seg.add("NAD+MS+9900000000003::293");
        seg.add("CTA+IC+:Messstellenbetrieb Muster");
        seg.add("COM+messwerte@msb.example:EM");
        seg.add("NAD+MR+9900000000010::293");
        seg.add("UNS+D");
        seg.add("NAD+DP");
        ZonedDateTime grenze = wechsel == null || zps.size() < 2 ? bis : wechsel.atStartOfDay(BERLIN);
        abschnitt(seg, zps.get(0), "1ESY1160000001", von, grenze, r1, kwh1, r2, kwh2, luecke, ortszeit);
        if (grenze.isBefore(bis)) {
            abschnitt(seg, zps.get(1), "1ESY1160000002", grenze, bis, r1, kwh1, r2, kwh2, luecke, ortszeit);
        }
        seg.add("UNT+" + (seg.size() + 1) + "+1");
        StringBuilder s = new StringBuilder("UNA:+.? 'UNB+UNOC:3+9900000000003:500+9900000000010:500+")
                .append(zeit(bis, false), 2, 8).append(':').append("0605+MSB4711++TL'\n");
        seg.forEach(x -> s.append(x).append("'\n"));
        return s.append("UNZ+1+MSB4711'\n").toString();
    }

    /** Eine Messlokation (LOC+172) mit ihren beiden Lastgängen über {@code [von, bis)}. */
    private static void abschnitt(List<String> seg, String zp, String zaehler, ZonedDateTime von, ZonedDateTime bis,
            String r1, double kwh1, String r2, double kwh2, LocalDate luecke, boolean ortszeit) {
        seg.add("LOC+172+" + zp);
        seg.add("DTM+163:" + zeit(von, ortszeit) + ":303");
        seg.add("DTM+164:" + zeit(bis, ortszeit) + ":303");
        seg.add("RFF+MG:" + zaehler);
        for (int n = 1; n <= 2; n++) {
            seg.add("LIN+" + n);
            seg.add("PIA+5+" + obis(n == 1 ? r1 : r2).replace(":", "?:") + ":SRW");
            for (ZonedDateTime t = von; t.isBefore(bis); t = t.plusMinutes(15)) {
                boolean tag = n == 2 && luecke != null && t.toLocalDate().equals(luecke);
                if (tag && t.getHour() == 10) {
                    continue;
                }
                String menge = String.format(Locale.ROOT, "%.3f", n == 1 ? kwh1 : kwh2);
                if (tag && t.getHour() == 11) {
                    seg.add("QTY+67:" + menge);
                    seg.add("DTM+163:" + zeit(t, ortszeit) + ":303");
                    seg.add("DTM+164:" + zeit(t.plusMinutes(15), ortszeit) + ":303");
                    // Status der Ersatzwertbildung; der Leser übergeht ihn.
                    seg.add("STS+Z32++Z88");
                    continue;
                }
                seg.add("QTY+220:" + menge);
                seg.add("DTM+163:" + zeit(t, ortszeit) + ":303");
                seg.add("DTM+164:" + zeit(t.plusMinutes(15), ortszeit) + ":303");
            }
        }
    }

    static String obis(String r) {
        return switch (r) {
            case "bezug" -> "1-1:1.29.0";
            case "abgabe" -> "1-1:2.29.0";
            default -> r;
        };
    }

    /** Format 303: {@code JJJJMMTTHHMM?+ZZ}, in UTC oder in Ortszeit mit ihrem Versatz. */
    static String zeit(ZonedDateTime t, boolean ortszeit) {
        ZonedDateTime z = ortszeit ? t.withZoneSameInstant(BERLIN) : t.withZoneSameInstant(ZoneOffset.UTC);
        int h = z.getOffset().getTotalSeconds() / 3600;
        return z.format(F303) + "?" + (h < 0 ? "-" : "+") + String.format("%02d", Math.abs(h));
    }
}
