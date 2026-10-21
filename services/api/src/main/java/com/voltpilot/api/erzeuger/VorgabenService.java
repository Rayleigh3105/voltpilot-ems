package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.VorgabenRepository.LueckeZeile;
import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Vorgaben einer Erzeugeranlage lesen (UEMS EZ-7, Konzept §4.5/§4.6, EW-12 A): Chronik, Detail mit Rohsignalen
 * und Zählerständen, Zählung „Nach Art“ je Tag oder Monat, „heute“ für die Kachel „Wer hat heute geregelt?“ und
 * „Vorgaben als CSV“. Abgeleitet hat sie der {@link VorgabenLaeufer}; hier wird nur gelesen. Eine fremde oder
 * umzäunte Anlage ist 404, nie 403.
 */
@Service
public class VorgabenService {

    /** Höchstens so lang ist ein Zeitraum der Chronik und der CSV. */
    static final Duration HOECHSTENS = Duration.ofDays(400);
    static final int TAGE_HOECHSTENS = 400;
    static final int MONATE_HOECHSTENS = 120;
    /** Proben je Detail; mehr heißt „gekürzt“. */
    static final int SIGNALE_HOECHSTENS = 500;

    private final VorgabenRepository repo;
    private final Clock uhr;

    @Autowired
    public VorgabenService(VorgabenRepository repo) {
        this(repo, Clock.systemUTC());
    }

    VorgabenService(VorgabenRepository repo, Clock uhr) {
        this.repo = repo;
        this.uhr = uhr;
    }

    /** Die Chronik in {@code [von, bis)}: ohne Angabe die letzten sieben Tage bis jetzt. */
    @Transactional(readOnly = true)
    public ErzeugerVorgabenDto.Chronik chronik(UUID siteId, String von, String bis, String urheber, Integer teNr) {
        sichtbar(siteId);
        Instant[] fenster = fenster(von, bis);
        String wer = urheber(urheber);
        if (teNr != null && (teNr < 0 || teNr > ErzeugerRegisterbild.MAX_EINHEITEN)) {
            throw bad("te_nr ist 0 (ganze Anlage) oder 1 … " + ErzeugerRegisterbild.MAX_EINHEITEN + ".");
        }
        List<ErzeugerVorgabenDto.Vorgabe> vorgaben = repo.vorgaben(siteId, fenster[0], fenster[1], wer, teNr).stream()
                .map(VorgabenService::dto).toList();
        List<ErzeugerVorgabenDto.Luecke> luecken = teNr != null && teNr > 0 ? List.of()
                : repo.luecken(siteId, fenster[0], fenster[1], wer).stream().map(VorgabenService::dto).toList();
        return new ErzeugerVorgabenDto.Chronik(siteId, zeit(fenster[0]), zeit(fenster[1]),
                zeit(repo.verarbeitetBis(siteId).orElse(null)), vorgaben, luecken);
    }

    /** Eine Vorgabe mit den Rohsignalen am Beginn und Ende und den Proben in ihrem Zeitraum (± 60 s). */
    @Transactional(readOnly = true)
    public ErzeugerVorgabenDto.Detail detail(UUID siteId, UUID vorgabeId) {
        sichtbar(siteId);
        Zeile z = repo.vorgabe(siteId, vorgabeId).orElseThrow(() -> nichtGefunden("Vorgabe nicht gefunden."));
        List<String> punkte = new ArrayList<>(z.rohBeginn().keySet());
        z.rohEnde().keySet().stream().filter(k -> !punkte.contains(k)).forEach(punkte::add);
        List<VorgabenRepository.Signal> signale = punkte.isEmpty() ? List.of()
                : repo.komponente(z.geraetId()).map(entity -> repo.signale(siteId, entity, punkte,
                        z.beginn().minusSeconds(60), z.belegtBis().plusSeconds(60), SIGNALE_HOECHSTENS + 1))
                        .orElse(List.of());
        boolean gekuerzt = signale.size() > SIGNALE_HOECHSTENS;
        return new ErzeugerVorgabenDto.Detail(dto(z), rohwerte(z.rohBeginn()), rohwerte(z.rohEnde()),
                signale.stream().limit(SIGNALE_HOECHSTENS).map(s -> new ErzeugerVorgabenDto.Signal(s.pointKey(),
                        zeit(s.zeit()), s.wert(), s.qualitaet())).toList(), gekuerzt);
    }

