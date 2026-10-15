package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository;
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
        if (status.stream().anyMatch(s -> "never".equals(s.health()))) {
            return Lesung.zustand("never", fruehestesSeit(status, "never"));
        }
        if (status.stream().anyMatch(s -> "stale".equals(s.health()))) {
            return Lesung.zustand("stale", fruehestesSeit(status, "stale"));
        }
        Instant juengstesLesen = status.stream().map(Status::readAt).filter(java.util.Objects::nonNull)
                .max(Instant::compareTo).orElse(null);
        return Lesung.zustand("ok", juengstesLesen);
    }

    private static Instant fruehestesSeit(List<Status> status, String health) {
        return status.stream().filter(s -> health.equals(s.health())).map(Status::since)
                .filter(java.util.Objects::nonNull).min(Instant::compareTo).orElse(null);
    }
}
