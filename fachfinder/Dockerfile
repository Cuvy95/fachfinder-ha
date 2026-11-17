FROM python:3.12-slim
WORKDIR /app
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ .
# /data ist der persistente Speicher der App und landet automatisch im HA-Backup
ENV FACHFINDER_DB=/data/fachfinder.db \
    PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
