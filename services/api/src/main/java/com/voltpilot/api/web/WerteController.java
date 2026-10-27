package com.voltpilot.api.web;

import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.CapabilityDto;
import com.voltpilot.api.topology.TopologyService.EntityTopologyDto;
import com.voltpilot.api.ueberwachung.AnlagenflussWerteLeser;
import com.voltpilot.api.ueberwachung.ErzeugerWerteLeser;
import com.voltpilot.api.ueberwachung.LadepunktWerteLeser;
import com.voltpilot.api.ueberwachung.WerteKatalog;
import com.voltpilot.api.ueberwachung.WerteLeser;
import com.voltpilot.api.web.dto.WertverweisDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Was lässt sich hier überwachen?" (Alerting Scheibe 2, Konzept §6.3): speist die Auswahl
 * "+ Überwachung" im Meldungs-Center und das Menü "..." an einem Wert. Keine eigene Rechte-Prüfung
 * - wie {@code MeldungenController} liest diese Route unter der normalen RLS-Sicht der Verbindung
 * (eine Anlage, die der Aufrufer nicht sieht, liefert über die zugrunde liegende Topologie keine
 * Werte, kein Fehler).
 *
 * <p>Zwei Quellen: die festen {@code anlagenfluss}-Einträge des Katalogs (Bezug {@code anlage}) und
 * die Familie {@code geraet.messwert} (Bezug {@code komponente}+{@code kanal}) - EIN Eintrag je
 * Messkanal jeder v2-Komponente der Anlage, aus derselben {@link TopologyService#topology(UUID)},
 * die auch "Anlage › Aufbau" zeigt (§6.1 Nr. 3 "dieselbe Zahl wie die Fläche"); ihr Live-Wert kommt
 * direkt aus der Topologie-Antwort, ohne zweiten Lesevorgang.
 *
 * <p>UEMS EZ-11: dazu die Alarm-Vorlagen der Leserart {@code erzeuger} - nur an einer Anlage mit Anlagensteuerung,
 * mit ihrem aktuellen Zustand (die Vorlage je Einheit hat an der Anlage keinen einzelnen Zustand).
 *
 * <p>"Ein Ort fürs Laden" Scheibe 4 (E6 = A): dazu die wählbaren Alarm-Vorlagen der Leserart {@code ladepunkt}
 * ({@code auto_angesteckt}, {@code ladung_fertig}) - nur an einer Anlage mit mindestens einem Ladepunkt. Die
 * zwei Meldungen ab Werk ({@code wallbox_meldet_sich_nicht}, {@code ziel_wird_knapp}) sind hier NICHT gelistet,
 * wie {@code box.erreichbar}/{@code datenquelle.liefert_daten} auch nicht: sie sind reine Vorschläge ab Werk
 * ({@link WerteKatalog#mitVorschlagAbWerk()}), nie über diese Auswahl manuell anlegbar.
 */
@RestController
@RequestMapping("/api/v1/werte")
public class WerteController {

    private final WerteKatalog katalog;
    private final AnlagenflussWerteLeser anlagenfluss;
    private final TopologyService topologie;
    private final Geltungsbereich geltungsbereich;
    private final LadepunktWerteLeser ladepunkt;
    private ErzeugerWerteLeser erzeuger;

    public WerteController(WerteKatalog katalog, AnlagenflussWerteLeser anlagenfluss, TopologyService topologie,
            Geltungsbereich geltungsbereich, LadepunktWerteLeser ladepunkt) {
        this.katalog = katalog;
        this.anlagenfluss = anlagenfluss;
        this.topologie = topologie;
        this.geltungsbereich = geltungsbereich;
        this.ladepunkt = ladepunkt;
    }

    @Autowired(required = false)
    void setErzeuger(ErzeugerWerteLeser erzeuger) {
        this.erzeuger = erzeuger;
    }

    @GetMapping
    public WertverweisDto.Liste werte(@RequestParam String bezug) {
        String[] teile = bezug.split(":", 2);
        if (teile.length != 2 || !"anlage".equals(teile[0])) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "nur bezug=anlage:<id> wird unterstützt");
        }
        UUID anlageId;
        try {
            anlageId = UUID.fromString(teile[1]);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "ungültige Anlage");
        }
        // Standort-Zaun: einige Felder (z.B. Preis über die Gebotszone) sind nicht über die
        // site_scope-gezäunte Topologie-Auflösung geschützt (AGENTS.md "die Messdaten selbst tragen
        // nur den Mandanten-Zaun") - diese Stelle prüft darum selbst, bevor sie überhaupt liest.
        geltungsbereich.requireSite(anlageId);
        List<WertverweisDto> werte = new ArrayList<>(anlagenflussWerte(anlageId));
        werte.addAll(messreiheWerte(anlageId));
        werte.addAll(erzeugerWerte(anlageId));
        werte.addAll(ladepunktWerte(anlageId));
        return new WertverweisDto.Liste(werte);
    }

    private List<WertverweisDto> anlagenflussWerte(UUID anlageId) {
        WerteLeser.Bezug leserBezug = WerteLeser.Bezug.anlage(anlageId);
        Instant jetzt = Instant.now();
        String bezugJson = "{\"anlage\":\"" + anlageId + "\"}";
        return katalog.alle().stream()
                .filter(e -> "anlagenfluss".equals(e.leser().art()))
                .map(e -> {
                    WerteLeser.Lesung l = anlagenfluss.lese(e, leserBezug, jetzt);
                    return new WertverweisDto(e.wertart(), e.name(), e.satzname(), e.bedingungen(), bezugJson,
                            l.bekannt(), l.zahlenwert(), l.zustandswort(), l.einheit());
                })
                .toList();
    }

    /** Die Erzeuger-Vorlagen (EZ-11) - nur, wo die Anlage eine Anlagensteuerung hat. */
    private List<WertverweisDto> erzeugerWerte(UUID anlageId) {
        if (erzeuger == null || !erzeuger.hatAnlagensteuerung(anlageId)) {
            return List.of();
        }
        WerteLeser.Bezug leserBezug = WerteLeser.Bezug.anlage(anlageId);
        Instant jetzt = Instant.now();
        String bezugJson = "{\"anlage\":\"" + anlageId + "\"}";
        return katalog.vorlagen().stream()
                .filter(e -> "erzeuger".equals(e.leser().art()))
                .map(e -> {
                    WerteLeser.Lesung l = erzeuger.jeEinheit(e) ? WerteLeser.Lesung.unbekannt()
                            : erzeuger.lese(e, leserBezug, jetzt);
                    return new WertverweisDto(e.wertart(), e.name(), e.satzname(), e.bedingungen(), bezugJson,
                            l.bekannt(), l.zahlenwert(), l.zustandswort(), l.einheit());
                })
                .toList();
    }

    /**
     * "Ein Ort fürs Laden" Scheibe 4 (E6 = A): die zwei wählbaren Ladepunkt-Vorlagen - nur, wo die Anlage
     * mindestens eine Ladesäule hat.
     */
    private List<WertverweisDto> ladepunktWerte(UUID anlageId) {
        if (!ladepunkt.hatLadepunkt(anlageId)) {
            return List.of();
        }
        WerteLeser.Bezug leserBezug = WerteLeser.Bezug.anlage(anlageId);
        Instant jetzt = Instant.now();
        String bezugJson = "{\"anlage\":\"" + anlageId + "\"}";
        return katalog.vorlagen().stream()
                .filter(e -> "ladepunkt".equals(e.leser().art()))
                .map(e -> {
                    WerteLeser.Lesung l = ladepunkt.lese(e, leserBezug, jetzt);
                    return new WertverweisDto(e.wertart(), e.name(), e.satzname(), e.bedingungen(), bezugJson,
                            l.bekannt(), l.zahlenwert(), l.zustandswort(), l.einheit());
                })
                .toList();
    }

    /** "Jeder gemessene Kanal im Aufbau" (§7 Scheibe 2 Punkt 2) - EIN Eintrag je Komponente+Kanal. */
    private List<WertverweisDto> messreiheWerte(UUID anlageId) {
        WerteKatalog.Eintrag familie = katalog.eintrag("geraet.messwert");
        if (familie == null) {
            return List.of();
        }
        TopologyService.TopologyResponse antwort = topologie.topology(anlageId);
        if (antwort == null || antwort.entities() == null) {
            return List.of();
        }
        List<WertverweisDto> werte = new ArrayList<>();
        for (EntityTopologyDto entity : antwort.entities()) {
            for (CapabilityDto cap : entity.capabilities()) {
                String bezugJson = "{\"komponente\":\"" + entity.id() + "\",\"kanal\":\"" + cap.channel() + "\"}";
                String name = (entity.label() != null ? entity.label() : entity.id().toString()) + " · " + cap.channel();
                werte.add(new WertverweisDto("geraet.messwert", name, familie.satzname(), familie.bedingungen(),
                        bezugJson, cap.value() != null, cap.value(), null, cap.unit()));
            }
        }
        return werte;
    }
}
