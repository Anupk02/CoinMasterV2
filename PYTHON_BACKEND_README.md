# 🐍 CoinMarketCap Automated Posting Bot — Python Backend

Welcome! As requested, this file contains complete documentation and instructions for running the fully-functional **Python Backend** for your CoinMarketCap Automated Posting Bot.

We have built a pristine, modern **FastAPI** + **Playwright Python** backend in `server.py` that mirrors the TypeScript Express server exactly. You can download or export this project and run the Python backend on your local machine with zero friction.

---

## 🛠️ Prerequisites & Installation

To run the Python backend, ensure you have Python 3.8+ installed on your computer.

### 1. Install Required Python Packages
Open your terminal inside the project directory and run the following command to install all the required backend dependencies:

```bash
pip install fastapi uvicorn playwright requests google-genai openai pydantic
```

### 2. Install Playwright Web Browsers
Playwright requires its dedicated, stealthy headless browser binaries to navigate CoinMarketCap. Run this command to fetch them:

```bash
playwright install chromium
```

---

## 🚀 Running the Python Backend

Start the FastAPI backend server using `uvicorn`. Run this command:

```bash
python server.py
```

The server will spin up and listen on **`http://localhost:3000`** with live reloading, matching the routing expectations of your React frontend perfectly.

### Accessing Interactive API Docs
FastAPI automatically generates beautiful interactive Swagger documentation! Once the server is running, you can view, test, and play with all endpoints directly from your browser:
- Swagger UI: **`http://localhost:3000/docs`**
- Redoc UI: **`http://localhost:3000/redoc`**

---

## 🎨 Connecting with the React Frontend

The React frontend handles interaction, configurations, session loading, logs, and automation controls. 

When running locally:
1. **Start the React Frontend** using Vite:
   ```bash
   npm run dev
   ```
2. **Start the Python Backend** as shown above:
   ```bash
   python server.py
   ```
The frontend is already configured to communicate seamlessly with `http://localhost:3000/api/*` endpoints handled by either the Python or TypeScript servers!

---

## 📝 Implemented Endpoints & Features

The Python backend implements every feature of the bot queue:
- **`GET /api/status`**: Returns current bot queue progress, active counts, and API key statuses.
- **`POST /api/fetch-trending`**: Fetches the top 50 trending coins from public CoinMarketCap endpoints (with fallbacks to CoinGecko and simulated data).
- **`POST /api/generate-messages`**: Uses either the **Gemini API** (`google-genai` SDK) or **OpenAI API** (`openai` SDK) to generate organic-looking community comments.
- **`POST /api/post-chat`**: Launches a background posting daemon inside FastAPI using async task loops.
- **`POST /api/stop-posting` & `/api/skip-coin`**: Control loop flow state on demand.
- **`POST /api/check-login`**: Verifies if your browser cookies inside `auth/state.json` are active and valid.
- **`GET /api/download/*`**: Exports CSV reports of trending coins, duplicate URLs, symbols, or coin names.
