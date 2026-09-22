# Das Anlagenmodell als Prozess (uems_verbund.py) - nur Python-Standardbibliothek.
# Gebaut von verbund.sh mit der Referenzdatei als zweitem Kontext:
#   docker build --build-context referenz=docs/contracts/v2 -t vb-anlage:<sha> tools/uems-verbund-sim
FROM python:3.12-alpine
WORKDIR /app
COPY uems_verbund.py /app/uems_verbund.py
COPY --from=referenz uems-referenzunternehmen.json /app/uems-referenzunternehmen.json
EXPOSE 502
ENTRYPOINT ["python3", "-u", "/app/uems_verbund.py"]
CMD ["anlage"]