    /**
     * „Nach Art“: je Tag ({@code raster=tag}, {@code von}/{@code bis} als Datum) oder Monat ({@code raster=monat},
     * {@code JJJJ-MM}) in Europe/Berlin; beide Grenzen gehören dazu. Ohne Angabe der laufende Monat bzw. die letzten
     * zwölf Monate.
     */
    @Transactional(readOnly = true)
    public ErzeugerVorgabenDto.Zaehlung zaehlung(UUID siteId, String raster, String von, String bis) {
        sichtbar(siteId);
        String r = raster == null || raster.isBlank() ? "monat" : raster;
        LocalDate heute = LocalDate.now(uhr.withZone(VorgabenZaehlung.ZONE));
        List<LocalDate[]> abschnitte = new ArrayList<>();
        String vonText;
        String bisText;
        try {
            if ("tag".equals(r)) {
                LocalDate erster = von == null ? heute.withDayOfMonth(1) : LocalDate.parse(von);
                LocalDate letzter = bis == null ? heute : LocalDate.parse(bis);
                pruefe(erster, letzter, erster.plusDays(TAGE_HOECHSTENS - 1L), "Tage", TAGE_HOECHSTENS);
                for (LocalDate t = erster; !t.isAfter(letzter); t = t.plusDays(1)) {
                    abschnitte.add(new LocalDate[] {t, t});
                }
                vonText = erster.toString();
                bisText = letzter.toString();
            } else if ("monat".equals(r)) {
                YearMonth erster = von == null ? YearMonth.from(heute).minusMonths(11) : YearMonth.parse(von);
                YearMonth letzter = bis == null ? YearMonth.from(heute) : YearMonth.parse(bis);
                pruefe(erster.atDay(1), letzter.atDay(1), erster.plusMonths(MONATE_HOECHSTENS - 1L).atDay(1),
                        "Monate", MONATE_HOECHSTENS);
                for (YearMonth m = erster; !m.isAfter(letzter); m = m.plusMonths(1)) {
                    abschnitte.add(new LocalDate[] {m.atDay(1), m.atEndOfMonth()});
                }
                vonText = erster.toString();
                bisText = letzter.toString();
            } else {
                throw bad("raster ist tag oder monat.");
            }
        } catch (DateTimeParseException e) {
            throw bad("von/bis: Datum JJJJ-MM-TT (raster=tag) oder Monat JJJJ-MM (raster=monat).");
        }
        Instant gesamtVon = beginn(abschnitte.get(0)[0]);
        Instant gesamtBis = beginn(abschnitte.get(abschnitte.size() - 1)[1].plusDays(1));
        List<Zeile> zeilen = repo.vorgaben(siteId, gesamtVon, gesamtBis, null, null);
        List<ErzeugerVorgabenDto.Abschnitt> out = new ArrayList<>();
        for (LocalDate[] a : abschnitte) {
            Instant b = beginn(a[0]);
            Instant e = beginn(a[1].plusDays(1));
            out.add(new ErzeugerVorgabenDto.Abschnitt("tag".equals(r) ? a[0].toString() : YearMonth.from(a[0]).toString(),
                    zeit(b), zeit(e), VorgabenZaehlung.gruppen(zeilen, b, e, a[0], a[1]),
                    VorgabenZaehlung.jeUrheber(zeilen, b, e, a[0], a[1])));
        }
        return new ErzeugerVorgabenDto.Zaehlung(siteId, r, vonText, bisText,
                zeit(repo.verarbeitetBis(siteId).orElse(null)), out);
    }

    /**
     * Heute (Europe/Berlin) bis jetzt — die Grundlage der Kachel „Wer hat heute geregelt?“ (EZ-8 zählt sie bis EZ-9
     * noch im Portal aus Zustandswechseln) — und was gerade läuft.
     */
    @Transactional(readOnly = true)
    public ErzeugerVorgabenDto.Heute heute(UUID siteId) {
        sichtbar(siteId);
        Instant jetzt = uhr.instant();
        LocalDate tag = jetzt.atZone(VorgabenZaehlung.ZONE).toLocalDate();
        Instant b = beginn(tag);
        Instant e = beginn(tag.plusDays(1));
        List<Zeile> zeilen = repo.vorgaben(siteId, b, e, null, null);
        return new ErzeugerVorgabenDto.Heute(siteId, tag.toString(), zeit(jetzt),
                zeit(repo.verarbeitetBis(siteId).orElse(null)), VorgabenZaehlung.gruppen(zeilen, b, e, tag, tag),
                VorgabenZaehlung.jeUrheber(zeilen, b, e, tag, tag),
                zeilen.stream().filter(z -> z.ende() == null).map(VorgabenService::dto).toList());
    }

    /** „Vorgaben als CSV“ für {@code [von, bis)}: ohne Angabe die letzten sieben Tage bis jetzt. */
    @Transactional(readOnly = true)
    public byte[] csv(UUID siteId, String von, String bis) {
        sichtbar(siteId);
        Instant[] fenster = fenster(von, bis);
        return VorgabenCsv.datei(repo.vorgaben(siteId, fenster[0], fenster[1], null, null),
                repo.luecken(siteId, fenster[0], fenster[1], null));
    }

