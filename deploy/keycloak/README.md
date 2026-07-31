# VoltPilot-Keycloak-Image

Das projekteigene Keycloak-Image: **Realm-Import + Login-Theme sind eingebacken**, die Quarkus-Augmentierung (`kc.sh build`) ist vorab gelaufen.

- Dockerfile: [`Dockerfile`](Dockerfile) — **Build-Kontext ist das Repo-Root**
- Image-Name: `git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:{latest|<commit-sha>}`
- Gebaut von der Build-Matrix beider Forgejo-Workflows (`.forgejo/workflows/deploy.yaml`, `.forgejo/workflows/deploy-fast.yaml`) — Eintrag `keycloak`

## Warum

Compose bindet beide Artefakte heute als Volumes ein (`docker-compose.prod.yml`, Service `keycloak`):

| Artefakt | Quelle im Repo | Ziel im Image |
|---|---|---|
| Produktions-Realm | `infra/prod/keycloak/voltpilot-realm.json` | `/opt/keycloak/data/import/voltpilot-realm.json` |
| Login-Theme | `deploy/keycloak/themes/voltpilot/` | `/opt/keycloak/themes/voltpilot/` |

Im Kubernetes-Cluster geht das so nicht: das Theme sind acht Dateien über verschachtelte Verzeichnisse (eine ConfigMap ist dafür das falsche Werkzeug), und weil es die kundensichtbare Anmeldeseite ist, ist „ohne Theme" keine Option. Das k8s-Deployment zieht deshalb dieses Image — siehe `apps/voltpilot/base/keycloak/deployment.yaml` im GitOps-Repo.

Nebeneffekt, der einen echten Betriebs-Hack beseitigt: im `start`-Modus legt Keycloak beim Boot einen Theme- **und** einen Gzip-Cache auf dem Container-Dateisystem an, der einen einfachen `restart` ÜBERLEBT — ein geändertes Bind-Mount-Theme lieferte gzip-fähigen Browsern also weiterhin das alte CSS. Genau dagegen steht das `up -d --force-recreate keycloak` im Deploy-Workflow. Ein unveränderliches Image wird ersetzt statt an Ort und Stelle neu gestartet, der Cache kann gegen sein eigenes Theme also gar nicht mehr veralten.

## Was eingebacken ist — und was ausdrücklich nicht

**Eingebacken** (Keycloak-BUILD-Optionen, von `kc.sh build` im Image verewigt):

    KC_DB=postgres   KC_HEALTH_ENABLED=true   KC_HTTP_RELATIVE_PATH=/auth

Sie müssen zu dem passen, was die Laufzeit liefert (Compose-Service `keycloak` bzw. `keycloak.env` im GitOps-Repo), sonst verweigert ein `start --optimized` den Start.

**Nicht eingebacken** — alles Host- oder Geheimnis-spezifische bleibt Laufzeitwert: `KC_DB_URL` / `KC_DB_USERNAME` / `KC_DB_PASSWORD`, `KC_HOSTNAME`, `KC_PROXY_HEADERS`, `KC_BOOTSTRAP_ADMIN_*` sowie die `VP_*`-Platzhalter, die Keycloak beim Import in den Realm einsetzt (`VP_PUBLIC_ORIGIN`, `VP_API_CLIENT_SECRET`, `VP_PORTAL_ADMIN_PASSWORD` — siehe [`infra/prod/keycloak/README.md`](../../infra/prod/keycloak/README.md)). **Es liegt kein Geheimnis im Image.**

## Version

`ARG KEYCLOAK_VERSION` im Dockerfile ist auf dieselbe Version gepinnt wie der `keycloak`-Service in `docker-compose.prod.yml` (heute `26.0.5`). **Beide zusammen anheben**, sonst laufen Compose-Deployment und Cluster-Deployment auf verschiedenen Keycloak-Versionen gegen dieselbe Datenbank.

## Lokal bauen

Der Kontext ist das Repo-Root (die zwei Eingaben liegen in verschiedenen Verzeichnissen), das Dockerfile wird explizit angegeben — dasselbe Muster wie `services/optimization/Dockerfile`:

```bash
docker build -f deploy/keycloak/Dockerfile \
  -t git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:latest .
```

(Wie beim Optimizer-Image geht dabei das ganze Repo als Kontext an den Daemon. Auf dem CI-Runner ist das ein frischer Checkout und damit klein; in einem lang benutzten Arbeitsverzeichnis liegen `node_modules/`, `target/` und `.venv/` mit drin, der erste lokale Build dauert entsprechend.)

Der `keycloak`-Service in `docker-compose.prod.yml` trägt **bewusst keinen `build:`-Block** (anders als die App-Dienste): sein `image:` zeigt standardmäßig auf das Upstream-Image, und ein `docker compose build` würde den lokalen Build unter dem Upstream-Namen `quay.io/keycloak/keycloak:26.0.5` taggen und damit das echte Upstream-Image auf der Maschine verschatten.

## Compose auf dieses Image umstellen (optional, additiv)

Der Standard bleibt unverändert das Upstream-Image, das heutige Verhalten ändert sich also durch diesen Zusatz nicht. Zum Umstellen in `/srv/docker/voltpilot/.env`:

```ini
KEYCLOAK_IMAGE=git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:latest
```

Danach `docker compose -f docker-compose.prod.yml up -d keycloak`.

Zwei Dinge, die man dabei wissen muss:

1. **Die Bind-Mounts können bleiben.** Sie überlagern die eingebackenen Dateien mit byte-identischem Inhalt (beide stammen aus demselben Commit). Sobald der Umzug steht, sind sie überflüssig und dürfen aus dem Compose-Service verschwinden.
2. **`KEYCLOAK_IMAGE` wird NICHT automatisch auf `${IMAGE_TAG}` gepinnt.** Der Deploy-Workflow schreibt `IMAGE_TAG=<sha>` in die `.env`; `KEYCLOAK_IMAGE` ist ein eigener, vollständiger Image-Verweis. Wer eine feste SHA will, trägt sie dort wörtlich ein. (Compose bleibt der Alt-Pfad — im Cluster pinnt Kustomize den Tag.)

Der Compose-Befehl bleibt in beiden Fällen `start --import-realm` (ohne `--optimized`) und ist mit diesem Image weiterhin korrekt: die Build-Optionen sind identisch, Keycloak augmentiert also nicht neu. Das k8s-Deployment startet mit `start --optimized --import-realm` — das ist auch das `CMD` des Images.
