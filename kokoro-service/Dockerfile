FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install the CPU build first. requirements.txt asks for torch>=2.0.0, which
# would otherwise resolve to the CUDA wheel; this service is CPU-only in the
# audio tier, and the CUDA build would add gigabytes for no use.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV HOST=0.0.0.0 \
    PORT=8081 \
    DEVICE=cpu

EXPOSE 8081

CMD ["python", "main.py"]