    // ------------------------------------------------------------------ Formen

    static ErzeugerVorgabenDto.Vorgabe dto(Zeile z) {
        return new ErzeugerVorgabenDto.Vorgabe(z.id(), z.geraetId(), z.teNr(), z.einheitName(), z.urheber(), z.art(),
                zeit(z.beginn()), z.beginnGenau(), zeit(z.ende()), z.endeGenau(), zeit(z.gesehenBis()),
                Duration.between(z.beginn(), z.belegtBis()).getSeconds(), z.vorgabeProzent(), z.vorgabeW(),
                z.istMittelW(), z.verfuegbarMittelW(), z.energieKwh(), z.methode(), z.wertEur(), z.kanal(),
                z.bindung(), z.unvollstaendig(), z.neustart(), z.zaehlerBeginn(), z.zaehlerEnde(), z.gruende());
    }

    static ErzeugerVorgabenDto.Luecke dto(LueckeZeile l) {
        return new ErzeugerVorgabenDto.Luecke(l.id(), l.geraetId(), l.urheber(), zeit(l.beginn()), zeit(l.ende()),
                l.weitereWechsel(), l.neustart(), l.zaehlerVorher(), l.zaehlerNachher());
    }

    /** Die Rohwerte in der Sprache des Bilds: Zustand mit Wort, Bitfeld mit gesetzten Bits; ein fremder Wert ohne Wort. */
    static List<ErzeugerVorgabenDto.Rohwert> rohwerte(Map<String, BigDecimal> roh) {
        List<ErzeugerVorgabenDto.Rohwert> out = new ArrayList<>();
        roh.forEach((punkt, wert) -> {
            ErzeugerRegisterbild.Feld feld = ErzeugerRegisterbild.feld(punkt).orElse(null);
            if (feld == null) {
                return;
            }
            long zahl = wert.longValue();
            String wort = null;
            String text = null;
            List<AnlagensteuerungDto.Bit> bits = null;
            if (!feld.vokabular().isEmpty()) {
                var w = ErzeugerRegisterbild.wort(feld, zahl);
                wort = w.map(ErzeugerRegisterbild.Wort::wort).orElse(null);
                text = w.map(ErzeugerRegisterbild.Wort::text).orElse(null);
            }
            if (!feld.bits().isEmpty()) {
                bits = ErzeugerRegisterbild.gesetzt(feld, zahl).stream()
                        .map(b -> new AnlagensteuerungDto.Bit(b.bit(), b.wort(), b.text())).toList();
            }
            out.add(new ErzeugerVorgabenDto.Rohwert(punkt, feld.feld(), ErzeugerRegisterbild.teNr(punkt).orElse(null),
                    wert, wort, text, bits));
        });
        return out;
    }

    // ------------------------------------------------------------------ Prüfen

    private Instant[] fenster(String von, String bis) {
        Instant b;
        Instant v;
        try {
            b = bis == null || bis.isBlank() ? uhr.instant() : OffsetDateTime.parse(bis).toInstant();
            v = von == null || von.isBlank() ? b.minus(Duration.ofDays(7)) : OffsetDateTime.parse(von).toInstant();
        } catch (DateTimeParseException e) {
            throw bad("von/bis brauchen einen ISO-Zeitpunkt mit Versatz, z. B. 2026-10-21T00:00:00+02:00.");
        }
        if (!b.isAfter(v)) {
            throw bad("bis liegt nicht nach von.");
        }
        if (Duration.between(v, b).compareTo(HOECHSTENS) > 0) {
            throw bad("Der Zeitraum ist höchstens " + HOECHSTENS.toDays() + " Tage lang.");
        }
        return new Instant[] {v, b};
    }

    private static void pruefe(LocalDate erster, LocalDate letzter, LocalDate spaetestens, String was, int zahl) {
        if (letzter.isBefore(erster)) {
            throw bad("bis liegt vor von.");
        }
        if (letzter.isAfter(spaetestens)) {
            throw bad("Höchstens " + zahl + " " + was + " je Abruf.");
        }
    }

    private static String urheber(String urheber) {
        if (urheber == null || urheber.isBlank()) {
            return null;
        }
        if (!VorgabenAbleitung.URHEBER.contains(urheber)) {
            throw bad("urheber ist eines von " + VorgabenAbleitung.URHEBER + ".");
        }
        return urheber;
    }

    private void sichtbar(UUID siteId) {
        if (!repo.anlageSichtbar(siteId)) {
            throw nichtGefunden("Anlage nicht gefunden.");
        }
    }

    private static Instant beginn(LocalDate tag) {
        return tag.atStartOfDay(VorgabenZaehlung.ZONE).toInstant();
    }

    static OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static ResponseStatusException nichtGefunden(String grund) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, grund);
    }

    private static ResponseStatusException bad(String grund) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, grund);
    }
}
