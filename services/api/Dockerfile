# syntax=docker/dockerfile:1
# ---- build ----
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app/services/api
COPY services/api/.mvn/ .mvn/
COPY services/api/mvnw services/api/pom.xml ./
RUN ./mvnw -B -q dependency:go-offline
COPY services/api/src/ src/
COPY catalog/measurement-points/dist/ /app/catalog/measurement-points/dist/
# Die Rechte-Matrix für /api/v1/me (UEMS AP-03 IP-4) - pom.xml legt sie ins Jar.
COPY docs/contracts/v2/rechte-matrix.json /app/docs/contracts/v2/rechte-matrix.json
COPY docs/contracts/v2/edge-capabilities.json /app/docs/contracts/v2/edge-capabilities.json
COPY docs/contracts/v2/measurement-budget-vectors.json /app/docs/contracts/v2/measurement-budget-vectors.json
RUN ./mvnw -B -q clean package -DskipTests

# ---- run ----
FROM eclipse-temurin:21-jre AS run
WORKDIR /app
COPY --from=build /app/services/api/target/*.jar app.jar
EXPOSE 8090
ENTRYPOINT ["java", "-jar", "app.jar"]
