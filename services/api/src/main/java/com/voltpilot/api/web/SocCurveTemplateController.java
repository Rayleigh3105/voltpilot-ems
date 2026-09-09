package com.voltpilot.api.web;

import com.voltpilot.api.components.SocCurveTemplateCatalog;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die KURVEN-VORLAGEN der SoC-Ableitung, wie der Batterie-Assistent (P5d) sie
 * anbietet ({@code GET /api/v1/soc-curve-templates}).
 *
 * <p>Sie existiert, damit die Fläche die Stützpunkte einer Vorlage NICHT
 * nachbaut: eine Kennlinie im Portal wäre ein Zwilling von
 * {@code soccurves/catalog.json} und dürfte von ihm abdriften - und eine
 * abgedriftete Kennlinie ist ein falscher Ladestand mit Nachkommastellen. Der
 * Editor lädt die Punkte hier, zeigt sie an und schickt beim Speichern
 * entweder die Vorlagen-Kennung oder die vom Kunden GEÄNDERTEN Punkte zurück.
 *
 * <p>Bewusst eine kunden-förmige, authentifizierte und NICHT anlagenbezogene
 * Route - dasselbe Muster wie {@code GET /api/v1/component-templates}: eine
 * Vorlage ist eine Aussage über eine ZELLCHEMIE, nicht über eine Anlage. Es
 * gibt nichts zu mandanten-scopen.
 *
 * <p>Jede Vorlage trägt ihre {@code chemistry} und ihr Zellfenster sichtbar
 * mit, damit die Fläche sie NENNEN kann: dieselbe Spannung bedeutet an einer
 * LiFePO4-Zelle einen völlig anderen Ladestand als an einer NMC-Zelle.
 */
@RestController
@RequestMapping("/api/v1/soc-curve-templates")
public class SocCurveTemplateController {

    private final SocCurveTemplateCatalog curves;

    public SocCurveTemplateController(SocCurveTemplateCatalog curves) {
        this.curves = curves;
    }

    /**
     * Alle Vorlagen in Katalog-Reihenfolge.
     *
     * <p>Eine leere Liste kann es nicht geben - der Katalog lehnt sich beim
     * Start selbst ab, wenn er keine Vorlage trägt. Sie WÄCHST bewusst nur um
     * gemessene Tabellen: eine erfundene „LiFePO4 generisch"-Kurve wäre keine
     * Vorlage, sondern eine Falle mit Gütesiegel.
     */
    @GetMapping
    public List<SocCurveTemplateCatalog.Template> list() {
        return curves.all();
    }
}
