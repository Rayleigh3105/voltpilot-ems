#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root/services/api"
exec ./mvnw -q -DskipTests spring-boot:run \
  -Dspring-boot.run.main-class=com.voltpilot.api.measurement.BestandsboxBudgetPruefung
