package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.DatenquelleRegeln;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Benannt;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Status;
import com.voltpilot.api.uems.ZustandAbleitung;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Der {@code zustand}-Leser (Alerting Scheibe 1, Konzept §6.3): liest abgeleitete Zustände -
 * Scheibe 1 kennt die Felder {@code box_erreichbar} (Befund 1: der Herzschlag, nicht die Ankunft
 * von Messdaten - dieselbe Grundlage wie {@link DeviceRepository#findAll()} und damit wie die
 * Live-Flächen) und {@code datenquelle_status} (Zustand je Datenquelle der Anlage).
 *
 * <p>UNBEKANNT IST KEINE NULL (§6.1 Nr. 4): eine Anlage ohne angenommene Box bzw. ohne je eine
 * Datenquellen-Meldung liefert {@link WerteLeser.Lesung#unbekannt()} - keine Schwellen-Bedingung
 * wertet das als erfüllt, und die Aussaat der Vorschläge ab Werk überspringt eine solche Anlage
 * ohnehin ("nur wo Gerät/Funktion existiert", §7 Scheibe 1 Punkt 7).
 *
 * <p>Der Satz zu {@code datenquelle_status} nennt das GERÄT (Konzept „Ein Gerät, ein Eintrag“, GE-6): „Anlage
 * Gore: Anlagensteuerung liefert keine Daten — nicht erreichbar (Kennung DQ-1).“ Den Bezug behält die Regel —
 * die Anlage; welches Gerät hinter einem Weg steht, sagt allein {@code geraet.data_source_id}.
 */
@Component
public class ZustandWerteLeser implements WerteLeser {

    static final String FELD_BOX_ERREICHBAR = "box_erreichbar";
    static final String FELD_DATENQUELLE_STATUS = "datenquelle_status";

    public static final String ERREICHBAR = "erreichbar";
    public static final String NICHT_ERREICHBAR = "nicht_erreichbar";

    private final DeviceRepository geraete;
    private final DeviceDataSourceStatusRepository datenquellen;

    public ZustandWerteLeser(DeviceRepository geraete, DeviceDataSourceStatusRepository datenquellen) {
        this.geraete = geraete;
        this.datenquellen = datenquellen;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        String feld = eintrag.leser().feld();
        if (FELD_BOX_ERREICHBAR.equals(feld)) {
            return boxErreichbar(bezug.id(), jetzt);
        }
        if (FELD_DATENQUELLE_STATUS.equals(feld)) {
            return datenquelleStatus(bezug.id());
        }
        throw new IllegalArgumentException("ZustandWerteLeser: unbekanntes Feld '" + feld + "'");
    }

    /** Hat die Anlage mindestens eine angenommene Box mit einem Herzschlag? */
    public boolean hatAngenommeneBox(java.util.UUID anlageId) {
        return !claimedDevices(anlageId).isEmpty();
    }

    private List<DeviceDto> claimedDevices(java.util.UUID anlageId) {
        return geraete.findAll().stream()
                .filter(d -> anlageId.equals(d.siteId()) && "claimed".equals(d.status()))
                .toList();
    }

    private Lesung boxErreichbar(java.util.UUID anlageId, Instant jetzt) {
        List<DeviceDto> devices = claimedDevices(anlageId);
        if (devices.isEmpty()) {
            return Lesung.unbekannt();
        }
        Instant schlechtester = null;
        for (DeviceDto d : devices) {
            // Eine Box, die noch nie einen Eingang hatte, wartet auf die ersten Daten - das ist
            // nicht "nicht erreichbar" (Befund 1, §3.1): unbekannt bleibt unbekannt.
            if (d.lastSeenAt() == null) {
                return Lesung.unbekannt();
            }
            if (schlechtester == null || d.lastSeenAt().isBefore(schlechtester)) {
                schlechtester = d.lastSeenAt();
            }
        }
        boolean erreichbar = jetzt.getEpochSecond() - schlechtester.getEpochSecond()
                <= ZustandAbleitung.TOLERANZ_MINDESTENS_S;
        return Lesung.zustand(erreichbar ? ERREICHBAR : NICHT_ERREICHBAR, schlechtester);
    }

    private Lesung datenquelleStatus(java.util.UUID anlageId) {
        List<Status> status = datenquellen.findForSite(anlageId);
        if (status.isEmpty()) {
            return Lesung.unbekannt();
        }
        String satz = satz(datenquellen.benanntFuerSite(anlageId));
        if (status.stream().anyMatch(s -> "never".equals(s.health()))) {
            return Lesung.zustand("never", fruehestesSeit(status, "never"), satz);
        }
        if (status.stream().anyMatch(s -> "stale".equals(s.health()))) {
            return Lesung.zustand("stale", fruehestesSeit(status, "stale"), satz);
        }
        Instant juengstesLesen = status.stream().map(Status::readAt).filter(java.util.Objects::nonNull)
                .max(Instant::compareTo).orElse(null);
        return Lesung.zustand("ok", juengstesLesen, satz);
    }

    /**
     * Der Satz der Meldung: je Weg, der nicht liefert, sein Gerät mit Grund und Kennung; liefern alle, die
     * Geräte, die liefern. {@code null} ohne Zeile (dann bleibt der Satz der Regel).
     */
    static String satz(List<Benannt> wege) {
        List<Benannt> stumm = wege.stream().filter(w -> !"ok".equals(w.health())).toList();
        if (!stumm.isEmpty()) {
            return String.join("; ", stumm.stream().map(w -> {
                String grund = DatenquelleRegeln.fehlerklasse(w.errorClass(), DatenquelleRegeln.Herkunft.BOX)
                        .map(DatenquelleRegeln.Fehlerklasse::kundenwort).orElse(null);
                return wer(w) + ("never".equals(w.health()) ? " liefert noch keine Daten" : " liefert keine Daten")
                        + (grund == null ? "" : " — " + grund) + " (Kennung " + w.kennzeichen() + ")";
            }).toList()) + ".";
        }
        List<String> alle = wege.stream().map(ZustandWerteLeser::wer).distinct().toList();
        if (alle.isEmpty()) {
            return null;
        }
        return aufzaehlung(alle) + (alle.size() == 1 ? " liefert Daten." : " liefern Daten.");
    }

    /** Ein Gerät heißt wie das Gerät; ein Weg ohne Gerät ist ein Anschluss, einer mit mehreren ein Gateway. */
    private static String wer(Benannt w) {
        String weg = w.name() != null && !w.name().isBlank() ? w.name() : w.kennzeichen();
        if (w.geraete().size() == 1) {
            return w.geraete().getFirst();
        }
        return w.geraete().isEmpty() ? "Anschluss " + weg : "Gateway " + weg + " (" + w.geraete().size() + " Geräte)";
    }

    private static String aufzaehlung(List<String> teile) {
        if (teile.size() == 1) {
            return teile.getFirst();
        }
        return String.join(", ", teile.subList(0, teile.size() - 1)) + " und " + teile.getLast();
    }

    private static Instant fruehestesSeit(List<Status> status, String health) {
        return status.stream().filter(s -> health.equals(s.health())).map(Status::since)
                .filter(java.util.Objects::nonNull).min(Instant::compareTo).orElse(null);
    }
}
