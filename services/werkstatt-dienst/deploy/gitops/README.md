# gitops-Entwurf: Werkstatt-Dienst

Entwurf für das gitops-Repo, in dessen Form (`apps/<app>/base`, `apps/<app>/overlays/prod`, `clusters/prod`).
Er wird hier gepflegt und **von Hand** ins gitops-Repo übernommen; nur der Betreiber merged dort. Ablauf:
[Runbook, gitops](../../docs/runbook.md#gitops).

| Datei | Was |
|---|---|
| `apps/werkstatt/base/namespace.yaml` | `werkstatt-prod`, PodSecurity `restricted` (enforce, audit, warn) |
| `apps/werkstatt/base/deployment.yaml` | ein Replikat, `Recreate`, Benutzer 10001, Dateisystem nur lesbar, keine Capabilities, kein Token der Kubernetes-API; Proben `/health` und `/ready` |
| `apps/werkstatt/base/configmap.yaml` | Konfiguration; **Adresse der Brücke, age-Empfänger „Box-Passwörter“ und Schlüssel des Wartungsservers eintragen** |
| `apps/werkstatt/base/networkpolicy.yaml` | herein nur Proben und Metriken auf 8100; hinaus nur DNS, SSH zur Brücke (**gleiche Adresse eintragen**) und HTTPS ins Internet für die Fassungen einer Freigabe |
| `apps/werkstatt/base/pvc.yaml` | 2 GiB `local-path` für Protokolle und den Host-Schlüssel der Brücke |
| `apps/werkstatt/base/service.yaml` | nur die Betriebsseite 8100 |
| `apps/werkstatt/overlays/prod/kustomization.yaml` | Bild-Tag (**Commit setzen**), KSOPS-Generator |
| `apps/werkstatt/overlays/prod/werkstatt-dienst-geheim.sops.yaml.vorlage` | die vier privaten Schlüssel; einsetzen, mit `sops` verschlüsseln, als `….sops.yaml` einchecken |
| `apps/werkstatt/overlays/prod/werkstatt-dienst-oeffentlich.yaml` | öffentlicher Notfall-Schlüssel (**einsetzen**) |
| `clusters/prod/werkstatt-application.yaml` | Argo-CD-Application `werkstatt-prod`, Sync nur von Hand (**Repo-Adresse einsetzen**) |
| `clusters/prod/appproject-ziel.yaml` | Ausschnitt: Ziel `werkstatt-prod` im AppProject `prod` |

Nicht im gitops-Repo: die Freigabe (ConfigMap `werkstatt-freigabe`, legt der Betreiber mit `kubectl` an) und das
Pull-Secret der Registry (wie in `voltpilot-prod`).

Geprüft ohne Cluster: `kustomize build apps/werkstatt/base | kubeconform -strict` (7 Ressourcen gültig). Der
Overlay braucht KSOPS und das verschlüsselte Secret und baut erst im gitops-Repo.

Das Bild baut `.forgejo/workflows/werkstatt-dienst.yaml` (von Hand gestartet):
`git.tecmaxx.de/mamotec/voltpilot-ems/werkstatt-dienst:<commit>`. Der Tag-Bump der übrigen Dienste fasst es nicht an.
