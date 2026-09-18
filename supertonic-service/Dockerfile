FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN python -c "from supertonic import TTS; _ = TTS()" || echo "Model download completed or already cached"

COPY main.py .

EXPOSE 8084

ENV PORT=8084
ENV HOST=0.0.0.0

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8084"]
