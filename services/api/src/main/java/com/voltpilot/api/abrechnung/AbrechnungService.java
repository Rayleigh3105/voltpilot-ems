package com.voltpilot.api.abrechnung;

import com.voltpilot.api.abrechnung.AbrechnungRegel.Ergebnis;
import com.voltpilot.api.abrechnung.AbrechnungRegel.Spanne;
import com.voltpilot.api.abrechnung.AbrechnungRegel.Stand;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.HistoryService;
import com.voltpilot.api.history.Zeitraum;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.stereotype.Service;

/**
 * „Abrechnung prüfen" (Bedienkonzept vp-privatkunde-bedienkonzept §7, Paket R2): Netzbezug und Einspeisung
 * eines Zeitraums mit Zählerständen, Herkunft, Lückentagen und Messbeginn - dazu die gespeicherten Zahlen
 * „laut Rechnung" (R3). Kein Urteil, kein Euro: die Antwort trägt Mengen; den Unterschied rechnet die
 * Oberfläche.
 */
@Service
public class AbrechnungService {

    private final AbrechnungRepository repo;
    private final HistoryService history;

    public AbrechnungService(AbrechnungRepository repo, HistoryService history) {
        this.repo = repo;
        this.history = history;
    }

    /** Eine Richtung der Antwort. */
    public record ZeileDto(BigDecimal mengeKwh, String herkunft, BigDecimal standVonKwh, BigDecimal standBisKwh,
            boolean zaehlerFaellt, long fehlendeTage, List<SpanneDto> luecken) {
    }

    /** Eine Spanne fehlender Tage, beide eingeschlossen. */
    public record SpanneDto(LocalDate von, LocalDate bis) {
    }

    /** Die gespeicherten Zahlen von der Rechnung. */
    public record PruefungDto(LocalDate von, LocalDate bis, BigDecimal bezugKwh, BigDecimal einspeisungKwh,
            Instant geaendertAm) {
    }

    /**
     * @param messbeginn       erster gemessener Tag der Anlage ({@code null} = noch nie)
     * @param tageVorMessbeginn Tage des Zeitraums vor dem Messbeginn (0, wenn er davor liegt)
     * @param einspeisung      {@code null}, wenn die Anlage im Zeitraum weder einspeist noch erzeugt und keinen
     *                         Einspeise-Zähler hat (Zustand „nur Netzbezug")
     * @param rechnung         die gespeicherte Prüfung dieses Zeitraums oder {@code null}
     */
    public record AbrechnungDto(LocalDate von, LocalDate bis, long tage, LocalDate messbeginn,
            long tageVorMessbeginn, ZeileDto bezug, ZeileDto einspeisung, PruefungDto rechnung) {
    }

    public AbrechnungDto abrechnung(UUID siteId, String biddingZone, Zeitraum z) {
        List<HistoryBucketDto> tage = history.tagesEimer(siteId, biddingZone, z);
        Map<String, Map<LocalDate, Stand>> staende = repo.zaehlerstaende(siteId, z);
        LocalDate messbeginn = repo.messbeginn(siteId);

        Map<LocalDate, BigDecimal> bezugJeTag = jeTag(tage, HistoryBucketDto::gridImportKwh);
        Map<LocalDate, BigDecimal> exportJeTag = jeTag(tage, HistoryBucketDto::gridExportKwh);
        Map<LocalDate, Stand> bezugStaende = staende.getOrDefault(AbrechnungRepository.KANAL_BEZUG, Map.of());
        Map<LocalDate, Stand> exportStaende =
                staende.getOrDefault(AbrechnungRepository.KANAL_EINSPEISUNG, Map.of());

        Ergebnis bezug = AbrechnungRegel.berechne(z, bezugStaende, bezugJeTag, messbeginn);
        Ergebnis einspeisung = AbrechnungRegel.berechne(z, exportStaende, exportJeTag, messbeginn);
        boolean zeigeEinspeisung = !exportStaende.isEmpty()
                || positiv(einspeisung.mengeKwh())
                || positiv(summe(tage, HistoryBucketDto::pvKwh));

        long vorher = messbeginn == null ? z.tage()
                : Math.max(0, Math.min(z.tage(), ChronoUnit.DAYS.between(z.von(), messbeginn)));
        AbrechnungRepository.Pruefung p = repo.lese(siteId, z.von(), z.bis());
        return new AbrechnungDto(z.von(), z.bis(), z.tage(), messbeginn, vorher, zeile(bezug),
                zeigeEinspeisung ? zeile(einspeisung) : null, p == null ? null : dto(p));
    }

    public List<PruefungDto> liste(UUID siteId) {
        return repo.liste(siteId).stream().map(AbrechnungService::dto).toList();
    }

    public PruefungDto lese(UUID siteId, Zeitraum z) {
        AbrechnungRepository.Pruefung p = repo.lese(siteId, z.von(), z.bis());
        return p == null ? null : dto(p);
    }

    /**
     * Schreibt die Zahlen des Zeitraums; sind beide leer, verschwindet die Prüfung (ein leeres Feld löscht).
     * {@code null} zurück = gelöscht.
     */
    public PruefungDto schreibe(UUID siteId, Zeitraum z, BigDecimal bezugKwh, BigDecimal einspeisungKwh,
            String urheber) {
        if (bezugKwh == null && einspeisungKwh == null) {
            repo.loesche(siteId, z.von(), z.bis());
            return null;
        }
        repo.schreibe(siteId, z.von(), z.bis(), bezugKwh, einspeisungKwh, urheber);
        return lese(siteId, z);
    }

    public boolean loesche(UUID siteId, Zeitraum z) {
        return repo.loesche(siteId, z.von(), z.bis());
    }

    private static PruefungDto dto(AbrechnungRepository.Pruefung p) {
        return new PruefungDto(p.von(), p.bis(), p.bezugKwh(), p.einspeisungKwh(), p.geaendertAm());
    }

    private static ZeileDto zeile(Ergebnis e) {
        return new ZeileDto(e.mengeKwh(), e.herkunft(), e.standVon(), e.standBis(), e.zaehlerFaellt(),
                e.fehlendeTage(), e.luecken().stream().map(AbrechnungService::spanne).toList());
    }

    private static SpanneDto spanne(Spanne s) {
        return new SpanneDto(s.von(), s.bis());
    }

    private static Map<LocalDate, BigDecimal> jeTag(List<HistoryBucketDto> tage,
            Function<HistoryBucketDto, BigDecimal> feld) {
        Map<LocalDate, BigDecimal> m = new HashMap<>();
        for (HistoryBucketDto b : tage) {
            BigDecimal v = feld.apply(b);
            if (v != null) {
                m.merge(b.start().atZone(HistoryRange.ZONE).toLocalDate(), v, BigDecimal::add);
            }
        }
        return m;
    }

    private static BigDecimal summe(List<HistoryBucketDto> tage, Function<HistoryBucketDto, BigDecimal> feld) {
        BigDecimal s = null;
        for (HistoryBucketDto b : tage) {
            BigDecimal v = feld.apply(b);
            if (v != null) {
                s = s == null ? v : s.add(v);
            }
        }
        return s;
    }

    private static boolean positiv(BigDecimal v) {
        return v != null && v.signum() > 0;
    }
}
