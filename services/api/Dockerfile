# syntax=docker/dockerfile:1
# ---- build ----
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app/services/api
COPY services/api/.mvn/ .mvn/
COPY services/api/mvnw services/api/pom.xml ./
RUN ./mvnw -B -q dependency:go-offline
COPY services/api/src/ src/
COPY catalog/measurement-points/dist/ /app/catalog/measurement-points/dist/
RUN ./mvnw -B -q clean package -DskipTests

# ---- run ----
FROM eclipse-temurin:21-jre AS run
WORKDIR /app
COPY --from=build /app/services/api/target/*.jar app.jar
EXPOSE 8090
ENTRYPOINT ["java", "-jar", "app.jar"]
