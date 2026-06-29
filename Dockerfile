# --- Stage 1: Build the React Frontend ---
FROM node:18-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Stage 2: Setup Python & Playwright ---
FROM python:3.10-slim AS backend-runner
WORKDIR /app

# Install system dependencies needed for Playwright/Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright and its system dependencies for chromium
RUN playwright install chromium
RUN playwright install-deps chromium

# Copy the built frontend from Stage 1
COPY --from=frontend-builder /app/dist ./dist

# Copy the rest of the application files
COPY . .

# Expose port (Render sets PORT env variable, we default to 3000)
EXPOSE 3000

# Start the server
CMD ["python", "server.py"]
